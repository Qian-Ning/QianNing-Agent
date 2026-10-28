// Minimal OpenAI-compatible endpoint: one streamed answer, no tool calls.
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    return;
  }
  if (req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      for (const piece of ["你", "好", "，", "这是", "离线", "测试。"]) res.write(chunk({ content: piece }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404).end("no");
});

server.listen(4601, "127.0.0.1", () => console.log("fake provider on 4601"));
