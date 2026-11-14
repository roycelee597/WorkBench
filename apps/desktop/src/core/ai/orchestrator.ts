import {
  DATA_NOTICE,
  type DataPayload,
  type Prepared,
  type RefTable,
  type ResultItem,
} from "./action-types";
import {
  aiError,
  AiClientError,
  DEFAULT_AI_MODEL,
  llmResponseSchema,
  type AiErrorCode,
  type AiModel,
  type LlmClient,
  type LlmRequest,
} from "./llm-client";
import { buildSystemPrompt } from "./prompt";
import type { AiRegistry } from "./registry";

type Message = LlmRequest["messages"][number];
type Assistant = Extract<Message, { role: "assistant" }>;
type WireCall = NonNullable<Assistant["tool_calls"]>[number];
const HISTORY_MS = 30 * 60 * 1000;
const MAX_CALLS = 3;
const MAX_TOOLS = 5;

export interface ConversationTurn {
  createdAt: number;
  user: string;
  text: string;
  exchanges: Message[];
  readDerived: boolean;
}

export type OrchestratorEvent =
  | { type: "text"; text: string }
  | { type: "error"; message: string; code?: AiErrorCode; fallback?: "manual" | "settings" }
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
  for (const raw of payload.items.slice(0, 60)) {
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
  while (JSON.stringify(result).length > 6000 && result.items.length) {
    result.items.pop();
    result.truncated = true;
  }
  if (JSON.stringify(result).length > 6000) throw invalidData();
  return result;
}

const wireCall = (call: { id: string; name: string; arguments: string }): WireCall => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: call.arguments },
});

export class AiOrchestrator {
  private busy = false;
  constructor(private readonly ports: OrchestratorPorts) {}

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
        const output = exchanges
          .slice(i + 1)
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
      return { events, turn };
    };
    const fail = (
      message: string,
      fallback: "manual" | "settings" = "manual",
      code?: AiErrorCode,
    ) => {
      emit({ type: "error", message, fallback, ...(code ? { code } : {}) });
      summaries.push("（本轮未能完成，请重新说明或手动操作）");
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
    try {
      const readEnabled = options.readEnabled !== false;
      if (!readEnabled) this.ports.refs.clear();
      const tools = this.ports.registry.tools({ allowRead: readEnabled });
      const timezone = (
        this.ports.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
      )();
      const messages: Message[] = [
        { role: "system", content: buildSystemPrompt({ now, timezone, tools }) },
        ...this.historyMessages(options.history ?? [], now, readEnabled),
        { role: "user", content: turn.user },
      ];
      for (let step = 0; step < MAX_CALLS; step++) {
        emit({ type: "status", message: "正在理解…" });
        const parsed = llmResponseSchema.safeParse(
          await this.ports.client.chat({
            model: options.model ?? DEFAULT_AI_MODEL,
            messages: structuredClone(messages),
            tools,
          }),
        );
        if (!parsed.success) throw new AiClientError("BAD_RESPONSE");
        const reply = parsed.data;
        if (reply.content) {
          emit({ type: "text", text: reply.content });
          summaries.push(reply.content);
        }
        if (!reply.tool_calls.length) return complete();
        const calls = reply.tool_calls.slice(0, MAX_TOOLS);
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
          if (!readEnabled && action.kind === "read") {
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
          if (action.kind === "read") emit({ type: "status", message: "正在查看相关日程和提醒…" });
          const prepared: Prepared<unknown> = await action.prepare(args.data, {
            now,
            timezone,
            refs: this.ports.refs,
          });
          if (prepared.type === "error") {
            fail(prepared.message, prepared.fallback);
            invalid = true;
            break;
          }
          if (action.kind === "read") {
            if (prepared.type !== "data") throw invalidData();
            const payload = modelPayload(prepared.payload, this.ports.refs);
            turn.readDerived = true;
            emit({ type: "results", items: prepared.items, empty: "没有查到相关日程或提醒" });
            completedCalls.push(wireCall(call));
            toolMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(payload),
            });
          } else {
            emit({ type: "prepared", actionName: action.name, prepared });
            summaries.push("（已生成 1 张操作卡片，尚未写入）");
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
        if (step === MAX_CALLS - 1) {
          const warning = "AI 没能在 3 步内给出结论，这是查到的内容";
          emit({ type: "warning", message: warning });
          summaries.push("（已列出查询结果，未能得出结论）");
        }
      }
    } catch (error) {
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
