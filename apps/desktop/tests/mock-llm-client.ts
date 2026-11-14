import type { LlmClient, LlmRequest, LlmResponse } from "../src/core/ai/llm-client";

// 只供测试使用；每步显式指定结果或错误，绝不联网。
export class MockLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly steps: Array<LlmResponse | Error>) {}
  async chat(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const result = this.steps.shift();
    if (!result) throw new Error("模拟响应已用完");
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }
}
