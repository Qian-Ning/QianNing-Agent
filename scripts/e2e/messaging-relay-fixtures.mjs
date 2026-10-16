import { createServer } from "node:http";

/**
 * The loopback fixtures E2E-232 needs, and nothing else: an outbound webhook
 * sink, a Telegram long-poll bot, and a model service. Every one of them binds
 * `127.0.0.1:0`, so the scenario reaches no external service, holds no live
 * token, and needs no Electron.
 *
 * # Where each fixture comes from
 *
 * The webhook sink is the JavaScript side of the fixture the Rust suites use
 * (`crates/host-core/src/messaging_outbound/fixture.rs`): a hand-written HTTP
 * server on loopback that records every request it received and answers what the
 * test tells it to. That fixture is `pub(crate)` inside host-core and cannot be
 * reached from a script, so the controls the scenario needs are restated here —
 * a settable status, per-request recording, and a bounded wait for a request to
 * arrive — and nothing more. The status control is what expresses step 5
 * without waiting a real minute: the sink answers 503 across a driven attempt
 * cycle, exactly as `crates/host-core/src/messaging_webhook/tests.rs` does.
 *
 * The bot is the plaintext loopback `node:http` server
 * `packages/host-runtime/src/messaging-inbound-wiring.test.ts` builds, in both
 * directions: it serves the `getUpdates` long poll a linked and an unlinked chat
 * send commands through, and it records the `sendMessage` posts the outbound
 * Telegram channel delivers summaries with.
 *
 * The model fixture follows `scripts/e2e/scheduled-model.mjs` — the same
 * `chat.completion.chunk` SSE shape, the same plan to answer a call the runtime
 * did not expose yet, the same `ToolSearch` fallback — and departs from it in
 * one place: its scenarios drive `ScheduledTask*` tools only, so it cannot raise
 * a pending tool approval. This one answers a turn with text, or with a `Write`
 * tool call that host-core leaves pending under the `ask` permission mode.
 */

/** Read a request body to the end; the fixtures record what they received. */
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Poll `probe` until it answers truthy, or fail loudly at the bound. No fixture
 * wait is a bare sleep: a timeout is a failing assertion carrying the detail
 * that would explain it.
 */
export async function pollUntil(probe, { timeoutMs = 30_000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last=${JSON.stringify(last)})`);
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

/**
 * The webhook sink: records every request, answers `status`, and can be told to
 * answer errors for a while and then recover (step 5).
 */
export async function webhookSinkFixture() {
  const requests = [];
  let status = 200;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const answered = status;
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"] ?? null,
      body,
      answered,
      at: Date.now(),
    });
    response.writeHead(answered, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: answered < 400 }));
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests: () => requests,
    /** Every envelope the sink was sent, newest first parse order preserved. */
    envelopes: () => requests.map((entry) => parseEnvelope(entry.body)).filter((entry) => entry !== null),
    /** Make the sink answer `next` (503 is the "errors" state of step 5). */
    setStatus(next) {
      status = next;
    },
    close() {
      server.close();
      server.unref();
    },
  };
}

/** The text of one transcript message, whether it is a string or parts. */
function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return "";
}

/** The JSON body of one delivery, or `null` when the body is not one. */
function parseEnvelope(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The Telegram bot fixture: the long poll a command arrives on, and the
 * `sendMessage` post an outbound summary is delivered with.
 *
 * It answers `getUpdates` immediately with whatever the offset has not consumed
 * yet, so the driver's own minimum poll interval — not this fixture — paces the
 * loop. `push` queues one message from one chat; a chat the Host has no link for
 * is how step 4 sends its command.
 */
export async function botFixture() {
  const updates = [];
  const sent = [];
  let nextUpdateId = 1;
  let nextMessageId = 1_000;
  let token = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    const answer = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && url.pathname.endsWith("/getUpdates")) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const due = updates.filter((update) => update.update_id >= offset);
      answer({ ok: true, result: due });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/sendMessage")) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      sent.push({ path: url.pathname, body, parsed, at: Date.now() });
      answer({ ok: true, result: { message_id: (nextMessageId += 1) } });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, description: "not found" }));
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    /** The token the fixture's routes are keyed on; set once the Host has one. */
    setToken(value) {
      token = value;
    },
    get token() {
      return token;
    },
    /** Queue one inbound message; returns the update id it was queued under. */
    push(chatId, text) {
      const update = {
        update_id: (nextUpdateId += 1),
        message: { message_id: (nextMessageId += 1), chat: { id: chatId }, text },
      };
      updates.push(update);
      return update;
    },
    /** Every summary the outbound Telegram channel posted here, parsed. */
    delivered: () =>
      sent.map((entry) => {
        const envelope = parseEnvelope(entry.parsed?.text ?? "");
        return {
          chatId: entry.parsed?.chat_id ?? null,
          envelope,
          at: entry.at,
        };
      }),
    /** Every envelope this bot was sent, `null` entries dropped. */
    envelopes: () =>
      sent
        .map((entry) => parseEnvelope(entry.parsed?.text ?? ""))
        .filter((entry) => entry !== null),
    close() {
      server.close();
      server.unref();
    },
  };
}

/** The distinctive text planted where only transcript content ever lives. */
export const SENTINEL = "SENTINEL_relay_leak_3f9a1c";

/** The one file the approval turn asks to write, named with the sentinel. */
export const SENTINEL_FILE = `${SENTINEL}.txt`;

/**
 * The model fixture: one loopback SSE service that completes a turn, or raises
 * a pending tool approval, on request.
 *
 * The mode is read from the turn's prompt, which is deterministic and needs no
 * side channel: a prompt naming `RAISE_APPROVAL` is answered with one `Write`
 * tool call whose path and content carry the sentinel, and every other prompt —
 * and every follow-up call that already carries a tool result — with a plain
 * text reply that carries the sentinel too.
 */
export async function relayModelFixture() {
  const requests = [];
  const seen = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "relay-fixture", object: "model" }] }));
      return;
    }
    const body = await readBody(request);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400);
      response.end("not json");
      return;
    }
    requests.push(parsed);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const hasToolResult = messages.some((message) => message.role === "tool");
    const prompt = [...messages].reverse().find((message) => message.role === "user");
    const promptText = messageText(prompt);
    const wantsApproval = !hasToolResult && promptText.includes("RAISE_APPROVAL");
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const hasWrite = tools.some((tool) => tool.function?.name === "Write");
    seen.push({
      index: requests.length,
      prompted: promptText.slice(0, 60),
      messages: messages.length,
      hasToolResult,
      wantsApproval,
      toolNames: tools.map((tool) => tool.function?.name).filter(Boolean),
      emitted: wantsApproval && hasWrite ? "Write" : "text",
    });

    const base = { id: `relay-fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: parsed.model };
    const emit = (delta, finishReason = null) =>
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });

    if (wantsApproval && hasWrite) {
      const id = `relay-call-${requests.length}`;
      emit({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name: "Write", arguments: JSON.stringify({ path: SENTINEL_FILE, content: `${SENTINEL}\n` }) },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: `relay fixture reply ${SENTINEL}` });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls: () => requests.length,
    /** What each model call asked for and what was emitted, for diagnostics. */
    describe: () => seen,
    close() {
      server.close();
      server.unref();
    },
  };
}
