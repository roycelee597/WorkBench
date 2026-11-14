import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const aiModelSchema = z.enum(["deepseek-flash", "deepseek-v4-pro"]);
export type AiModel = z.infer<typeof aiModelSchema>;
export const DEFAULT_AI_MODEL: AiModel = "deepseek-flash";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const aiUsageSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    calls: count.max(300),
    minute: count,
    minute_calls: count.max(20),
    prompt_tokens: count,
    completion_tokens: count,
  })
  .strict();
export type AiUsage = z.infer<typeof aiUsageSchema>;
export const aiKeyStatusSchema = z
  .object({
    configured: z.boolean(),
    tail: z
      .string()
      .regex(/^[\x21-\x7e]{4}$/)
      .nullable(),
    usage: aiUsageSchema,
  })
  .strict()
  .refine((value) => value.configured === (value.tail !== null));
export type AiKeyStatus = z.infer<typeof aiKeyStatusSchema>;

const wireCall = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal("function"),
    function: z
      .object({ name: z.string().min(1).max(64), arguments: z.string().max(8_000) })
      .strict(),
  })
  .strict();
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string().max(8_000) }).strict(),
  z.object({ role: z.literal("user"), content: z.string().max(8_000) }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string().max(8_000).nullable(),
      tool_calls: z.array(wireCall).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string().max(8_000),
      tool_call_id: z.string().min(1).max(200),
    })
    .strict(),
]);
const toolSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z
          .string()
          .regex(/^[a-z]+_[a-z_]+$/)
          .max(64),
        description: z.string().max(300),
        parameters: z
          .object({
            type: z.literal("object"),
            properties: z.record(z.string(), z.unknown()),
            required: z.array(z.string()).optional(),
            additionalProperties: z.literal(false),
          })
          .passthrough(),
      })
      .strict(),
  })
  .strict();
export const llmRequestSchema = z
  .object({
    model: aiModelSchema,
    messages: z.array(messageSchema).min(1).max(40),
    tools: z.array(toolSchema).max(32),
  })
  .strict();
export type LlmRequest = z.infer<typeof llmRequestSchema>;
export const llmResponseSchema = z
  .object({
    content: z.string().max(32_000).nullable(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            arguments: z.string().max(8_000),
          })
          .strict(),
      )
      .max(128),
    usage: z
      .object({ prompt_tokens: count, completion_tokens: count, total_tokens: count })
      .strict(),
  })
  .strict()
  .refine((value) => value.content !== null || value.tool_calls.length > 0);
export type LlmResponse = z.infer<typeof llmResponseSchema>;

export const aiErrorMessages = {
  KEY_MISSING: "请先在设置中填写 DeepSeek API key",
  KEY_FORMAT: "API key 需为 20–200 个可见 ASCII 字符",
  KEY_INVALID: "API key 无效，请到设置中检查",
  INSUFFICIENT_BALANCE: "DeepSeek 账户余额不足，请到开放平台充值",
  RATE_LIMITED: "请求太频繁，请稍后再试",
  LOCAL_LIMIT: "已达到每分钟 20 次或每天 300 次调用上限，请稍后再试或手动新建",
  NETWORK: "网络连接失败，请手动新建",
  TIMEOUT: "DeepSeek 响应超时，请手动新建",
  UPSTREAM: "DeepSeek 服务暂时不可用，请手动新建",
  BAD_RESPONSE: "AI 返回的内容或请求参数无法解析，请手动新建或换个说法",
  TOO_LARGE: "这句话或上下文太长了，请缩短",
  BUSY: "上一句还在处理，请稍后再试",
  CREDENTIAL_ERROR: "无法访问系统凭据，请检查 Windows 凭据管理器",
  STORAGE_ERROR: "无法保存 AI 用量，已停止发送，请检查应用数据目录后重试",
  CONFIG_ERROR: "AI 模拟服务地址无效，只允许本机 HTTP 端口",
  FORBIDDEN: "只有主窗口可以访问 AI 服务",
} as const;
export type AiErrorCode = keyof typeof aiErrorMessages;
export class AiClientError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(aiErrorMessages[code]);
    this.name = "AiClientError";
  }
}
export function aiError(error: unknown): AiClientError {
  if (error instanceof AiClientError) return error;
  let value: unknown = error;
  if (typeof error === "string" && error.length < 2_000) {
    try {
      value = JSON.parse(error) as unknown;
    } catch {
      return new AiClientError("NETWORK");
    }
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    Object.hasOwn(aiErrorMessages, value.code)
  ) {
    // 只信任枚举错误码，不转发可能带密钥或上游正文的 message / cause。
    return new AiClientError(value.code as AiErrorCode);
  }
  return new AiClientError("BAD_RESPONSE");
}
export type AiInvoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export const invokeAi: AiInvoker = (command, args) => invoke(command, args);
export interface LlmClient {
  chat(request: LlmRequest): Promise<LlmResponse>;
}
export class TauriLlmClient implements LlmClient {
  constructor(private readonly call: AiInvoker = invokeAi) {}
  async chat(request: LlmRequest): Promise<LlmResponse> {
    const parsed = llmRequestSchema.safeParse(request);
    if (!parsed.success) throw new AiClientError("BAD_RESPONSE");
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > 128 * 1024)
      throw new AiClientError("TOO_LARGE");
    try {
      const response = llmResponseSchema.safeParse(
        await this.call("ai_chat", { request: parsed.data }),
      );
      if (!response.success) throw new AiClientError("BAD_RESPONSE");
      return response.data;
    } catch (error) {
      throw aiError(error);
    }
  }
}
