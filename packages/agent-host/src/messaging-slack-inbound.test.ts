import { describe, expect, it } from "vitest";

import type { InboundMessage, MessagingInboundAuditEntry } from "./messaging-inbound.js";
import {
  MessagingInboundDriver,
  type MessagingInboundOperationSurface,
  type MessagingInboundPushTransport,
} from "./messaging-inbound.js";
import {
  classifySlackMessageEvent,
  createSlackInboundPushTransport,
  SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES,
  SlackSocketModeClient,
  type SlackConnectionResult,
  type SlackInboundAuditEntry,
  type SlackInboundHandledStore,
  type SlackSettingsSurface,
  type SlackSocket,
  type SlackSocketFactory,
} from "./messaging-slack-inbound.js";
import { createSettingsSlackHandledStore } from "./messaging-slack-store.js";

// ---------------------------------------------------------------------------
// Fakes for the two network seams and the durable guard. No test opens a socket
// or reaches Slack: the client is driven frame by frame.
// ---------------------------------------------------------------------------

class FakeSocket implements SlackSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  private onCloseHandler: ((code?: number, reason?: string) => void) | null = null;
  private onErrorHandler: ((error: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    // The client calls this on teardown; a fake records nothing further.
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

  /** Deliver a frame to the client, as the platform would. */
  deliver(frame: unknown): void {
    this.onMessageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  /** Close the connection, as the platform would. */
  serverClose(reason = "server closed"): void {
    this.onCloseHandler?.(1000, reason);
  }
  serverError(error: unknown): void {
    this.onErrorHandler?.(error);
  }
  /** The envelope ids the client has acknowledged, in order. */
  acks(): string[] {
    return this.sent
      .map((frame) => JSON.parse(frame) as { envelope_id?: string })
      .map((value) => value.envelope_id ?? "")
      .filter((id) => id.length > 0);
  }
}

class FakeFactory {
  readonly created: FakeSocket[] = [];
  readonly urls: string[] = [];
  constructor(private readonly onConnect?: (socket: FakeSocket) => void) {}
  factory: SlackSocketFactory = (url) => {
    this.urls.push(url);
    const socket = new FakeSocket();
    this.created.push(socket);
    this.onConnect?.(socket);
    return socket;
  };
  get last(): FakeSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no socket was created");
    return socket;
  }
}

function fakeOpen(result: SlackConnectionResult): { open: (token: string) => Promise<SlackConnectionResult>; tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    open: async (token: string) => {
      tokens.push(token);
      return result;
    },
  };
}

/** An in-memory guard; two clients sharing one instance model a restart. */
class MemoryHandledStore implements SlackInboundHandledStore {
  private readonly ids = new Set<string>();
  recordCalls: string[] = [];
  failRecord = false;
  hasCalls: string[] = [];
  async has(eventId: string): Promise<boolean> {
    this.hasCalls.push(eventId);
    return this.ids.has(eventId);
  }
  async record(eventId: string): Promise<void> {
    this.recordCalls.push(eventId);
    if (this.failRecord) throw new Error("durable record failed");
    this.ids.add(eventId);
  }
}

function messageEnvelope(options: {
  envelopeId?: string;
  eventId?: string;
  type?: string;
  subtype?: string | null;
  botId?: string | null;
  channelType?: string | null;
  channel?: string;
  ts?: string;
  text?: string;
}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: options.type ?? "message",
    channel: options.channel ?? "C1",
    ts: options.ts ?? "1700000000.000100",
    text: options.text ?? "/start hello",
  };
  if (options.subtype !== undefined) event.subtype = options.subtype;
  if (options.botId !== undefined) event.bot_id = options.botId;
  if (options.channelType !== undefined) event.channel_type = options.channelType;
  else event.channel_type = "im";
  return {
    type: "events_api",
    envelope_id: options.envelopeId ?? "env-1",
    payload: {
      type: "event_callback",
      event_id: options.eventId ?? "Ev1",
      event,
    },
  };
}

type ClientFixture = {
  client: SlackSocketModeClient;
  socket: FakeSocket;
  factory: FakeFactory;
  open: ReturnType<typeof fakeOpen>;
  handled: MemoryHandledStore;
  messages: InboundMessage[];
  audit: SlackInboundAuditEntry[];
};

function buildClient(overrides: Partial<{ open: SlackConnectionResult; handled: MemoryHandledStore; allowed: readonly string[] }> = {}): ClientFixture {
  const handled = overrides.handled ?? new MemoryHandledStore();
  const factory = new FakeFactory();
  const open = fakeOpen(overrides.open ?? { ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" });
  const messages: InboundMessage[] = [];
  const audit: SlackInboundAuditEntry[] = [];
  const client = new SlackSocketModeClient({
    appToken: "xapp-test",
    openConnection: open.open,
    connect: factory.factory,
    handled,
    onMessage: async (message) => {
      messages.push(message);
    },
    ...(overrides.allowed ? { allowedChannelTypes: overrides.allowed } : {}),
    audit: (entry) => audit.push(entry),
  });
  return { client, get socket() { return factory.last; }, factory, open, handled, messages, audit };
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe("slack socket mode handshake", () => {
  it("opens the connection with the app-level token and connects the WSS url", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    expect(fixture.open.tokens).toEqual(["xapp-test"]);
    expect(fixture.factory.urls).toEqual(["wss://wss-primary.slack.com/link/?ticket=x"]);
    fixture.socket.deliver({ type: "hello" });
    expect(fixture.client.isReady).toBe(true);
  });

  it("audits and throws a refused handshake, and opens no socket", async () => {
    const fixture = buildClient({ open: { ok: false, error: "invalid_auth" } });
    await expect(fixture.client.connect()).rejects.toThrow(/invalid_auth/);
    expect(fixture.factory.created).toHaveLength(0);
    expect(fixture.audit).toContainEqual({ kind: "auth-failed", error: "invalid_auth" });
  });

  it("refuses an empty token without calling the platform", async () => {
    const factory = new FakeFactory();
    const open = fakeOpen({ ok: true, url: "wss://x" });
    const client = new SlackSocketModeClient({
      appToken: "   ",
      openConnection: open.open,
      connect: factory.factory,
      handled: new MemoryHandledStore(),
      onMessage: async () => {},
    });
    await expect(client.connect()).rejects.toThrow(/empty/);
    expect(open.tokens).toHaveLength(0);
    expect(factory.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Envelope unwrap and the neutral message
// ---------------------------------------------------------------------------

describe("slack event_callback unwrap", () => {
  it("unwraps a plain message and hands the neutral shape to the handler", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame(JSON.stringify(messageEnvelope({ text: "/start do it" })));
    expect(fixture.messages).toEqual([
      { messageId: "1700000000.000100", chatId: "C1", text: "/start do it" },
    ]);
  });

  it("acks after handling, with the envelope id", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame(JSON.stringify(messageEnvelope({ envelopeId: "env-ack" })));
    expect(fixture.socket.acks()).toEqual(["env-ack"]);
  });

  it("audits a non-JSON frame and acks nothing", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame("not json");
    expect(fixture.socket.sent).toHaveLength(0);
    expect(fixture.audit).toContainEqual({ kind: "malformed-envelope", reason: "frame is not JSON" });
  });

  it("acks but does not handle an envelope with no event_callback payload", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame(
      JSON.stringify({ type: "events_api", envelope_id: "env-x", payload: { type: "slash_commands" } }),
    );
    expect(fixture.messages).toHaveLength(0);
    expect(fixture.socket.acks()).toEqual(["env-x"]);
    expect(fixture.audit).toContainEqual({
      kind: "malformed-envelope",
      reason: "payload is not an event_callback",
    });
  });
});

// ---------------------------------------------------------------------------
// Strict filters. Externally-reachable input is untrusted.
// ---------------------------------------------------------------------------

describe("strict filters", () => {
  it("ignores a message that carries a bot id", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame(JSON.stringify(messageEnvelope({ botId: "B0BOT", eventId: "EvBot" })));
    expect(fixture.messages).toHaveLength(0);
    expect(fixture.audit).toContainEqual({ kind: "filtered", reason: "message carries a bot id", channelId: "C1" });
  });

  it("ignores a message with any subtype", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    for (const subtype of ["bot_message", "message_changed", "channel_join"]) {
      await fixture.client.handleFrame(
        JSON.stringify(messageEnvelope({ subtype, eventId: `Ev-${subtype}` })),
      );
    }
    expect(fixture.messages).toHaveLength(0);
  });

  it("ignores a message from a disallowed or absent channel type", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    await fixture.client.handleFrame(
      JSON.stringify(messageEnvelope({ channelType: "app_home", eventId: "EvApp" })),
    );
    await fixture.client.handleFrame(
      JSON.stringify(messageEnvelope({ channelType: null, eventId: "EvNull" })),
    );
    expect(fixture.messages).toHaveLength(0);
    expect(fixture.audit.filter((entry) => entry.kind === "filtered")).toHaveLength(2);
  });

  it("classifySlackMessageEvent accepts the real conversation types", () => {
    for (const channelType of SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES) {
      const result = classifySlackMessageEvent(
        { type: "message", channel: "C1", ts: "1.1", text: "hi", channel_type: channelType },
        SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES,
      );
      expect(result.accepted).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Ack discipline: ack only AFTER a durable record, at-least-once.
// ---------------------------------------------------------------------------

describe("ack discipline", () => {
  it("orders handle -> durable record -> ack", async () => {
    const order: string[] = [];
    const handled = new MemoryHandledStore();
    const factory = new FakeFactory();
    const open = fakeOpen({ ok: true, url: "wss://x" });
    const client = new SlackSocketModeClient({
      appToken: "xapp-test",
      openConnection: open.open,
      connect: factory.factory,
      handled: {
        has: async (id) => {
          order.push("has");
          return handled.has(id);
        },
        record: async (id) => {
          order.push("record");
          return handled.record(id);
        },
      },
      onMessage: async () => {
        order.push("handle");
      },
    });
    await client.connect();
    await client.handleFrame(JSON.stringify(messageEnvelope({ envelopeId: "env-order" })));
    expect(factory.last.acks()).toEqual(["env-order"]);
    expect(order).toEqual(["has", "handle", "record"]);
  });

  it("does not ack when the durable record fails, so the platform redelivers", async () => {
    const handled = new MemoryHandledStore();
    handled.failRecord = true;
    const fixture = buildClient({ handled });
    await fixture.client.connect();
    await fixture.client.handleFrame(JSON.stringify(messageEnvelope({ envelopeId: "env-norecord" })));
    expect(fixture.messages).toHaveLength(1); // it was handled...
    expect(fixture.socket.acks()).toEqual([]); // ...but not durably recorded, so not acked
    expect(fixture.audit).toContainEqual({
      kind: "record-failed",
      eventId: "Ev1",
      error: "durable record failed",
    });
  });

  it("does not ack when handling throws, so the command is not lost", async () => {
    const orders = new MemoryHandledStore();
    const factory = new FakeFactory();
    const open = fakeOpen({ ok: true, url: "wss://x" });
    const client = new SlackSocketModeClient({
      appToken: "xapp-test",
      openConnection: open.open,
      connect: factory.factory,
      handled: orders,
      onMessage: async () => {
        throw new Error("host refused");
      },
    });
    await client.connect();
    await client.handleFrame(JSON.stringify(messageEnvelope({ envelopeId: "env-fail" })));
    expect(factory.last.acks()).toEqual([]);
    expect(orders.recordCalls).toEqual([]);
    expect(factory.last.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Replay guard across a restart.
// ---------------------------------------------------------------------------

describe("restart-durable replay guard", () => {
  it("recognises a redelivery after a restart and does not act on it twice", async () => {
    const shared = new MemoryHandledStore();
    const first = buildClient({ handled: shared });
    await first.client.connect();
    await first.client.handleFrame(JSON.stringify(messageEnvelope({ eventId: "EvDup", envelopeId: "env-1" })));
    expect(first.messages).toHaveLength(1);
    expect(shared.recordCalls).toEqual(["EvDup"]);

    // A restart: a brand-new client, sharing only the durable guard.
    const second = buildClient({ handled: shared });
    await second.client.connect();
    await second.client.handleFrame(JSON.stringify(messageEnvelope({ eventId: "EvDup", envelopeId: "env-2" })));
    expect(second.messages).toHaveLength(0);
    expect(second.audit).toContainEqual({ kind: "duplicate", eventId: "EvDup" });
    // A duplicate is still acked, so the platform stops redelivering it.
    expect(second.socket.acks()).toEqual(["env-2"]);
  });

  it("keeps the guard durable across a settings round trip", async () => {
    const row: { value: unknown } = { value: { messagingSlack: { format: "pi-desktop-messaging-slack", inbound: {} } } };
    const settings: SlackSettingsSurface = {
      read: async () => row.value,
      write: async (patch) => {
        row.value = { ...(row.value as Record<string, unknown>), ...patch };
      },
    };
    const store = createSettingsSlackHandledStore(settings);
    expect(await store.has("Ev1")).toBe(false);
    await store.record("Ev1");
    expect(await store.has("Ev1")).toBe(true);
    // A second store reading the same row (a fresh process) sees the id.
    const reopened = createSettingsSlackHandledStore(settings);
    expect(await reopened.has("Ev1")).toBe(true);
  });

  it("serializes concurrent records, so a burst cannot lose an entry", async () => {
    // A burst of envelopes runs `handleEnvelope` concurrently, so their records
    // race. `record` is a read-modify-write over the whole section: without
    // serialization two records that interleave start from the same snapshot
    // and the later write drops the earlier id. The review reproduced exactly
    // this: `Promise.all([record("EvA"), record("EvB")])` left only ["EvB"].
    const row: { value: unknown } = { value: { messagingSlack: { format: "pi-desktop-messaging-slack", inbound: {} } } };
    const settings: SlackSettingsSurface = {
      read: async () => row.value,
      write: async (patch) => {
        row.value = { ...(row.value as Record<string, unknown>), ...patch };
      },
    };
    const store = createSettingsSlackHandledStore(settings);
    await Promise.all([
      store.record("EvA"),
      store.record("EvB"),
      store.record("EvC"),
      store.record("EvD"),
    ]);
    expect(await store.has("EvA")).toBe(true);
    expect(await store.has("EvB")).toBe(true);
    expect(await store.has("EvC")).toBe(true);
    expect(await store.has("EvD")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The push transport and the generalized driver.
// ---------------------------------------------------------------------------

describe("slack push transport", () => {
  it("serves frames through the handler and stops on abort", async () => {
    const factory = new FakeFactory();
    const open = fakeOpen({ ok: true, url: "wss://x" });
    const received: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createSlackInboundPushTransport({
      client: {
        appToken: "xapp-test",
        openConnection: open.open,
        connect: factory.factory,
        handled: new MemoryHandledStore(),
      },
      wait: async () => {},
    });
    const running = transport.start(async (message) => {
      received.push(message);
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    factory.last.deliver(messageEnvelope({ text: "/stop", eventId: "EvT" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await running;
    expect(received).toEqual([{ messageId: "1700000000.000100", chatId: "C1", text: "/stop" }]);
  });

  it("escalates the reconnect delay across successive failures and caps it", async () => {
    // A permanently bad token fails the handshake on every attempt. The delay
    // the loop waits before the next attempt must grow (exponential) and stop
    // growing at a cap — not stay a flat second forever, which is roughly 3600
    // requests an hour to a platform that keeps refusing the credential.
    const delays: number[] = [];
    const controller = new AbortController();
    const open = fakeOpen({ ok: false, error: "invalid_auth" });
    const factory = new FakeFactory();
    const transport = createSlackInboundPushTransport({
      client: {
        appToken: "xapp-test",
        openConnection: open.open,
        connect: factory.factory,
        handled: new MemoryHandledStore(),
      },
      reconnectDelayMs: 1_000,
      wait: async (ms) => {
        delays.push(ms);
        if (delays.length >= 8) controller.abort();
      },
    });
    await transport.start(async () => {}, controller.signal);

    expect(delays).toHaveLength(8);
    // Escalation: the last delay is far above the first, not equal to it.
    expect(delays[delays.length - 1]).toBeGreaterThan(delays[0]);
    // The cap binds: equal jitter keeps every delay within [expo/2, expo], so
    // once the exponential reaches the cap the last delay sits in the top half.
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(30_000 * 0.4);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// The error path must not stall the reconnect loop: a socket `error` that is
// not followed by a `close` must still end the wait.
// ---------------------------------------------------------------------------

describe("slack socket error path", () => {
  it("ends waitForClose on a socket error, without waiting for a close frame", async () => {
    const fixture = buildClient();
    await fixture.client.connect();
    const waited = fixture.client.waitForClose();
    fixture.socket.serverError(new Error("boom"));
    await expect(waited).resolves.toBeUndefined();
    expect(fixture.audit).toContainEqual({ kind: "connect-failed", error: "boom" });
  });
});

describe("driver runs a push transport", () => {
  it("routes a push message through handleMessage and the audit sink", async () => {
    const audit: MessagingInboundAuditEntry[] = [];
    const push: MessagingInboundPushTransport = {
      async start(onMessage) {
        await onMessage({ messageId: "m-slack-1", chatId: "C-slack", text: "hello" });
      },
    };
    const driver = new MessagingInboundDriver({
      agentHost: {} as MessagingInboundOperationSurface,
      transport: push,
      readConfig: async () => ({ link: null }),
      targets: { resolve: async () => ({}) },
      audit: (entry) => audit.push(entry),
    });
    await driver.run();
    expect(audit).toContainEqual({ kind: "unlinked-chat", chatId: "C-slack", messageId: "m-slack-1" });
  });
});
