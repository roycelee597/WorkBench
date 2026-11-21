import {
  DATA_NOTICE,
  type AiContext,
  type DataPayload,
  type AiTarget,
  type Prepared,
  type RefTable,
  type ResultItem,
} from "./action-types";
import {
  aiError,
  aiErrorMessages,
  AiClientError,
  DEFAULT_AI_MODEL,
  llmResponseSchema,
  type AiErrorCode,
  type AiModel,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "./llm-client";
import { buildSystemPrompt } from "./prompt";
import type { AiRegistry } from "./registry";
import {
  DEFAULT_AI_STEPS,
  HARD_AI_STEPS,
  MAX_AI_MESSAGES,
  MAX_AI_REQUEST_BYTES,
  MAX_READ_CHARS,
  MAX_READ_ITEMS,
} from "./limits";

type Message = LlmRequest["messages"][number];
type Assistant = Extract<Message, { role: "assistant" }>;
type WireCall = NonNullable<Assistant["tool_calls"]>[number];
const HISTORY_MS = 30 * 60 * 1000;
const MAX_TOOLS = 5;
const CARD_RETRY =
  "如果用户要求新建、修改或删除，必须调用对应写入工具生成卡片；如果只是回答问题，直接回答，不要声称已写入。";

export interface ConversationTurn {
  createdAt: number;
  user: string;
  text: string;
  exchanges: Message[];
  readDerived: boolean;
}

export type OrchestratorEvent =
  | { type: "text"; text: string }
  | {
      type: "error";
      message: string;
      code?: AiErrorCode;
      fallback?: "manual" | "settings";
      target?: AiTarget;
    }
  | { type: "status"; message: string }
  | { type: "warning"; message: string }
  | { type: "prepared"; actionName: string; prepared: Prepared<unknown> }
  | { type: "results"; items: ResultItem[]; empty: string };

export interface OrchestrationResult {
  events: OrchestratorEvent[];
  turn: ConversationTurn;
}
export interface OrchestratorPorts {
  client: LlmClient;
  registry: AiRegistry;
  refs: RefTable;
  now?: () => number;
  timezone?: () => string;
}
export interface RunOptions {
  text: string;
  history?: readonly ConversationTurn[];
  model?: AiModel;
  onEvent?: (event: OrchestratorEvent) => void;
  readEnabled?: boolean;
  isReadAllowed?: () => boolean;
  stepLimitEnabled?: boolean;
}

class InvalidData extends Error {}
const invalidData = () => new InvalidData("工作台返回了无效的读取结果，请重试或手动查看");
const localWhen = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value);
const optionalText = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw invalidData();
  return value;
};

/** 只把协议允许的数据字段送回模型，本地跳转目标、草稿与备注不进入这里。 */
function modelPayload(payload: DataPayload, refs: RefTable): DataPayload {
  if (
    payload.type !== "workbench_data" ||
    !payload.range ||
    typeof payload.range.from !== "string" ||
    typeof payload.range.to !== "string" ||
    payload.range.from.length > 64 ||
    payload.range.to.length > 64 ||
    !Number.isSafeInteger(payload.total) ||
    payload.total < 0 ||
    typeof payload.truncated !== "boolean" ||
    !Array.isArray(payload.items) ||
    payload.total < payload.items.length
  )
    throw invalidData();
  const items: DataPayload["items"] = [];
  for (const raw of payload.items.slice(0, MAX_READ_ITEMS)) {
    const ref = raw.ref;
    if (typeof ref !== "string" || !/^[er][1-9]\d*$/.test(ref) || typeof raw.title !== "string")
      throw invalidData();
    const kind = ref.startsWith("e") ? "event" : "reminder";
    if (!refs.resolve(ref, kind)) throw invalidData();
    const title = Array.from(raw.title);
    const base = { ref, title: title.length > 60 ? `${title.slice(0, 59).join("")}…` : raw.title };
    if (kind === "event") {
      if (!localWhen(raw.start) || !localWhen(raw.end) || typeof raw.all_day !== "boolean")
        throw invalidData();
      items.push({
        ...base,
        start: raw.start,
        end: raw.end,
        all_day: raw.all_day,
        repeat: optionalText(raw.repeat, 300),
        remind: optionalText(raw.remind, 60),
      });
    } else {
      if (
        !(raw.due === null || localWhen(raw.due)) ||
        typeof raw.completed !== "boolean" ||
        !["无", "低", "中", "高"].includes(String(raw.priority)) ||
        !["普通", "日程生成", "金融"].includes(String(raw.origin))
      )
        throw invalidData();
      items.push({
        ...base,
        due: raw.due,
        repeat: optionalText(raw.repeat, 300),
        priority: raw.priority!,
        completed: raw.completed,
        origin: raw.origin!,
      });
    }
  }
  const result: DataPayload = {
    type: "workbench_data",
    notice: DATA_NOTICE,
    range: { from: payload.range.from, to: payload.range.to },
    total: payload.total,
    truncated: payload.truncated || payload.items.length > items.length,
    items,
  };
  while (JSON.stringify(result).length > MAX_READ_CHARS && result.items.length) {
    result.items.pop();
    result.truncated = true;
  }
  if (JSON.stringify(result).length > MAX_READ_CHARS) throw invalidData();
  return result;
}

const wireCall = (call: { id: string; name: string; arguments: string }): WireCall => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: call.arguments },
});

function fitRequest(request: LlmRequest): LlmRequest {
  const messages = [...request.messages];
  const encoder = new TextEncoder();
  const size = () => encoder.encode(JSON.stringify({ ...request, messages })).length;
  // 先移除最旧的整组读取交换，保留角色顺序及每个 tool_call_id 的配对。
  while (messages.length > MAX_AI_MESSAGES || size() > MAX_AI_REQUEST_BYTES - 4096) {
    const start = messages.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    if (start < 0) throw new AiClientError("TOO_LARGE");
    let end = start + 1;
    while (messages[end]?.role === "tool") end++;
    messages.splice(start, end - start);
  }
  return { ...request, messages };
}

function visibleRefs(messages: readonly Message[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.role === "tool"
        ? (JSON.parse(message.content) as DataPayload).items.map((item) => String(item.ref))
        : [],
    ),
  );
}

export class AiOrchestrator {
  private busy = false;
  private readGeneration = 0;
  constructor(private readonly ports: OrchestratorPorts) {}

  invalidateRead() {
    this.readGeneration++;
    this.ports.refs.clear();
  }

  private historyMessages(
    history: readonly ConversationTurn[],
    now: number,
    readEnabled: boolean,
  ): Message[] {
    const recent = history.filter(
      (turn) =>
        Number.isFinite(turn.createdAt) &&
        turn.createdAt <= now &&
        now - turn.createdAt < HISTORY_MS,
    );
    const texts = recent
      .flatMap((turn) => [
        { turn, role: "user" as const, content: turn.user },
        {
          turn,
          role: "assistant" as const,
          content:
            !readEnabled && turn.readDerived ? "（已关闭读取，之前的数据回复未发送）" : turn.text,
        },
      ])
      .filter((item) => typeof item.content === "string" && item.content.length > 0)
      .slice(-6);
    const previous = recent.at(-1);
    const messages: Message[] = [];
    for (const text of texts) {
      messages.push({ role: text.role, content: text.content.slice(0, 8000) });
      if (readEnabled && text.role === "user" && text.turn === previous)
        messages.push(...this.historyExchanges(previous.exchanges));
    }
    return messages;
  }

  private historyExchanges(exchanges: readonly Message[]): Message[] {
    const result: Message[] = [];
    // 历史只接受配对且仍获准的读取调用；不回传任何旧的写入调用或卡片草稿。
    for (let i = 0; i < exchanges.length; i++) {
      const assistant = exchanges[i];
      if (assistant?.role !== "assistant" || !assistant.tool_calls?.length) continue;
      const calls: WireCall[] = [];
      const outputs: Message[] = [];
      for (const call of assistant.tool_calls.slice(0, MAX_TOOLS)) {
        const action = this.ports.registry.get(call.function.name);
        if (!action || action.kind !== "read") continue;
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments) as unknown;
        } catch {
          continue;
        }
        if (!action.args.safeParse(args).success) continue;
        let end = i + 1;
        while (exchanges[end]?.role === "tool") end++;
        const output = exchanges
          .slice(i + 1, end)
          .find((item) => item.role === "tool" && item.tool_call_id === call.id);
        if (!output || output.role !== "tool") continue;
        try {
          const payload = modelPayload(JSON.parse(output.content) as DataPayload, this.ports.refs);
          calls.push(call);
          outputs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(payload) });
        } catch {
          /* 过期引用或非法历史数据不再发送。 */
        }
      }
      if (calls.length)
        result.push({ role: "assistant", content: null, tool_calls: calls }, ...outputs);
    }
    return result;
  }

  async run(options: RunOptions): Promise<OrchestrationResult> {
    const now = (this.ports.now ?? Date.now)();
    const events: OrchestratorEvent[] = [];
    const summaries: string[] = [];
    const readResults: Extract<OrchestratorEvent, { type: "results" }>[] = [];
    const turn: ConversationTurn = {
      createdAt: now,
      user: options.text.trim(),
      text: "",
      exchanges: [],
      readDerived: false,
    };
    const emit = (event: OrchestratorEvent) => {
      events.push(event);
      options.onEvent?.(event);
    };
    const complete = () => {
      turn.text = summaries.join("\n");
      for (const result of readResults.splice(0)) emit(result);
      return { events, turn };
    };
    const fail = (
      message: string,
      fallback: "manual" | "settings" = "manual",
      code?: AiErrorCode,
      target?: AiTarget,
    ) => {
      emit({
        type: "error",
        message,
        fallback,
        ...(code ? { code } : {}),
        ...(target ? { target } : {}),
      });
      summaries.push("（本轮未能完成，请重新说明或手动操作）");
    };
    const showPrepared = (actionName: string, prepared: Prepared<unknown>) => {
      if (prepared.type === "error") {
        fail(prepared.message, prepared.fallback, undefined, prepared.target);
        return;
      }
      emit({ type: "prepared", actionName, prepared });
      summaries.push("（已生成 1 张操作卡片，尚未写入）");
    };
    if (this.busy) {
      fail("上一句还在处理，请稍后再试", "manual", "BUSY");
      return complete();
    }
    if (!turn.user || Array.from(turn.user).length > 1000) {
      fail("请输入 1–1000 字的内容", "manual", "TOO_LARGE");
      return complete();
    }
    this.busy = true;
    const readEnabled = options.readEnabled !== false && (options.isReadAllowed?.() ?? true);
    const generation = this.readGeneration;
    const interrupted = () =>
      readEnabled && (this.readGeneration !== generation || options.isReadAllowed?.() === false);
    const stopReading = () => {
      this.ports.refs.clear();
      readResults.length = 0;
      turn.exchanges = [];
      summaries.length = 0;
      turn.readDerived = true;
      fail("你已关闭 AI 读取日程和提醒，可在设置里打开", "settings");
      return complete();
    };
    try {
      if (!readEnabled) this.ports.refs.clear();
      const tools = this.ports.registry.tools({ allowRead: readEnabled });
      const writers = tools.flatMap(({ function: { name } }) => {
        const action = this.ports.registry.get(name);
        return action?.kind === "write" ? [action] : [];
      });
      const writeTools = writers.map((action) => action.name);
      const recoverable = writers.filter((action) => action.requiresRead && action.recoverFromRead);
      const timezone = (
        this.ports.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
      )();
      const messages: Message[] = [
        {
          role: "system",
          content:
            buildSystemPrompt({ now, timezone, tools }) +
            (readEnabled
              ? ""
              : "\n用户已关闭 AI 读取日程和提醒。查询、修改或删除时提示可在设置里打开。新建仍可用。"),
        },
        ...this.historyMessages(options.history ?? [], now, readEnabled),
        { role: "user", content: turn.user },
      ];
      turn.readDerived =
        readEnabled &&
        (options.history ?? []).some(
          (item) => item.readDerived && now >= item.createdAt && now - item.createdAt < HISTORY_MS,
        );
      const stepLimit = options.stepLimitEnabled === false ? HARD_AI_STEPS : DEFAULT_AI_STEPS;
      let retriedCard = false;
      for (let step = 0; step < stepLimit; step++) {
        if (interrupted()) return stopReading();
        if (step === 0) emit({ type: "status", message: "正在理解…" });
        const request = fitRequest({ model: options.model ?? DEFAULT_AI_MODEL, messages, tools });
        const sentRefs = visibleRefs(request.messages);
        if (interrupted()) return stopReading();
        let response: LlmResponse;
        try {
          response = await this.ports.client.chat(structuredClone(request), { writeTools });
        } catch (error) {
          if (interrupted()) return stopReading();
          if (aiError(error).code !== "CARD_REQUIRED") throw error;
          if (retriedCard || step === stepLimit - 1) {
            fail(aiErrorMessages.CARD_REQUIRED, "manual", "CARD_REQUIRED");
            return complete();
          }
          retriedCard = true;
          // 不转发被拦截的回复；纠正消息只在本轮使用，也占一个模型步数。
          messages.push({ role: "user", content: CARD_RETRY });
          continue;
        }
        if (interrupted()) return stopReading();
        const parsed = llmResponseSchema.safeParse(response);
        if (!parsed.success) throw new AiClientError("BAD_RESPONSE");
        const reply = parsed.data;
        const calls = reply.tool_calls.slice(0, MAX_TOOLS);
        const refs = this.ports.refs;
        const readItems = readResults.flatMap((result) =>
          result.items.filter((item) => sentRefs.has(item.id)),
        );
        const context: AiContext = { now, timezone, refs, userText: turn.user };
        const writeContext: AiContext = {
          ...context,
          readItems,
          refs: {
            issue: () => {
              throw invalidData();
            },
            resolve: (ref, kind) => (sentRefs.has(ref) ? refs.resolve(ref, kind) : null),
            clear: () => {
              throw invalidData();
            },
          },
        };
        if (!calls.length) {
          for (const action of recoverable) {
            const recovered = await action.recoverFromRead?.(readItems, writeContext);
            if (interrupted()) return stopReading();
            if (!recovered) continue;
            turn.readDerived = true;
            showPrepared(action.name, recovered);
            return complete();
          }
        }
        const textOnly = calls.length === 0 && Boolean(reply.content?.trim());
        if (retriedCard && !textOnly && !calls.some((call) => writeTools.includes(call.name))) {
          fail(aiErrorMessages.CARD_REQUIRED, "manual", "CARD_REQUIRED");
          return complete();
        }
        if (reply.content && (!retriedCard || textOnly)) {
          emit({ type: "text", text: reply.content });
          summaries.push(reply.content);
        }
        if (!calls.length) return complete();
        if (reply.tool_calls.length > MAX_TOOLS)
          emit({ type: "warning", message: "AI 返回的操作过多，本次只处理前 5 个操作" });
        const hasWrite = calls.some((call) => this.ports.registry.get(call.name)?.kind === "write");
        const completedCalls: WireCall[] = [];
        const toolMessages: Message[] = [];
        let invalid = false;
        for (const call of calls) {
          const action = this.ports.registry.get(call.name);
          if (!action) {
            fail("AI 返回了无法识别的操作");
            invalid = true;
            break;
          }
          if (interrupted()) return stopReading();
          if (!readEnabled && (action.kind === "read" || action.requiresRead)) {
            fail("你已关闭 AI 读取日程和提醒，可在设置里打开", "settings");
            invalid = true;
            break;
          }
          let value: unknown;
          try {
            value = JSON.parse(call.arguments) as unknown;
          } catch {
            fail("AI 没能理解这句话，换个说法试试");
            invalid = true;
            break;
          }
          const args = action.args.safeParse(value);
          if (!args.success) {
            fail("AI 没能理解这句话，换个说法试试");
            invalid = true;
            break;
          }
          if (action.kind === "read") {
            const fields = args.data as Record<string, unknown>;
            const range = [fields.from ?? fields.due_from, fields.to ?? fields.due_to]
              .filter(localWhen)
              .join("–");
            emit({
              type: "status",
              message: `正在查看${range ? ` ${range} 的` : "相关"}${action.name.startsWith("calendar_") ? "日程" : "提醒"}…`,
            });
          }
          const prepared: Prepared<unknown> = await action.prepare(
            args.data,
            action.requiresRead ? writeContext : context,
          );
          if (interrupted()) return stopReading();
          if (prepared.type === "error") {
            showPrepared(action.name, prepared);
            invalid = true;
            break;
          }
          if (action.kind === "read") {
            if (prepared.type !== "data") throw invalidData();
            const payload = modelPayload(prepared.payload, this.ports.refs);
            turn.readDerived = true;
            const included = new Set(payload.items.map((item) => item.ref));
            readResults.push({
              type: "results",
              items: prepared.items.filter((item) => included.has(item.id)),
              empty: "没有查到相关日程或提醒",
            });
            completedCalls.push(wireCall(call));
            toolMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(payload),
            });
          } else {
            showPrepared(action.name, prepared);
          }
        }
        if (completedCalls.length) {
          const exchanges: Message[] = [
            { role: "assistant", content: null, tool_calls: completedCalls },
            ...toolMessages,
          ];
          messages.push(...exchanges);
          turn.exchanges.push(...structuredClone(exchanges));
        }
        if (invalid || hasWrite) return complete();
        if (step === stepLimit - 1) {
          const warning =
            options.stepLimitEnabled === false
              ? "已停止：步数异常"
              : "AI 没能在 6 步内给出结论，这是查到的内容";
          emit({ type: "warning", message: warning });
          summaries.push("（已列出查询结果，未能得出结论）");
        }
      }
    } catch (error) {
      if (interrupted()) return stopReading();
      if (error instanceof InvalidData) fail(error.message);
      else {
        const failure = aiError(error);
        fail(
          failure.message,
          ["KEY_MISSING", "KEY_INVALID", "CREDENTIAL_ERROR", "CONFIG_ERROR"].includes(failure.code)
            ? "settings"
            : "manual",
          failure.code,
        );
      }
    } finally {
      this.busy = false;
    }
    return complete();
  }
}
