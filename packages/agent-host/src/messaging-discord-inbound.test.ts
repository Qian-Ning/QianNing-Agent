import { describe, expect, it } from "vitest";

import type { InboundMessage } from "./messaging-inbound.js";
import {
  chunkDiscordMessage,
  classifyDiscordMessage,
  createDiscordInboundPushTransport,
  createDiscordSender,
  DiscordGatewayClient,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_MESSAGE_LIMIT,
  type DiscordGatewayLookup,
  type DiscordGatewayResult,
  type DiscordInboundAuditEntry,
  type DiscordInboundHandledStore,
  type DiscordSocket,
  type DiscordSocketFactory,
  type DiscordTimers,
} from "./messaging-discord-inbound.js";

// ---------------------------------------------------------------------------
// Fakes for the two network seams and the durable guard. No test opens a
// socket or reaches Discord: every frame is delivered by hand.
// ---------------------------------------------------------------------------

class FakeSocket implements DiscordSocket {
  readonly sent: string[] = [];
  /** A real socket drops its listeners on close; the fake does the same so a
   *  superseded subscription cannot deliver, and a missing close is visible. */
  closed = false;
  private onMessageHandler: ((data: string) => void) | null = null;
  private onCloseHandler: ((code?: number, reason?: string) => void) | null = null;
  private onErrorHandler: ((error: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onMessageHandler = null;
    this.onCloseHandler = null;
    this.onErrorHandler = null;
  }
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(handler: (code?: number, reason?: string) => void): void {
    this.onCloseHandler = handler;
  }
  onError(handler: (error: unknown) => void): void {
    this.onErrorHandler = handler;
  }

  deliver(frame: unknown): void {
    this.onMessageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  serverClose(reason = "server closed"): void {
    this.onCloseHandler?.(1006, reason);
  }
  /** The parsed frames this client sent, in order. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
  identify(): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.op === 2);
  }
  resume(): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.op === 6);
  }
}

class FakeFactory {
  readonly created: FakeSocket[] = [];
  readonly urls: string[] = [];
  factory: DiscordSocketFactory = (url) => {
    this.urls.push(url);
    const socket = new FakeSocket();
    this.created.push(socket);
    return socket;
  };
  get last(): FakeSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no socket was created");
    return socket;
  }
}

/** A timer seam that records the heartbeat callback instead of scheduling it. */
function fakeTimers(): { timers: DiscordTimers; tick: () => void; intervals: number[] } {
  let handler: (() => void) | null = null;
  const intervals: number[] = [];
  return {
    intervals,
    timers: {
      setInterval: (fn, ms) => {
        handler = fn;
        intervals.push(ms);
        return 1;
      },
      clearInterval: () => {
        handler = null;
      },
    },
    tick: () => handler?.(),
  };
}

class MemoryHandledStore implements DiscordInboundHandledStore {
  private readonly keys = new Set<string>();
  async has(key: string): Promise<boolean> {
    return this.keys.has(key);
  }
  async record(key: string): Promise<void> {
    this.keys.add(key);
  }
}

function gateway(url = "wss://gateway.discord.test/?v=10&encoding=json"): {
  lookup: DiscordGatewayLookup;
  tokens: string[];
} {
  const tokens: string[] = [];
  return {
    tokens,
    lookup: async (token: string): Promise<DiscordGatewayResult> => {
      tokens.push(token);
      return { ok: true, url };
    },
  };
}

type Fixture = {
  client: DiscordGatewayClient;
  factory: FakeFactory;
  handled: MemoryHandledStore;
  messages: InboundMessage[];
  audit: DiscordInboundAuditEntry[];
  tick: () => void;
  intervals: number[];
};

function buildClient(overrides: Partial<{ handled: MemoryHandledStore; token: string }> = {}): Fixture {
  const factory = new FakeFactory();
  const handled = overrides.handled ?? new MemoryHandledStore();
  const messages: InboundMessage[] = [];
  const audit: DiscordInboundAuditEntry[] = [];
  const clock = fakeTimers();
  const client = new DiscordGatewayClient({
    token: overrides.token ?? "discord-bot-token-SECRET",
    resolveGateway: gateway().lookup,
    connect: factory.factory,
    handled,
    onMessage: async (message) => {
      messages.push(message);
    },
    audit: (entry) => audit.push(entry),
    timers: clock.timers,
  });
  return {
    client,
    factory,
    handled,
    messages,
    audit,
    tick: clock.tick,
    intervals: clock.intervals,
  };
}

const HELLO = { op: 10, d: { heartbeat_interval: 41_250 } };

function ready(userId = "bot-1", sessionId = "sess-1"): Record<string, unknown> {
  return { op: 0, s: 1, t: "READY", d: { session_id: sessionId, user: { id: userId, bot: true } } };
}

function messageCreate(options: {
  id?: string;
  channelId?: string;
  content?: string;
  authorId?: string;
  bot?: boolean;
  type?: number;
  seq?: number;
} = {}): Record<string, unknown> {
  return {
    op: 0,
    s: options.seq ?? 2,
    t: "MESSAGE_CREATE",
    d: {
      id: options.id ?? "m-1",
      channel_id: options.channelId ?? "chan-1",
      content: options.content ?? "/start hello",
      type: options.type ?? 0,
      author: { id: options.authorId ?? "human-1", bot: options.bot ?? false },
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Handshake, heartbeat, resume
// ---------------------------------------------------------------------------

describe("discord gateway handshake", () => {
  it("identifies with the bot token and the message intents", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    await flush();

    const identify = fixture.factory.last.identify();
    expect(identify).toBeDefined();
    const data = identify?.d as Record<string, unknown>;
    expect(data.token).toBe("discord-bot-token-SECRET");
    expect(data.intents).toBe(DISCORD_GATEWAY_INTENTS);
    // MESSAGE_CONTENT is the privileged intent a bot needs to read content.
    expect((data.intents as number) & (1 << 15)).toBe(1 << 15);
    expect(fixture.factory.urls[0]).toContain("wss://gateway.discord.test");
  });

  it("heartbeats on the platform's interval and stops when unacknowledged", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    await flush();
    expect(fixture.intervals).toEqual([41_250]);

    fixture.tick();
    await flush();
    const heartbeats = fixture.factory.last.frames().filter((frame) => frame.op === 1);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.d).toBeNull();

    // No ACK arrived before the next tick: the connection is a zombie and is
    // torn down, so the transport reconnects and resumes.
    fixture.tick();
    await flush();
    expect(fixture.audit.some((entry) => entry.kind === "heartbeat-missed")).toBe(true);
    expect(fixture.audit.some((entry) => entry.kind === "disconnect")).toBe(true);
  });

  it("acknowledges a heartbeat and keeps the sequence in the next one", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready());
    await flush();
    fixture.tick();
    await flush();
    fixture.factory.last.deliver({ op: 11 });
    fixture.factory.last.deliver(messageCreate({ seq: 7 }));
    await flush();
    fixture.tick();
    await flush();
    const heartbeats = fixture.factory.last.frames().filter((frame) => frame.op === 1);
    expect(heartbeats[1]?.d).toBe(7);
  });

  it("resumes with the session id and sequence after a close", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready("bot-1", "sess-42"));
    fixture.factory.last.deliver(messageCreate({ seq: 9 }));
    await flush();
    fixture.factory.last.serverClose();
    await flush();

    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    await flush();
    const resume = fixture.factory.last.resume();
    expect(resume).toBeDefined();
    expect(resume?.d).toMatchObject({ session_id: "sess-42", seq: 9 });
    // A resume is not an identify: the platform keeps the subscription.
    expect(fixture.factory.last.identify()).toBeUndefined();
  });

  it("identifies afresh after an invalid non-resumable session", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready());
    await flush();
    fixture.factory.last.deliver({ op: 9, d: false });
    await flush();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    await flush();
    expect(fixture.factory.last.resume()).toBeUndefined();
    expect(fixture.factory.last.identify()).toBeDefined();
  });

  it("never puts the token in a refused lookup's error or audit", async () => {
    const factory = new FakeFactory();
    const audit: DiscordInboundAuditEntry[] = [];
    const client = new DiscordGatewayClient({
      token: "discord-bot-token-SECRET",
      resolveGateway: async () => ({ ok: false, error: "the gateway lookup answered HTTP 401" }),
      connect: factory.factory,
      handled: new MemoryHandledStore(),
      onMessage: async () => undefined,
      audit: (entry) => audit.push(entry),
    });
    const error = await client.connect().catch((caught: unknown) => caught);
    expect(factory.created).toHaveLength(0);
    expect(String(error)).not.toContain("SECRET");
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Inbound normalisation and the durable guard
// ---------------------------------------------------------------------------

describe("discord inbound messages", () => {
  it("turns one foreign MESSAGE_CREATE into exactly one inbound turn", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready());
    fixture.factory.last.deliver(messageCreate({ id: "m-42", channelId: "chan-9", content: "/turn hi" }));
    await flush();

    expect(fixture.messages).toEqual([
      { messageId: "m-42", chatId: "chan-9", text: "/turn hi" },
    ]);
    expect(fixture.audit.filter((entry) => entry.kind === "processed")).toHaveLength(1);
    // A thread is its own channel, so the reply destination is the thread id.
    expect(fixture.messages[0]?.chatId).toBe("chan-9");
  });

  it("ignores the bot's own message, another bot, a system event and empty text", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready("bot-1"));

    fixture.factory.last.deliver(messageCreate({ id: "own", authorId: "bot-1" }));
    fixture.factory.last.deliver(messageCreate({ id: "bot", authorId: "other-bot", bot: true }));
    fixture.factory.last.deliver(messageCreate({ id: "system", type: 7 }));
    fixture.factory.last.deliver(messageCreate({ id: "empty", content: "   " }));
    await flush();

    expect(fixture.messages).toEqual([]);
    const reasons = fixture.audit.filter((entry) => entry.kind === "filtered").map((entry) => entry.kind === "filtered" && entry.reason);
    expect(reasons).toContain("message is the client's own");
    expect(reasons).toContain("message is from a bot");
    expect(reasons).toContain("message is a system event");
    expect(reasons).toContain("message carries no text");
  });

  it("delivers a redelivered message id once", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver(HELLO);
    fixture.factory.last.deliver(ready());
    fixture.factory.last.deliver(messageCreate({ id: "m-dup" }));
    await flush();
    fixture.factory.last.deliver(messageCreate({ id: "m-dup" }));
    await flush();

    expect(fixture.messages).toHaveLength(1);
    expect(fixture.audit.some((entry) => entry.kind === "duplicate")).toBe(true);
  });

  it("classifies a plain message and refuses the shapes the driver must never see", () => {
    expect(classifyDiscordMessage({ id: "1", channel_id: "c", content: "hi", type: 0, author: { id: "u" } }, null)).toEqual({
      accepted: true,
      message: { messageId: "1", chatId: "c", text: "hi" },
    });
    expect(classifyDiscordMessage({ id: "1", channel_id: "c", content: "hi", type: 0, author: { id: "bot", bot: true } }, null).accepted).toBe(false);
    expect(classifyDiscordMessage({ id: "1", channel_id: "c", content: "hi", author: { id: "bot" } }, "bot").accepted).toBe(false);
    expect(classifyDiscordMessage({ id: "1", channel_id: "c", content: "hi", type: 19, author: { id: "u" } }, null).accepted).toBe(false);
    expect(classifyDiscordMessage({ channel_id: "c", content: "hi", author: { id: "u" } }, null).accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconnect: one subscription, no re-delivery
// ---------------------------------------------------------------------------

describe("discord reconnect", () => {
  it("reconnects without duplicating the subscription or a message", async () => {
    const factory = new FakeFactory();
    const handled = new MemoryHandledStore();
    const messages: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createDiscordInboundPushTransport({
      client: {
        token: "discord-bot-token-SECRET",
        resolveGateway: gateway().lookup,
        connect: factory.factory,
        handled,
        audit: () => {},
        timers: fakeTimers().timers,
      },
      wait: async () => undefined,
    });
    const done = transport.start(async (message) => {
      messages.push(message);
    }, controller.signal);

    for (let i = 0; i < 20 && factory.created.length < 1; i += 1) await flush();
    factory.last.deliver(HELLO);
    factory.last.deliver(ready());
    factory.last.deliver(messageCreate({ id: "m-1" }));
    await flush();
    expect(messages).toHaveLength(1);

    // The socket drops; the loop resumes on a new connection.
    factory.last.serverClose();
    for (let i = 0; i < 40 && factory.created.length < 2; i += 1) await flush();
    expect(factory.created).toHaveLength(2);
    factory.last.deliver(HELLO);
    await flush();
    expect(factory.last.resume()).toBeDefined();

    // Discord replays the same message after the resume. It is not acted on
    // twice: the durable guard served the second copy as a duplicate.
    factory.last.deliver(messageCreate({ id: "m-1", seq: 3 }));
    await flush();
    expect(messages).toHaveLength(1);

    // The superseded socket delivered nothing more: the old subscription was
    // torn down, so a fresh message on it is not a second inbound turn.
    expect(factory.created[0]?.closed).toBe(true);
    factory.created[0]?.deliver(messageCreate({ id: "m-2", seq: 4 }));
    await flush();
    expect(messages).toHaveLength(1);

    controller.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------
// Outbound: chunking, order, rate limits, token hygiene
// ---------------------------------------------------------------------------

describe("discord replies", () => {
  it("pins Discord's per-message limit", () => {
    expect(DISCORD_MESSAGE_LIMIT).toBe(2000);
  });

  it("chunks at 2000 characters, preserving order and content", () => {
    const text = Array.from({ length: 90 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
    expect(text.length).toBeGreaterThan(DISCORD_MESSAGE_LIMIT);
    const chunks = chunkDiscordMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(chunks.join("")).toBe(text);
    // No split separates a surrogate pair.
    const emoji = "😀".repeat(1200);
    for (const chunk of chunkDiscordMessage(emoji)) {
      for (let i = 0; i < chunk.length; i += 1) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = chunk.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i += 1;
        }
      }
    }
    expect(chunkDiscordMessage("")).toEqual([]);
  });

  it("posts every chunk sequentially and keeps their order", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    const sender = createDiscordSender({
      token: "discord-bot-token-SECRET",
      endpoint: "https://discord.com/api/v10",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: `id-${bodies.length}` }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const text = `${"a".repeat(1999)}\n${"b".repeat(1999)}\n${"c".repeat(10)}`;
    const result = await sender.send("chan-1", text);
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(3);
    expect(bodies.map((body) => body.content).join("")).toBe(text);
    expect(bodies.every((body) => body.content === undefined ? false : String(body.content).length <= 2000)).toBe(true);
    // The token travels in the platform's header, never in the body.
    expect(headers[0]?.Authorization).toBe("Bot discord-bot-token-SECRET");
    expect(JSON.stringify(bodies)).not.toContain("SECRET");
  });

  it("waits out a rate limit instead of dropping the chunk", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sender = createDiscordSender({
      token: "discord-bot-token-SECRET",
      endpoint: "https://discord.com/api/v10",
      wait: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 429,
            ok: false,
            headers: new Headers(),
            json: async () => ({ retry_after: 1.5 }),
          } as unknown as Response;
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: "ok-1" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const result = await sender.send("chan-1", "hello");
    expect(result).toEqual({ ok: true, sent: 1, ids: ["ok-1"] });
    expect(waits).toEqual([1500]);
  });

  it("reports a refusal without the token", async () => {
    const sender = createDiscordSender({
      token: "discord-bot-token-SECRET",
      endpoint: "https://discord.com/api/v10",
      fetchImpl: (async () => ({
        status: 401,
        ok: false,
        headers: new Headers(),
        json: async () => ({ message: "401: Unauthorized", token: "discord-bot-token-SECRET" }),
      })) as unknown as typeof fetch,
    });
    const result = await sender.send("chan-1", "hello");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("refuses an empty credential before any request", async () => {
    let called = false;
    const sender = createDiscordSender({
      token: "   ",
      endpoint: "https://discord.com/api/v10",
      fetchImpl: (async () => {
        called = true;
        return {} as Response;
      }) as unknown as typeof fetch,
    });
    expect(await sender.send("chan-1", "hello")).toEqual({
      ok: false,
      error: "the configured bot token is empty",
      sent: 0,
    });
    expect(called).toBe(false);
  });
});
