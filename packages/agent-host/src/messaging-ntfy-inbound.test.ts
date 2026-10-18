/**
 * The ntfy channel, driven end to end against an in-process fake ntfy.
 *
 * The fake is a real HTTP server on `127.0.0.1` with an ephemeral port, so the
 * production `fetch` path, the real socket, the real ndjson stream and its byte
 * boundaries are all exercised — but nothing leaves the machine and no network
 * is reached. It models ntfy the way the server does: one append-only message
 * log per topic, `since=<id>` naming a position in it, a keepalive frame on
 * every subscription, and a `POST` that stores the message it was given.
 *
 * The suite covers what the shared conformance suite cannot see for this
 * channel: the own-echo loop, the ndjson line boundary, the keepalive frames,
 * byte-aware chunking of a long reply, the credential refusal path, and the
 * cursor's apply-then-save ordering across a restart.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import type { InboundMessage } from "./messaging-inbound.js";
import { ingressUtf8Bytes, type IngressCursorStore } from "./messaging-ingress.js";
import {
  createNtfyInboundPushTransport,
  createNtfyIngressAdapter,
  NTFY_MESSAGE_LIMIT,
  NTFY_OWN_TAG,
  NtfyNdjsonSplitter,
  type NtfyInboundAuditEntry,
} from "./messaging-ntfy-inbound.js";
import { createNtfySender } from "./messaging-ntfy-send.js";

// ---------------------------------------------------------------------------
// The fake ntfy
// ---------------------------------------------------------------------------

type Stored = { id: string; text: string; tags: string[] };

type SeenRequest = {
  method: string;
  path: string;
  since: string | null;
  authorization: string | null;
  tags: string | null;
};

/** One fake ntfy server for one topic, over a real loopback socket. */
class FakeNtfy {
  private server: Server | null = null;
  private counter = 0;
  readonly log: Stored[] = [];
  readonly requests: SeenRequest[] = [];
  /** When set, the next subscription answers this HTTP status instead. */
  refuseWith: { status: number; retryAfter?: string } | null = null;
  /** When set, the first ndjson line is written in two chunks. */
  splitNextLine = false;
  /** Frames written before the batch, exactly as ntfy holds the stream open. */
  keepalives: string[] = [];
  base = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Append one message as if someone else had published it. */
  publish(text: string, tags: string[] = [], id?: string): string {
    const messageId = id ?? `srv-${(this.counter += 1)}`;
    this.log.push({ id: messageId, text, tags });
    return messageId;
  }

  private async handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      since: url.searchParams.get("since"),
      authorization: request.headers.authorization ?? null,
      tags: (request.headers["x-tags"] as string | undefined) ?? null,
    });

    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const tags = ((request.headers["x-tags"] as string | undefined) ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const stored = this.publish(text, tags);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: stored, topic: "conformance" }));
      return;
    }

    if (!url.pathname.endsWith("/json")) {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    if (this.refuseWith) {
      const refusal = this.refuseWith;
      this.refuseWith = null;
      response.writeHead(refusal.status, {
        "content-type": "application/json",
        ...(refusal.retryAfter ? { "retry-after": refusal.retryAfter } : {}),
      });
      response.end(JSON.stringify({ error: "refused" }));
      return;
    }

    const since = url.searchParams.get("since");
    const from = since === null ? 0 : this.log.findIndex((entry) => entry.id === since) + 1;
    const batch = this.log.slice(from);

    response.writeHead(200, { "content-type": "application/x-ndjson" });
    // ntfy's keepalive: an empty line and a keepalive frame, on every
    // subscription, before any message.
    response.write("\n");
    for (const frame of this.keepalives) response.write(`${frame}\n`);

    const lines = batch.map((entry) =>
      JSON.stringify({
        id: entry.id,
        time: 1_760_000_000,
        event: "message",
        topic: url.pathname.split("/")[1],
        message: entry.text,
        tags: entry.tags,
      }),
    );

    if (this.splitNextLine && lines.length > 0) {
      this.splitNextLine = false;
      const first = lines[0]!;
      const cut = Math.floor(first.length / 2);
      response.write(first.slice(0, cut));
      await new Promise((resolve) => setTimeout(resolve, 20));
      response.write(`${first.slice(cut)}\n`);
      for (const line of lines.slice(1)) response.write(`${line}\n`);
    } else {
      for (const line of lines) response.write(`${line}\n`);
    }
    response.end();
  }
}

/** A message store that records the order the transport acts in. */
function recordingStore(order: string[]): { store: IngressCursorStore<string>; saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    store: {
      load: async () => (saved.length > 0 ? saved[saved.length - 1]! : null),
      save: async (id) => {
        order.push("save");
        saved.push(id);
      },
    },
  };
}

/** Run the channel's own loop until it has waited `stopAfter` times. */
async function runLoop(
  base: string,
  options: {
    stopAfter?: number;
    store?: IngressCursorStore<string>;
    token?: string;
    audit?: (entry: NtfyInboundAuditEntry) => void;
    apply?: (message: InboundMessage) => Promise<void>;
  } = {},
): Promise<{ messages: InboundMessage[]; controller: AbortController }> {
  const controller = new AbortController();
  let waits = 0;
  const messages: InboundMessage[] = [];
  const stopAfter = options.stopAfter ?? 1;
  const cursor = options.store ?? {
    load: async () => null,
    save: async () => {},
  };
  const transport = createNtfyInboundPushTransport({
    endpoint: base,
    topic: "conformance",
    allowInsecureHttp: true,
    ...(options.token ? { token: options.token } : {}),
    cursor,
    handled: memoryGuard(),
    wait: async () => {
      waits += 1;
      if (waits >= stopAfter) controller.abort();
    },
    ...(options.audit ? { audit: options.audit } : {}),
  });
  await transport.start(async (message) => {
    messages.push(message);
    if (options.apply) await options.apply(message);
  }, controller.signal);
  return { messages, controller };
}

function memoryGuard(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe("ntfy inbound", () => {
  it("turns a message someone else published into exactly one turn", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("/start do the thing");
      const { messages } = await runLoop(server.base);
      expect(messages).toEqual([
        { messageId: "srv-1", chatId: "conformance", text: "/start do the thing" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("never reads its own published message back as inbound (the echo loop)", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      // Publish through this channel's own send path, exactly as a reply
      // leaves. The fake stores the tags header it was given, so the echo is
      // verbatim: the same message, on the same topic, with the same tag.
      const sender = createNtfySender({
        endpoint: server.base,
        topic: "conformance",
        allowInsecureHttp: true,
      });
      const sent = await sender.send("the agent's own reply");
      expect(sent.ok).toBe(true);
      expect(server.log).toHaveLength(1);
      expect(server.log[0]!.tags).toContain(NTFY_OWN_TAG);

      // Now subscribe to that same topic. The message is in the log and is
      // offered by the server; it must produce no turn at all.
      const { messages } = await runLoop(server.base);
      expect(messages).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("does not turn keepalive frames or empty lines into turns", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.keepalives = [
        // Deliberately carrying text and an id, so the only thing that can keep
        // these out of the routing path is the frame's event type — not a
        // missing body. A keepalive with a body is still a keepalive.
        JSON.stringify({ id: "ka-1", event: "keepalive", topic: "conformance", message: "ping" }),
        JSON.stringify({ id: "open-1", event: "open", topic: "conformance", message: "opened" }),
        JSON.stringify({ id: "poll-1", event: "poll_request", topic: "conformance", message: "poll" }),
      ];
      const { messages } = await runLoop(server.base);
      expect(messages).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("does not deliver a message id the durable guard already saw", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("only once", [], "duplicate-id");
      server.publish("only once", [], "duplicate-id");
      const { messages } = await runLoop(server.base);
      expect(messages.map((message) => message.messageId)).toEqual(["duplicate-id"]);
    } finally {
      await server.stop();
    }
  });

  it("parses a JSON object split across two socket writes", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("/start across two writes");
      server.splitNextLine = true;
      const { messages } = await runLoop(server.base);
      expect(messages).toEqual([
        { messageId: "srv-1", chatId: "conformance", text: "/start across two writes" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("reassembles a multibyte character split across two reads", () => {
    const splitter = new NtfyNdjsonSplitter();
    const line = JSON.stringify({ id: "a", event: "message", message: "你好" });
    const bytes = new TextEncoder().encode(`${line}\n`);
    // Cut inside the first Chinese character's three-byte sequence.
    const cut = bytes.length - 8;
    expect(splitter.push(bytes.slice(0, cut))).toEqual([]);
    const rest = splitter.push(bytes.slice(cut));
    expect(rest).toHaveLength(1);
    expect(JSON.parse(rest[0]!).message).toBe("你好");
  });
});

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

describe("ntfy cursor", () => {
  it("saves the id only after the batch was applied, and only moves forward", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("first");
      server.publish("second");
      const order: string[] = [];
      const { store, saved } = recordingStore(order);
      const { messages } = await runLoop(server.base, {
        store,
        // The routing path's own arrival is recorded in the same order as the
        // save, so the assertion is about sequence, not just about a count.
        apply: async () => {
          order.push("apply");
        },
      });
      expect(messages).toHaveLength(2);
      expect(order).toEqual(["apply", "apply", "save"]);
      expect(saved).toEqual(["srv-2"]);
      // The applied batch came before the save: the store is written only once
      // the last message of the batch reached the routing path.
      expect(server.requests.filter((entry) => entry.method === "GET")).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("resumes from the saved id after a restart and replays nothing", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("first");
      const order: string[] = [];
      const { store, saved } = recordingStore(order);
      const first = await runLoop(server.base, { store });
      expect(first.messages).toHaveLength(1);
      expect(saved).toEqual(["srv-1"]);

      // A second loop over the same store is a restart: it asks from the saved
      // id, so the message it already applied is not offered again.
      const second = await runLoop(server.base, { store });
      expect(second.messages).toEqual([]);
      expect(saved).toEqual(["srv-1"]);
      const lastPoll = server.requests.filter((entry) => entry.method === "GET").at(-1)!;
      expect(lastPoll.since).toBe("srv-1");
    } finally {
      await server.stop();
    }
  });

  it("saves no id when the batch could not be applied", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.publish("first");
      const order: string[] = [];
      const { store, saved } = recordingStore(order);
      await runLoop(server.base, {
        store,
        apply: async () => {
          throw new Error("the routing path failed");
        },
      });
      expect(saved).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Publishing and failures
// ---------------------------------------------------------------------------

describe("ntfy publishing", () => {
  it("chunks a reply over 4096 bytes in byte order, without splitting a character", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      const sender = createNtfySender({
        endpoint: server.base,
        topic: "conformance",
        allowInsecureHttp: true,
      });
      // Chinese text: three bytes a character, so a character-counted chunker
      // would overflow the byte budget it was given.
      const text = "这是一条很长的回复，用来证明分块不会拆开一个多字节字符。".repeat(120);
      expect(ingressUtf8Bytes(text)).toBeGreaterThan(NTFY_MESSAGE_LIMIT);

      const result = await sender.send(text);
      expect(result.ok).toBe(true);
      expect(server.log.length).toBeGreaterThan(1);
      for (const entry of server.log) {
        expect(ingressUtf8Bytes(entry.text)).toBeLessThanOrEqual(NTFY_MESSAGE_LIMIT);
        expect(entry.text.includes("\uFFFD")).toBe(false);
        expect(entry.tags).toContain(NTFY_OWN_TAG);
      }
      // In order, and joined back into the reply exactly.
      expect(server.log.map((entry) => entry.text).join("")).toBe(text);
    } finally {
      await server.stop();
    }
  });

  it("surfaces a refused credential without echoing the token", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.refuseWith = { status: 401 };
      const audit: NtfyInboundAuditEntry[] = [];
      const token = "ntfy-SECRET-token";
      const { messages } = await runLoop(server.base, {
        token,
        audit: (entry) => audit.push(entry),
      });
      expect(messages).toEqual([]);
      expect(audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
      const observed = JSON.stringify(audit);
      expect(observed.includes(token)).toBe(false);
      expect(observed).toContain("401");
      // The token travelled in the platform's own header, never the URL.
      expect(server.requests[0]!.authorization).toBe(`Bearer ${token}`);
      expect(server.requests[0]!.path.includes(token)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("reports a 429 with the platform's own back-off", async () => {
    const server = new FakeNtfy();
    await server.start();
    try {
      server.refuseWith = { status: 429, retryAfter: "7" };
      const adapter = createNtfyIngressAdapter({
        endpoint: server.base,
        topic: "conformance",
        allowInsecureHttp: true,
      });
      const result = await adapter.poll("", undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryAfterMs).toBe(7_000);
    } finally {
      await server.stop();
    }
  });
});
