import { describe, expect, it } from "vitest";

import type { InboundMessage } from "./messaging-inbound.js";
import {
  chunkMattermostPost,
  classifyMattermostPost,
  createMattermostInboundPushTransport,
  createMattermostSender,
  MattermostSocketClient,
  MATTERMOST_POST_LIMIT,
  mattermostWebSocketUrl,
  type MattermostIdentityLookup,
  type MattermostInboundAuditEntry,
  type MattermostInboundHandledStore,
  type MattermostSocket,
  type MattermostSocketFactory,
} from "./messaging-mattermost-inbound.js";

// ---------------------------------------------------------------------------
// Fakes for the identity lookup, the websocket and the REST API. No test opens
// a socket or reaches a Mattermost server.
// ---------------------------------------------------------------------------

class FakeSocket implements MattermostSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  private onCloseHandler: ((code?: number, reason?: string) => void) | null = null;
  private onErrorHandler: ((error: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
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
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
  authChallenge(): Record<string, unknown> | undefined {
    return this.frames().find((frame) => frame.action === "authentication_challenge");
  }
}

class FakeFactory {
  readonly created: FakeSocket[] = [];
  readonly urls: string[] = [];
  factory: MattermostSocketFactory = (url) => {
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

class MemoryHandledStore implements MattermostInboundHandledStore {
  private readonly ids = new Set<string>();
  async has(id: string): Promise<boolean> {
    return this.ids.has(id);
  }
  async record(id: string): Promise<void> {
    this.ids.add(id);
  }
}

function identity(userId = "bot-user"): { lookup: MattermostIdentityLookup; tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    lookup: async (token: string) => {
      tokens.push(token);
      return { ok: true, userId };
    },
  };
}

type Fixture = {
  client: MattermostSocketClient;
  factory: FakeFactory;
  handled: MemoryHandledStore;
  messages: InboundMessage[];
  audit: MattermostInboundAuditEntry[];
};

function buildClient(overrides: Partial<{ handled: MemoryHandledStore; token: string }> = {}): Fixture {
  const factory = new FakeFactory();
  const handled = overrides.handled ?? new MemoryHandledStore();
  const messages: InboundMessage[] = [];
  const audit: MattermostInboundAuditEntry[] = [];
  const client = new MattermostSocketClient({
    token: overrides.token ?? "mattermost-access-token-SECRET",
    resolveIdentity: identity().lookup,
    connect: factory.factory,
    url: "wss://chat.example.com/api/v4/websocket",
    handled,
    onMessage: async (message) => {
      messages.push(message);
    },
    audit: (entry) => audit.push(entry),
  });
  return { client, factory, handled, messages, audit };
}

function posted(options: {
  id?: string;
  channelId?: string;
  message?: string;
  userId?: string;
  rootId?: string;
  type?: string;
  asObject?: boolean;
  seq?: number;
} = {}): Record<string, unknown> {
  const post = {
    id: options.id ?? "post-1",
    channel_id: options.channelId ?? "chan-1",
    user_id: options.userId ?? "human-1",
    message: options.message ?? "/turn hi",
    root_id: options.rootId ?? "",
    type: options.type ?? "",
  };
  return {
    event: "posted",
    seq: options.seq ?? 1,
    data: { post: options.asObject === true ? post : JSON.stringify(post) },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Handshake and identity
// ---------------------------------------------------------------------------

describe("mattermost handshake", () => {
  it("authenticates with the access token in its own frame", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    const challenge = fixture.factory.last.authChallenge();
    expect(challenge).toBeDefined();
    expect(challenge?.data).toEqual({ token: "mattermost-access-token-SECRET" });
    // The credential is not in the websocket URL.
    expect(fixture.factory.urls[0]).toBe("wss://chat.example.com/api/v4/websocket");
    expect(fixture.factory.urls[0]).not.toContain("SECRET");
  });

  it("accepts the platform's OK answer and refuses a FAIL", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver({ status: "OK", seq_reply: 1 });
    await flush();
    expect(fixture.client.isReady).toBe(true);

    const refused = buildClient();
    await refused.client.connect();
    refused.factory.last.deliver({ status: "FAIL", seq_reply: 1 });
    await flush();
    expect(refused.audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
    expect(refused.audit.some((entry) => entry.kind === "disconnect")).toBe(true);
  });

  it("never puts the token in a refused identity lookup's error or audit", async () => {
    const factory = new FakeFactory();
    const audit: MattermostInboundAuditEntry[] = [];
    const client = new MattermostSocketClient({
      token: "mattermost-access-token-SECRET",
      resolveIdentity: async () => ({ ok: false, error: "the identity lookup answered HTTP 401" }),
      connect: factory.factory,
      url: "wss://chat.example.com/api/v4/websocket",
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
// Inbound normalisation
// ---------------------------------------------------------------------------

describe("mattermost inbound posts", () => {
  it("turns one foreign post into exactly one inbound turn", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver({ status: "OK", seq_reply: 1 });
    fixture.factory.last.deliver(posted({ id: "p-42", channelId: "chan-9", message: "/turn hi" }));
    await flush();

    expect(fixture.messages).toEqual([
      { messageId: "p-42", chatId: "chan-9", text: "/turn hi" },
    ]);
    expect(fixture.audit.filter((entry) => entry.kind === "processed")).toHaveLength(1);
  });

  it("accepts a post delivered as an object as well as a string", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver({ status: "OK", seq_reply: 1 });
    fixture.factory.last.deliver(posted({ id: "p-object", asObject: true }));
    await flush();
    expect(fixture.messages.map((message) => message.messageId)).toEqual(["p-object"]);
  });

  it("ignores the bot's own post, a system post and empty text", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver({ status: "OK", seq_reply: 1 });
    fixture.factory.last.deliver(posted({ id: "own", userId: "bot-user" }));
    fixture.factory.last.deliver(posted({ id: "system", type: "system_join_channel" }));
    fixture.factory.last.deliver(posted({ id: "empty", message: "  " }));
    await flush();

    expect(fixture.messages).toEqual([]);
    const reasons = fixture.audit
      .filter((entry) => entry.kind === "filtered")
      .map((entry) => (entry.kind === "filtered" ? entry.reason : ""));
    expect(reasons).toContain("post is the client's own");
    expect(reasons).toContain("post is a system event");
    expect(reasons).toContain("post carries no text");
  });

  it("delivers a redelivered post id once", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    fixture.factory.last.deliver({ status: "OK", seq_reply: 1 });
    fixture.factory.last.deliver(posted({ id: "p-dup" }));
    await flush();
    fixture.factory.last.deliver(posted({ id: "p-dup" }));
    await flush();
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.audit.some((entry) => entry.kind === "duplicate")).toBe(true);
  });

  it("classifies a plain post and refuses the shapes the driver must never see", () => {
    expect(classifyMattermostPost({ id: "1", channel_id: "c", user_id: "u", message: "hi", type: "" }, null)).toEqual({
      accepted: true,
      message: { messageId: "1", chatId: "c", text: "hi" },
    });
    expect(classifyMattermostPost({ id: "1", channel_id: "c", user_id: "bot", message: "hi" }, "bot").accepted).toBe(false);
    expect(classifyMattermostPost({ id: "1", channel_id: "c", user_id: "u", message: "hi", type: "x" }, null).accepted).toBe(false);
    expect(classifyMattermostPost({ channel_id: "c", user_id: "u", message: "hi" }, null).accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconnect: a fresh handshake, no duplicate subscription, no re-delivery
// ---------------------------------------------------------------------------

describe("mattermost reconnect", () => {
  it("reconnects without duplicating the subscription or a post", async () => {
    const factory = new FakeFactory();
    const handled = new MemoryHandledStore();
    const messages: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createMattermostInboundPushTransport({
      client: {
        token: "mattermost-access-token-SECRET",
        resolveIdentity: identity().lookup,
        connect: factory.factory,
        url: "wss://chat.example.com/api/v4/websocket",
        handled,
        audit: () => {},
      },
      wait: async () => undefined,
    });
    const done = transport.start(async (message) => {
      messages.push(message);
    }, controller.signal);

    for (let i = 0; i < 20 && factory.created.length < 1; i += 1) await flush();
    factory.last.deliver({ status: "OK", seq_reply: 1 });
    factory.last.deliver(posted({ id: "p-1" }));
    await flush();
    expect(messages).toHaveLength(1);

    factory.last.serverClose();
    for (let i = 0; i < 40 && factory.created.length < 2; i += 1) await flush();
    expect(factory.created).toHaveLength(2);
    // A second connection authenticates afresh; it has no resume state, so it
    // cannot replay a subscription the first one held.
    expect(factory.last.authChallenge()).toBeDefined();
    factory.last.deliver({ status: "OK", seq_reply: 1 });
    factory.last.deliver(posted({ id: "p-1" }));
    await flush();
    expect(messages).toHaveLength(1);

    controller.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------
// Outbound: REST, thread id, chunking, order, token hygiene
// ---------------------------------------------------------------------------

describe("mattermost replies", () => {
  it("posts to the REST API with the channel, the thread and the bearer token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const sender = createMattermostSender({
      token: "mattermost-access-token-SECRET",
      endpoint: "https://chat.example.com",
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return {
          status: 201,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: "posted-1" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const result = await sender.send({ channelId: "chan-1", rootId: "root-9" }, "hello");
    expect(result).toEqual({ ok: true, sent: 1, ids: ["posted-1"] });
    expect(requests[0]?.url).toBe("https://chat.example.com/api/v4/posts");
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mattermost-access-token-SECRET");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      channel_id: "chan-1",
      message: "hello",
      root_id: "root-9",
    });
  });

  it("pins Mattermost's default post limit", () => {
    expect(MATTERMOST_POST_LIMIT).toBe(16_383);
  });

  it("chunks at the post limit, keeps the thread on every chunk and preserves order", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const sender = createMattermostSender({
      token: "mattermost-access-token-SECRET",
      endpoint: "https://chat.example.com",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return {
          status: 201,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: `id-${bodies.length}` }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const text = `${"a".repeat(MATTERMOST_POST_LIMIT - 1)}\n${"b".repeat(500)}\n${"c".repeat(10)}`;
    const result = await sender.send({ channelId: "chan-1", rootId: "root-9" }, text);
    expect(result.ok).toBe(true);
    expect(result.sent).toBe(2);
    expect(bodies.map((body) => body.message).join("")).toBe(text);
    for (const body of bodies) {
      expect(String(body.message).length).toBeLessThanOrEqual(MATTERMOST_POST_LIMIT);
      expect(body.root_id).toBe("root-9");
    }
  });

  it("omits the thread id for a channel-level reply", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const sender = createMattermostSender({
      token: "mattermost-access-token-SECRET",
      endpoint: "https://chat.example.com",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return {
          status: 201,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: "x" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await sender.send({ channelId: "chan-1" }, "hello");
    expect("root_id" in (bodies[0] ?? {})).toBe(false);
  });

  it("waits out a rate limit and reports a refusal without the token", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sender = createMattermostSender({
      token: "mattermost-access-token-SECRET",
      endpoint: "https://chat.example.com",
      wait: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 429,
            ok: false,
            headers: new Headers({ "retry-after": "2" }),
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          status: 201,
          ok: true,
          headers: new Headers(),
          json: async () => ({ id: "ok" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect(await sender.send({ channelId: "chan-1" }, "hello")).toEqual({
      ok: true,
      sent: 1,
      ids: ["ok"],
    });
    expect(waits).toEqual([2000]);

    const refused = createMattermostSender({
      token: "mattermost-access-token-SECRET",
      endpoint: "https://chat.example.com",
      fetchImpl: (async () => ({
        status: 403,
        ok: false,
        headers: new Headers(),
        json: async () => ({ message: "forbidden", token: "mattermost-access-token-SECRET" }),
      })) as unknown as typeof fetch,
    });
    const result = await refused.send({ channelId: "chan-1" }, "hello");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("derives the websocket URL from the configured server and refuses a bad one", () => {
    expect(mattermostWebSocketUrl("https://chat.example.com")).toEqual({
      ok: true,
      url: "wss://chat.example.com/api/v4/websocket",
    });
    expect(mattermostWebSocketUrl("https://chat.example.com/team", {})).toEqual({
      ok: true,
      url: "wss://chat.example.com/team/api/v4/websocket",
    });
    // Plaintext to the LAN needs the relaxed policy, like every other channel.
    expect(mattermostWebSocketUrl("http://192.168.1.5:8065").ok).toBe(false);
    expect(mattermostWebSocketUrl("http://192.168.1.5:8065", { allowInsecureHttp: true })).toEqual({
      ok: true,
      url: "ws://192.168.1.5:8065/api/v4/websocket",
    });
    expect(mattermostWebSocketUrl("nonsense").ok).toBe(false);
  });

  it("chunks a short post into one piece and refuses an empty one", () => {
    expect(chunkMattermostPost("hi")).toEqual(["hi"]);
    expect(chunkMattermostPost("")).toEqual([]);
  });
});
