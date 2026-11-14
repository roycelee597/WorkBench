import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// 在仓库忽略目录运行的离线联调夹具；不记录 Authorization 或正文。
const folder = path.resolve(process.argv[2] ?? "dist/ai-a1-check");
const port = Number(process.argv[3] ?? 18926);
fs.mkdirSync(folder, { recursive: true });
const configuration = path.join(folder, "scenario.json");
if (!fs.existsSync(configuration)) fs.writeFileSync(configuration, '{"status":200}');
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    value = {};
  }
  const configured = JSON.parse(fs.readFileSync(configuration, "utf8"));
  const scenario = { ...configured };
  if (configured.scripted && request.url === "/chat/completions") {
    const marker = value.messages?.at(-1)?.content;
    if (/^A1:(401|402|429|503)$/.test(marker ?? "")) scenario.status = Number(marker.slice(3));
    if (marker === "A1:timeout") scenario.delay_ms = 31_000;
    if (marker === "A1:busy") scenario.delay_ms = 200;
    if (marker === "A1:bad") scenario.bad = true;
  }
  fs.appendFileSync(
    path.join(folder, "requests.jsonl"),
    JSON.stringify({
      time: Date.now(),
      method: request.method,
      path: request.url,
      fields: Object.keys(value),
      model: value.model,
      roles: Array.isArray(value.messages) ? value.messages.map((item) => item.role) : [],
      max_tokens: value.max_tokens,
      stream: value.stream,
      thinking: value.thinking,
      status: scenario.status ?? 200,
    }) + "\n",
  );
  if (scenario.delay_ms) await new Promise((resolve) => setTimeout(resolve, scenario.delay_ms));
  response.writeHead(scenario.status ?? 200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(
      scenario.bad
        ? { unexpected: true }
        : scenario.status && scenario.status !== 200
          ? { error: { message: "模拟错误，不转发此正文" } }
          : request.url === "/models"
            ? {
                object: "list",
                data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }],
              }
            : {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { role: "assistant", content: "这是本机模拟服务的测试回复。" },
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
              },
    ),
  );
});
server.listen(port, "127.0.0.1", () => console.log(`模拟服务已启动：http://127.0.0.1:${port}`));
