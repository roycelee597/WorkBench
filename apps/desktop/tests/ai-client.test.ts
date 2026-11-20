import { describe, expect, it, vi } from "vitest";
import {
  aiError,
  aiErrorMessages,
  AiClientError,
  llmResponseSchema,
  TauriLlmClient,
  type LlmRequest,
  type LlmResponse,
} from "../src/core/ai/llm-client";
import { MockLlmClient } from "./mock-llm-client";

const request: LlmRequest = {
  model: "deepseek-flash",
  messages: [{ role: "user", content: "明天有什么安排" }],
  tools: [],
};
const response: LlmResponse = {
  content: "你好",
  tool_calls: [],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
};

describe("AI 客户端协议", () => {
  it("只通过原生命令调用，支持文字、tool_calls 及对应 tool 消息", async () => {
    const call = vi.fn().mockResolvedValue(response);
    const client = new TauriLlmClient(call);
    expect(await client.chat(request)).toEqual(response);
    expect(call).toHaveBeenCalledWith("ai_chat", { request });
    const toolResponse: LlmResponse = {
      ...response,
      content: null,
      tool_calls: [{ id: "call_1", name: "calendar_list_events", arguments: "{}" }],
    };
    call.mockResolvedValueOnce(toolResponse);
    expect(await client.chat(request)).toEqual(toolResponse);
    const followup: LlmRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "calendar_list_events", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"type":"workbench_data"}' },
      ],
    };
    await client.chat(followup);
    expect(call).toHaveBeenLastCalledWith("ai_chat", { request: followup });
  });
  it.each([
    null,
    {},
    { ...response, key: "must-not-appear" },
    { ...response, content: 42 },
    { ...response, content: null },
    { ...response, tool_calls: [{ id: "x" }] },
    { ...response, usage: { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 } },
  ])("非法响应返回安全错误，不带原始内容：%j", async (bad) => {
    const client = new TauriLlmClient(vi.fn().mockResolvedValue(bad));
    await expect(client.chat(request)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
  it("本地非法参数和 UTF-8 总体积超限不调用 Rust", async () => {
    const call = vi.fn();
    const client = new TauriLlmClient(call);
    await expect(client.chat({ ...request, messages: [] })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
    await expect(
      client.chat({
        ...request,
        messages: Array.from({ length: 90 }, () => ({
          role: "user" as const,
          content: "中".repeat(8_000),
        })),
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(call).not.toHaveBeenCalled();
  });
  it.each(Object.keys(aiErrorMessages))("原生错误 %s 不重试、不转发上游正文", async (code) => {
    const fakeKey = "sk-fake-workbench-test-ab12";
    const call = vi.fn().mockRejectedValue({ code, message: fakeKey, cause: fakeKey });
    const client = new TauriLlmClient(call);
    const failure = await client.chat(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiClientError);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain(fakeKey);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("解析 JSON 格式错误码，未知错误脱敏，MockLlmClient 只返回脚本结果", async () => {
    expect(aiError('{"code":"KEY_INVALID","message":"private"}').code).toBe("KEY_INVALID");
    expect(aiError("network-private").message).not.toContain("private");
    expect(aiError({ code: "toString", message: "private" }).code).toBe("BAD_RESPONSE");
    expect(llmResponseSchema.safeParse(response).success).toBe(true);
    const mock = new MockLlmClient([response, new AiClientError("TIMEOUT")]);
    expect(await mock.chat(request)).toEqual(response);
    await expect(mock.chat(request)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(mock.requests).toHaveLength(2);
  });
});
