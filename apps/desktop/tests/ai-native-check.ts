import { getIdentifier } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { TauriLlmClient, aiError, type LlmRequest } from "../src/core/ai/llm-client";
import { aiApi } from "../../../workbenches/ai/src/api";

// 仅由手动指定 devUrl 加载，不进入产品入口；只允许专用隔离标识。
async function check() {
  const output = document.querySelector("#result")!;
  if ((await getIdentifier()) !== "com.royce.workbench.ai-a1-check") {
    output.textContent = "拒绝：仅允许 AI A1 专用隔离实例";
    return;
  }
  const results: string[] = [];
  function assert(condition: boolean, label: string) {
    if (!condition) throw new Error(`验收失败：${label}`);
    results.push(`通过：${label}`);
    output.textContent = results.join("\n");
  }
  const stage = new URLSearchParams(location.search).get("stage");
  const before = await aiApi.keyStatus();
  if (stage === "resume" || stage === "corrupt") {
    assert(
      before.usage.calls === (stage === "resume" ? 8 : 150),
      `${stage} 用量恢复 ${before.usage.calls}`,
    );
    assert(!before.configured, "清除后重启仍无凭据");
    output.textContent += "\n完成";
    return;
  }
  assert(before.usage.calls === 0, "新隔离实例模型调用数为零");
  const client = new TauriLlmClient();
  const request = (content: string): LlmRequest => ({
    model: "deepseek-flash",
    messages: [{ role: "user", content }],
    tools: [],
  });
  await aiApi.saveKey("sk-fake-workbench-test-ab12");
  try {
    const reply = await client.chat(request("A1:ok"));
    assert(
      reply.usage.prompt_tokens === 12 && reply.content?.includes("本机模拟") === true,
      "真实 IPC → Rust → 本机 HTTP → zod 返回",
    );
    await client.chat({ ...request("A1:blocked"), messages: [] }).then(
      () => {
        throw new Error("未拦截");
      },
      (error) => assert(aiError(error).code === "BAD_RESPONSE", "前端本地校验拦截"),
    );
    await invoke("ai_chat", { request: { ...request("A1:blocked"), model: "unknown" } }).then(
      () => {
        throw new Error("未拦截");
      },
      (error) => assert(aiError(error).code === "BAD_RESPONSE", "Rust 独立校验拦截"),
    );
    assert((await aiApi.keyStatus()).usage.calls === 1, "本地拦截不计数");
    for (const [status, code] of [
      [401, "KEY_INVALID"],
      [402, "INSUFFICIENT_BALANCE"],
      [429, "RATE_LIMITED"],
      [503, "UPSTREAM"],
    ] as const) {
      await client.chat(request(`A1:${status}`)).then(
        () => {
          throw new Error("未报错");
        },
        (error) => assert(aiError(error).code === code, `HTTP ${status} 不重试、错误码正确`),
      );
    }
    await client.chat(request("A1:bad")).then(
      () => {
        throw new Error("未报错");
      },
      (error) => assert(aiError(error).code === "BAD_RESPONSE", "非法响应被拒绝"),
    );
    const first = client.chat(request("A1:busy"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.chat(request("A1:busy")).then(
      () => {
        throw new Error("未拦截");
      },
      (error) => assert(aiError(error).code === "BUSY", "第二个在途请求被拒绝"),
    );
    await first;
    assert((await aiApi.keyStatus()).usage.calls === 7, "失败计数、BUSY 不计数");
    const started = Date.now();
    await client.chat(request("A1:timeout")).then(
      () => {
        throw new Error("未超时");
      },
      (error) => assert(aiError(error).code === "TIMEOUT", "真实 30 秒总超时"),
    );
    assert(
      Date.now() - started >= 29_000 && Date.now() - started < 35_000,
      "超时时间处于 29–35 秒",
    );
    const after = await aiApi.keyStatus();
    assert(
      after.usage.calls === 8 &&
        after.usage.prompt_tokens === 24 &&
        after.usage.completion_tokens === 8,
      "实际发出的 8 次均持久化，用量为 24/8 token",
    );
  } finally {
    await aiApi.clearKey();
  }
  assert(!(await aiApi.keyStatus()).configured, "仅清除隔离实例虚构凭据");
  output.textContent += "\n完成";
}
void check().catch((error: unknown) => {
  document.querySelector("#result")!.textContent +=
    `\n${error instanceof Error ? error.message : aiError(error).message}`;
});
