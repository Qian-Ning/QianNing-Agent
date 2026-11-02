/**
 * End-to-end through the real provider adapter: a local HTTP server speaks the
 * OpenAI streaming protocol, `streamSimple` parses it, and the agent answers.
 *
 * The faux provider proves the loop; this proves the wire — model construction,
 * the api key header, SSE parsing, and the text deltas reaching the screen.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LocalAgentHost } from "./host";
import { MemoryStore } from "./store";
import { ProviderBook } from "../bridge/providers";
import { updateSessionConfig } from "./session-config";

let server: Server;
let baseUrl = "";
const requests: Array<Record<string, unknown>> = [];

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  );
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { requests.push(JSON.parse(body)); });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(chunk({ role: "assistant", content: "" }, null));
      response.write(chunk({ content: "running " }, null));
      response.write(chunk({ content: "on the phone" }, null));
      response.write(chunk({}, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = "http://127.0.0.1:" + address.port + "/v1";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the phone agent over a real HTTP endpoint", () => {
  it("uses restored session provider/model/reasoning and applies partial changes on its cached agent", async () => {
    const store = new MemoryStore();
    const selected = new ProviderBook(store).create({ baseUrl, apiKey: "test", models: [{ id: "selected-model" }] });
    const host = new LocalAgentHost(store, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", modelId: "wrong-model" });
    const session = host.createSession("named");
    updateSessionConfig(store, session.id, { providerId: selected.id, modelId: "selected-model", thinkingLevel: "high" });
    await host.send(session.id, "first");
    expect(requests.at(-1)).toMatchObject({ model: "selected-model", reasoning_effort: "high" });
    updateSessionConfig(store, session.id, { thinkingLevel: "omit" });
    await host.send(session.id, "second");
    expect(requests.at(-1)?.model).toBe("selected-model");
    expect(requests.at(-1)).not.toHaveProperty("reasoning_effort");
  });

  it("streams a reply from an OpenAI-compatible provider", async () => {
    const host = new LocalAgentHost(new MemoryStore(), {
      baseUrl,
      apiKey: "test-key",
      modelId: "mock",
    });
    const session = host.createSession();
    const deltas: string[] = [];
    let completed = false;
    host.subscribe(session.id, (event) => {
      if (event.kind === "item.delta") {
        const detail = event.payload?.event as { deltaText?: string } | undefined;
        if (detail?.deltaText) deltas.push(detail.deltaText);
      }
      if (event.kind === "turn.completed") completed = true;
    });

    await host.send(session.id, "where are you running?");

    expect(completed).toBe(true);
    expect(deltas.join("")).toBe("running on the phone");
    expect(host.history(session.id).at(-1)?.text).toBe("running on the phone");
  });
});
