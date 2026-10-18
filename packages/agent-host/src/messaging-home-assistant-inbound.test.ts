/**
 * The Home Assistant channel against an in-process fake Home Assistant.
 *
 * No port is bound and nothing leaves the process: the fake speaks Home
 * Assistant's own websocket protocol (`auth_required` first, then `auth_ok` and
 * a subscription result) and answers `POST /api/services/...` from a fake
 * `fetch`. That is what makes the handshake, the rejected token, the
 * subscription, the reconnect and the send path reproducible without a Home
 * Assistant install.
 */

import { describe, expect, it } from "vitest";

import type { IngressMessage } from "./messaging-ingress.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";
import type { HomeAssistantInboundAuditEntry } from "./messaging-home-assistant-inbound.js";
import {
  createHomeAssistantIngressAdapter,
  createHomeAssistantSender,
  HOME_ASSISTANT_EVENT_TYPE,
  HOME_ASSISTANT_MESSAGE_LIMIT,
  HOME_ASSISTANT_WEBSOCKET_PATH,
  homeAssistantApiBase,
  homeAssistantWebSocketUrl,
  normaliseHomeAssistantEvent,
  parseHomeAssistantService,
  type HomeAssistantFetch,
} from "./messaging-home-assistant-inbound.js";

// ---------------------------------------------------------------------------
// The fake Home Assistant
// ---------------------------------------------------------------------------

const TOKEN = "ha-SECRET-long-lived-token";

type Frame = Record<string, unknown>;

/** One connection the fake serves, with its own frame log. */
class FakeHomeAssistantConnection implements IngressSocket {
  readonly sent: Frame[] = [];
  readonly raw: string[] = [];
  closed = false;
  private handler: ((data: string) => void) | null = null;

  constructor(private readonly server: FakeHomeAssistant) {}

  send(data: string): void {
    this.raw.push(data);
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    this.server.receive(this, frame);
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Home Assistant speaks first: the greeting is delivered as soon as the client
   * registers its handler, exactly as the real server does on connect.
   */
  onMessage(handler: (data: string) => void): void {
    this.handler = handler;
    handler(JSON.stringify({ type: "auth_required", ha_version: "2024.1.0" }));
  }

  onClose(): void {
    // The suite closes through `drop`, which is the platform's own abrupt close.
  }

  onError(): void {}

  emit(frame: Frame): void {
    this.handler?.(JSON.stringify(frame));
  }

  drop(): void {
    this.closed = true;
  }

  get subscribed(): boolean {
    return this.sent.some((frame) => frame.type === "subscribe_events");
  }
}

class FakeHomeAssistant {
  readonly connections: FakeHomeAssistantConnection[] = [];
  /** Set to reject every token, the way a revoked one behaves. */
  rejectToken = false;
  /** Set to refuse the event subscription, the way a locked-down server does. */
  refuseSubscription = false;

  readonly factory = (): IngressSocket => {
    const connection = new FakeHomeAssistantConnection(this);
    this.connections.push(connection);
    return connection;
  };

  get latest(): FakeHomeAssistantConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error("no Home Assistant connection was opened");
    return connection;
  }

  receive(connection: FakeHomeAssistantConnection, frame: Frame): void {
    if (frame.type === "auth") {
      if (this.rejectToken || frame.access_token !== TOKEN) {
        connection.emit({ type: "auth_invalid", message: "Invalid access token or password" });
        return;
      }
      connection.emit({ type: "auth_ok", ha_version: "2024.1.0" });
      return;
    }
    if (frame.type === "subscribe_events") {
      if (this.refuseSubscription || frame.event_type !== HOME_ASSISTANT_EVENT_TYPE) {
        connection.emit({
          id: frame.id,
          type: "result",
          success: false,
          error: { code: "invalid_format", message: "unknown event type" },
        });
        return;
      }
      connection.emit({ id: frame.id, type: "result", success: true, result: null });
      return;
    }
  }

  /** Deliver one event of the subscribed type to the latest connection. */
  emitEvent(event: Frame): void {
    this.latest.emit({ id: 1, type: "event", event });
  }
}

/** The one event an automation would fire to send this agent a message. */
function messageEvent(text: string, overrides: Frame = {}): Frame {
  return {
    event_type: HOME_ASSISTANT_EVENT_TYPE,
    data: { text, ...overrides },
    origin: "LOCAL",
    time_fired: "2026-10-18T10:00:00.000000+00:00",
    context: { id: "01JCONTEXT", parent_id: null, user_id: "user-1" },
  };
}

/** A fake `fetch` that records every service call and answers with `status`. */
function fakeServiceFetch(status = 200): {
  fetchImpl: HomeAssistantFetch;
  calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as unknown,
      headers: init.headers as Record<string, string>,
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(status === 429 ? { "retry-after": "0" } : {}),
      json: async () => ({}),
    } as unknown as Response;
  }) as HomeAssistantFetch;
  return { fetchImpl, calls };
}

/** Let every promise the client queued settle, without a wall clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function durableGuard(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

function build(options: { audit?: HomeAssistantInboundAuditEntry[]; handled?: ReturnType<typeof durableGuard> } = {}) {
  const server = new FakeHomeAssistant();
  const { fetchImpl, calls } = fakeServiceFetch();
  const audit = options.audit ?? [];
  const messages: IngressMessage[] = [];
  const adapter = createHomeAssistantIngressAdapter({
    base: "https://ha.example.org",
    url: `wss://ha.example.org${HOME_ASSISTANT_WEBSOCKET_PATH}`,
    token: TOKEN,
    service: "notify.persistent_notification",
    handled: options.handled ?? durableGuard(),
    audit: (entry) => audit.push(entry),
    connect: server.factory,
    fetchImpl,
  });
  const open = async (): Promise<void> => {
    const client = adapter.openClient(async (message) => {
      messages.push(message);
    });
    await client.connect();
    await settle();
  };
  return { server, adapter, audit, messages, calls, open };
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe("home assistant websocket handshake", () => {
  it("answers auth_required, then subscribes once, and only then is connected", async () => {
    const { server, open } = build();
    await open();
    const connection = server.latest;
    // Home Assistant's own ordering: the auth frame, then one subscription.
    expect(connection.sent[0]).toEqual({ type: "auth", access_token: TOKEN });
    expect(connection.sent[1]).toEqual({
      id: 1,
      type: "subscribe_events",
      event_type: HOME_ASSISTANT_EVENT_TYPE,
    });
    expect(connection.sent).toHaveLength(2);
  });

  it("rejects the connection when the token is refused, and never subscribes", async () => {
    const audit: HomeAssistantInboundAuditEntry[] = [];
    const { server, adapter } = build({ audit });
    server.rejectToken = true;
    const client = adapter.openClient(async () => {});
    await expect(client.connect()).rejects.toThrow(/rejected the access token/);
    expect(server.latest.subscribed).toBe(false);
    expect(audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
  });

  it("rejects the connection when the subscription is refused", async () => {
    const audit: HomeAssistantInboundAuditEntry[] = [];
    const server = new FakeHomeAssistant();
    // A server that answers auth but refuses the subscription.
    server.refuseSubscription = true;
    const adapter = createHomeAssistantIngressAdapter({
      base: "https://ha.example.org",
      url: `wss://ha.example.org${HOME_ASSISTANT_WEBSOCKET_PATH}`,
      token: TOKEN,
      service: "notify.persistent_notification",
      handled: durableGuard(),
      audit: (entry) => audit.push(entry),
      connect: server.factory,
      fetchImpl: fakeServiceFetch().fetchImpl,
    });
    const client = adapter.openClient(async () => {});
    await expect(client.connect()).rejects.toThrow(/refused the event subscription/);
    expect(audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
  });

  it("reconnects with exactly one subscription per connection", async () => {
    const { server, adapter, messages } = build();
    const client = adapter.openClient(async (message) => {
      messages.push(message);
    });
    await client.connect();
    await settle();
    expect(server.connections).toHaveLength(1);
    expect(server.latest.sent.filter((frame) => frame.type === "subscribe_events")).toHaveLength(1);

    const first = server.latest;
    first.drop();
    client.close();
    await client.connect();
    await settle();

    expect(server.connections).toHaveLength(2);
    expect(server.latest.sent.filter((frame) => frame.type === "subscribe_events")).toHaveLength(1);

    // A redelivery across the reconnect is caught by the durable guard.
    server.emitEvent(messageEvent("hello after reconnect"));
    await settle();
    server.emitEvent(messageEvent("hello after reconnect"));
    await settle();
    expect(messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The inbound projection
// ---------------------------------------------------------------------------

describe("home assistant inbound events", () => {
  it("turns one event into exactly one turn", async () => {
    const { server, open, messages } = build();
    await open();
    server.emitEvent(messageEvent("/start do the thing"));
    await settle();
    expect(messages).toEqual([
      {
        messageId: "01JCONTEXT",
        chatId: "notify.persistent_notification",
        text: "/start do the thing",
      },
    ]);
  });

  it("uses the event's own conversation when it names one", async () => {
    const { server, open, messages } = build();
    await open();
    server.emitEvent(messageEvent("hi", { conversation_id: "kitchen" }));
    await settle();
    expect(messages[0]?.chatId).toBe("kitchen");
  });

  it("filters an event of another type, an empty body and an echo of its own send", async () => {
    const { server, open, messages } = build();
    await open();
    server.emitEvent({ ...messageEvent("ignored"), event_type: "state_changed" });
    server.emitEvent(messageEvent("   "));
    server.emitEvent(messageEvent("our own words", { source: "qianning" }));
    server.emitEvent(messageEvent("our own words", { direction: "outbound" }));
    await settle();
    expect(messages).toHaveLength(0);
  });

  it("does not loop its own outbound service call back in as inbound", async () => {
    const { server, adapter, open, messages, calls } = build();
    await open();
    const result = await adapter.deliver!("notify.persistent_notification", "a reply");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // The service call produced no event on the subscribed stream.
    await settle();
    expect(messages).toHaveLength(0);
    expect(server.latest.sent.filter((frame) => frame.type === "subscribe_events")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The send path
// ---------------------------------------------------------------------------

describe("home assistant service calls", () => {
  it("posts to the configured domain and service with the message in the body", async () => {
    const { adapter, open, calls } = build();
    await open();
    const result = await adapter.deliver!("notify.persistent_notification", "hello from the agent");
    expect(result).toEqual({ ok: true, sent: 1, ids: ["ha-1"] });
    expect(calls[0]?.url).toBe(
      "https://ha.example.org/api/services/notify/persistent_notification",
    );
    expect(calls[0]?.body).toEqual({ message: "hello from the agent" });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("splits a long reply at the declared limit, in order", async () => {
    const { adapter, open, calls } = build();
    await open();
    const text = `${"a long reply line that has to be split somewhere sensible\n".repeat(200)}end`;
    const result = await adapter.deliver!("notify.persistent_notification", text);
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    const pieces = calls.map((call) => (call.body as { message: string }).message);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(HOME_ASSISTANT_MESSAGE_LIMIT);
    expect(pieces.join("")).toBe(text);
  });

  it("surfaces a 401 instead of swallowing it", async () => {
    const server = new FakeHomeAssistant();
    const { fetchImpl } = fakeServiceFetch(401);
    const audit: HomeAssistantInboundAuditEntry[] = [];
    const sender = createHomeAssistantSender({
      base: "https://ha.example.org",
      service: "notify.persistent_notification",
      token: TOKEN,
      fetchImpl,
      audit: (entry) => audit.push(entry),
    });
    const result = await sender.send("hello");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/HTTP 401/);
    expect(audit.some((entry) => entry.kind === "send-failed")).toBe(true);
    expect(server.connections).toHaveLength(0);
  });

  it("surfaces a 429: it waits the platform's retry-after and then reports the refusal", async () => {
    const { fetchImpl, calls } = fakeServiceFetch(429);
    const sender = createHomeAssistantSender({
      base: "https://ha.example.org",
      service: "notify.persistent_notification",
      token: TOKEN,
      fetchImpl,
    });
    const result = await sender.send("hello");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/rate limiting/);
    expect(calls.length).toBe(5);
  });

  it("refuses a redirect rather than following it with the token", async () => {
    const { fetchImpl } = fakeServiceFetch(302);
    const sender = createHomeAssistantSender({
      base: "https://ha.example.org",
      service: "notify.persistent_notification",
      token: TOKEN,
      fetchImpl,
    });
    const result = await sender.send("hello");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/redirect \(HTTP 302\)/);
  });

  it("refuses a service name that is not domain.service", async () => {
    const { fetchImpl, calls } = fakeServiceFetch();
    const sender = createHomeAssistantSender({
      base: "https://ha.example.org",
      service: "notify persistent",
      token: TOKEN,
      fetchImpl,
    });
    const result = await sender.send("hello");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe("home assistant credential handling", () => {
  it("never puts the token in an audit record or an error", async () => {
    const audit: HomeAssistantInboundAuditEntry[] = [];
    const { server, adapter } = build({ audit });
    server.rejectToken = true;
    const errors: string[] = [];
    const client = adapter.openClient(async () => {});
    try {
      await client.connect();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const observed = JSON.stringify({ audit, errors });
    expect(observed).not.toContain(TOKEN);
    // The token still reached the server, in the frame Home Assistant defines.
    expect(server.latest.sent[0]).toEqual({ type: "auth", access_token: TOKEN });
  });

  it("never puts the token in a send failure", async () => {
    const { fetchImpl } = fakeServiceFetch(401);
    const sender = createHomeAssistantSender({
      base: "https://ha.example.org",
      service: "notify.persistent_notification",
      token: TOKEN,
      fetchImpl,
    });
    const result = await sender.send("hello");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The endpoint and the service name
// ---------------------------------------------------------------------------

describe("home assistant endpoint rules", () => {
  it("derives wss from https and appends the websocket path", () => {
    expect(homeAssistantWebSocketUrl("https://ha.example.org")).toEqual({
      ok: true,
      url: `wss://ha.example.org${HOME_ASSISTANT_WEBSOCKET_PATH}`,
    });
    expect(homeAssistantApiBase("https://ha.example.org/")).toEqual({
      ok: true,
      base: "https://ha.example.org",
    });
  });

  it("refuses plaintext to a public host and allows it on the LAN under the policy", () => {
    expect(homeAssistantWebSocketUrl("http://ha.example.org").ok).toBe(false);
    expect(homeAssistantWebSocketUrl("http://homeassistant.local:8123").ok).toBe(false);
    expect(
      homeAssistantWebSocketUrl("http://homeassistant.local:8123", { allowInsecureHttp: true }),
    ).toEqual({ ok: true, url: `ws://homeassistant.local:8123${HOME_ASSISTANT_WEBSOCKET_PATH}` });
  });

  it("refuses a URL with userinfo and a non-HTTP scheme", () => {
    expect(homeAssistantApiBase("https://token@ha.example.org").ok).toBe(false);
    expect(homeAssistantApiBase("ftp://ha.example.org").ok).toBe(false);
  });

  it("splits domain.service and refuses anything else", () => {
    expect(parseHomeAssistantService("notify.mobile_app_pixel")).toEqual({
      ok: true,
      domain: "notify",
      name: "mobile_app_pixel",
      path: "/api/services/notify/mobile_app_pixel",
    });
    expect(parseHomeAssistantService("notify/../admin").ok).toBe(false);
    expect(parseHomeAssistantService("notify").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The projection, called directly
// ---------------------------------------------------------------------------

describe("normaliseHomeAssistantEvent", () => {
  const options = { defaultConversation: "notify.persistent_notification" };

  it("prefers an explicit message id and falls back to the event's context id", () => {
    const withId = normaliseHomeAssistantEvent(messageEvent("hi", { message_id: "m-1" }), options);
    expect(withId.kind === "message" && withId.message.messageId).toBe("m-1");
    const withContext = normaliseHomeAssistantEvent(messageEvent("hi"), options);
    expect(withContext.kind === "message" && withContext.message.messageId).toBe("01JCONTEXT");
  });

  it("accepts `message` as an alias for `text`", () => {
    const normalisation = normaliseHomeAssistantEvent(
      {
        event_type: HOME_ASSISTANT_EVENT_TYPE,
        data: { message: "via message" },
        context: { id: "c-1" },
      },
      options,
    );
    expect(normalisation.kind === "message" && normalisation.message.text).toBe("via message");
  });

  it("refuses a payload that is not an object", () => {
    expect(normaliseHomeAssistantEvent(null, options).kind).toBe("filtered");
    expect(normaliseHomeAssistantEvent("event", options).kind).toBe("filtered");
  });
});
