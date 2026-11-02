import { describe, expect, it } from "vitest";

import {
  MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF,
  MESSAGING_DISCORD_FORMAT,
  MESSAGING_DISCORD_FORMAT_VERSION,
  MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATTERMOST_FORMAT,
  MESSAGING_MATTERMOST_FORMAT_VERSION,
  type DiscordGatewayResult,
  type DiscordSocket,
  type DiscordSocketFactory,
  type MattermostSocket,
  type MattermostSocketFactory,
  type Principal,
  type RacpEventEnvelope,
} from "@pi-desktop/agent-host";

import type { HostRpc } from "./host-ports.js";
import {
  createDiscordInboundWiring,
  createMattermostInboundWiring,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";
import { createMessagingOutboundRelay, MESSAGING_OUTBOUND_RELAY_PRINCIPAL, type MessagingOutboundRelayHost } from "./messaging-outbound-relay.js";

/**
 * The whole loop, on both platforms: a message arrives on the platform's own
 * transport, the Host starts a turn for it, that turn finishes, and the outbound
 * relay hands the turn's summary to the delivery ledger **under the same
 * platform's channel name**.
 *
 * No unit under test here is new. The inbound half is `createDiscordInboundWiring`
 * / `createMattermostInboundWiring` — what the composition roots build — driving
 * the one `MessagingInboundDriver`; the outbound half is
 * `createMessagingOutboundRelay` — what the same roots build — with its real
 * `MessagingRedactor`. Only the two edges are fakes: the platform sockets (a
 * scripted frame stream, as in `messaging-gateway-wiring.test.ts`) and the
 * ledger's host-RPC port (which records the `messaging.enqueue` the real Rust
 * ledger would receive).
 *
 * What this cannot reach is the ledger itself: it is host-core's, in another
 * process. The contract at that boundary is `(channel, payload)`, and it is
 * asserted on both sides —
 * `crates/host-core/src/messaging_discord/tests.rs` and
 * `messaging_mattermost/tests.rs` enqueue the same summary shape under
 * `discord` / `mattermost` through the real ledger and assert what the platform
 * receives. Together the two suites are the loop; neither alone is.
 */

const SESSION_ID = "session-1";
const LINKED: Principal = { subject: "linked-user", roles: ["controller"] };
const TURN_ID = "turn-9";
/** The reply text the scripted model turn produced; it must not cross the wire. */
const REPLY_TEXT = "the assistant reply that stays on the transcript side";

type Enqueue = { method: string; params?: Record<string, unknown> };

function memorySettings(initial: Record<string, unknown> = {}): HostSettingsSurface {
  let row: Record<string, unknown> = { ...initial };
  return {
    async read() {
      return row;
    },
    async write(patch) {
      row = { ...row, ...patch };
    },
  };
}

/** One channel's record, as the settings row carries it. */
function section(format: string, version: number, destination: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format,
    version,
    destination,
    inbound: {
      linkedPrincipal: { subject: LINKED.subject, roles: [...LINKED.roles] },
      sessionId: SESSION_ID,
    },
    ...extra,
  };
}

type Started = { sessionId: string; text: string };

/**
 * The Agent Host the two halves share: the inbound operations the driver calls,
 * the host-scope surface the relay subscribes on, and — between them — the
 * scripted model turn. `startTurn` records the input and then publishes the
 * `turn.completed` envelope the real Host publishes when a turn ends.
 */
function fakeAgentHost(options: { started: Started[]; published: RacpEventEnvelope[]; turnId?: string }) {
  const sinks: Array<{ deliver(envelope: RacpEventEnvelope): void }> = [];
  let next = 0;
  const publish = (envelope: RacpEventEnvelope): void => {
    options.published.push(envelope);
    for (const sink of sinks) sink.deliver(envelope);
  };
  const host = {
    async startTurn(principal: Principal, params: { sessionId: string; input: { text: string } }): Promise<unknown> {
      options.started.push({ sessionId: params.sessionId, text: params.input.text });
      publish({
        eventId: "evt_1",
        kind: "turn.completed",
        scope: "host",
        sessionId: params.sessionId,
        turnId: options.turnId ?? TURN_ID,
        epoch: "ep_1",
        sequence: 1,
        revision: 1,
        occurredAt: "2026-10-17T00:00:00.000Z",
        payload: { text: REPLY_TEXT },
      } as unknown as RacpEventEnvelope);
      return { turn: { id: options.turnId ?? TURN_ID } };
    },
    async stopTurn(): Promise<unknown> {
      return {};
    },
    async interruptTurn(): Promise<unknown> {
      return {};
    },
    async respondApproval(): Promise<void> {},
    async subscribe(_principal: Principal, _params: { scope: string }, sink: { deliver(envelope: RacpEventEnvelope): void }) {
      const subscriptionId = `sub-${(next += 1)}`;
      sinks.push(sink);
      return { subscriptionId, scope: "host", starting: { epoch: "ep_1", sequence: 0 }, replayComplete: true };
    },
    unsubscribe(): void {},
  };
  const snapshot = (async () => ({ activeTurn: null, pendingApprovals: [] })) as unknown as
    MessagingInboundHostSurface["snapshot"];
  return { host, surface: { ...host, snapshot } as MessagingInboundHostSurface, published: options.published };
}

/** The ledger's port: it records the `messaging.enqueue` the Rust ledger would get. */
function ledgerPort(calls: Enqueue[]): HostRpc {
  return {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      return { delivery: { id: "delivery-1", state: "pending" } } as T;
    },
  };
}

class FakeDiscordSocket implements DiscordSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(): void {}
  onError(): void {}
  deliver(frame: unknown): void {
    this.onMessageHandler?.(JSON.stringify(frame));
  }
}

class FakeMattermostSocket implements MattermostSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(): void {}
  onError(): void {}
  deliver(frame: unknown): void {
    this.onMessageHandler?.(JSON.stringify(frame));
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await tick();
}

const HELLO = { op: 10, d: { heartbeat_interval: 60_000 } };
const READY = { op: 0, s: 1, t: "READY", d: { session_id: "sess-1", user: { id: "bot-1" } } };

function discordMessage(channelId: string): Record<string, unknown> {
  return {
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: { id: "m-1", channel_id: channelId, content: "/start hello", type: 0, author: { id: "human-1" } },
  };
}

describe("a turn triggered from a messaging channel answers on that same channel", () => {
  it("Discord: an inbound message starts a turn, and that turn reaches the ledger under `discord`", async () => {
    const CHANNEL = "chan-1";
    const settings = memorySettings({
      messagingDiscord: section(MESSAGING_DISCORD_FORMAT, MESSAGING_DISCORD_FORMAT_VERSION, CHANNEL),
    });
    const started: Started[] = [];
    const published: RacpEventEnvelope[] = [];
    const { host, surface } = fakeAgentHost({ started, published });
    const calls: Enqueue[] = [];

    const controller = new AbortController();
    const sockets: FakeDiscordSocket[] = [];
    const connect: DiscordSocketFactory = () => {
      const socket = new FakeDiscordSocket();
      sockets.push(socket);
      return socket;
    };
    const lookup = async (): Promise<DiscordGatewayResult> => ({ ok: true, url: "wss://gateway.discord.test" });

    const inbound = createDiscordInboundWiring({
      agentHost: surface,
      settings,
      secrets: async (ref) => (ref === MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF ? "bot-token-SECRET" : null),
      signal: controller.signal,
      resolveGateway: lookup,
      connect,
      wait: async () => {},
    });
    const relay = createMessagingOutboundRelay({
      // The fake carries the two surfaces the roots hand it; the relay only
      // touches subscribe/unsubscribe.
      agentHost: host as unknown as MessagingOutboundRelayHost,
      settings,
      getHost: () => ledgerPort(calls),
    });
    await relay.started;
    const done = inbound.run();
    await settle();

    // The platform's message arrives on its own transport.
    const socket = sockets[sockets.length - 1]!;
    socket.deliver(HELLO);
    socket.deliver(READY);
    socket.deliver(discordMessage(CHANNEL));
    await settle();

    // The Host started the turn the message named...
    expect(started).toEqual([
      { sessionId: SESSION_ID, text: '<msg channel="discord">\nhello\n</msg>' },
    ]);
    // ...and the turn's own channel answered for it.
    expect(relay.subscribed).toEqual(["discord"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("messaging.enqueue");
    expect(calls[0]!.params?.channel).toBe("discord");
    const payload = calls[0]!.params?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "turn.completed",
      status: "completed",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      eventId: "evt_1",
    });
    // The target is the configured channel — the one the message came from, and
    // the one the ledger's Discord adapter posts to
    // (`POST /channels/<destination>/messages`).
    const row = (await settings.read()) as Record<string, unknown>;
    expect((row.messagingDiscord as Record<string, unknown>).destination).toBe(CHANNEL);
    // Structure and ids only, and no credential anywhere on the way out.
    expect(JSON.stringify(calls[0])).not.toContain(REPLY_TEXT);
    expect(JSON.stringify(calls[0])).not.toContain("bot-token-SECRET");

    controller.abort();
    await done;
    relay.stop();
    await relay.done;
  });

  it("Mattermost: an inbound post starts a turn, and that turn reaches the ledger under `mattermost`", async () => {
    const CHANNEL = "chan-1";
    const settings = memorySettings({
      messagingMattermost: section(MESSAGING_MATTERMOST_FORMAT, MESSAGING_MATTERMOST_FORMAT_VERSION, CHANNEL, {
        endpoint: "https://chat.example.com",
      }),
    });
    const started: Started[] = [];
    const published: RacpEventEnvelope[] = [];
    const { host, surface } = fakeAgentHost({ started, published });
    const calls: Enqueue[] = [];

    const controller = new AbortController();
    const sockets: FakeMattermostSocket[] = [];
    const connect: MattermostSocketFactory = () => {
      const socket = new FakeMattermostSocket();
      sockets.push(socket);
      return socket;
    };

    const inbound = createMattermostInboundWiring({
      agentHost: surface,
      settings,
      secrets: async (ref) => (ref === MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF ? "access-token-SECRET" : null),
      signal: controller.signal,
      resolveIdentity: async () => ({ ok: true, userId: "bot-user" }),
      connect,
      wait: async () => {},
    });
    const relay = createMessagingOutboundRelay({
      // The fake carries the two surfaces the roots hand it; the relay only
      // touches subscribe/unsubscribe.
      agentHost: host as unknown as MessagingOutboundRelayHost,
      settings,
      getHost: () => ledgerPort(calls),
    });
    await relay.started;
    const done = inbound.run();
    await settle();

    const socket = sockets[sockets.length - 1]!;
    socket.deliver({ status: "OK", seq_reply: 1 });
    socket.deliver({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "p-1",
          channel_id: CHANNEL,
          user_id: "human-1",
          message: "/start hello",
          create_at: 1,
        }),
      },
      broadcast: { channel_id: CHANNEL },
    });
    await settle();

    expect(started).toEqual([
      { sessionId: SESSION_ID, text: '<msg channel="mattermost">\nhello\n</msg>' },
    ]);
    expect(relay.subscribed).toEqual(["mattermost"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params?.channel).toBe("mattermost");
    const payload = calls[0]!.params?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "turn.completed",
      status: "completed",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
    });
    // The target is the configured channel, which the ledger's Mattermost
    // adapter posts to as `channel_id` (no `root_id`: a channel-level reply).
    const row = (await settings.read()) as Record<string, unknown>;
    expect((row.messagingMattermost as Record<string, unknown>).destination).toBe(CHANNEL);
    expect(JSON.stringify(calls[0])).not.toContain(REPLY_TEXT);
    expect(JSON.stringify(calls[0])).not.toContain("access-token-SECRET");

    controller.abort();
    await done;
    relay.stop();
    await relay.done;
  });

  it("subscribes as the relay's own narrow principal, never as the linked chat's", async () => {
    const settings = memorySettings({
      messagingDiscord: section(MESSAGING_DISCORD_FORMAT, MESSAGING_DISCORD_FORMAT_VERSION, "chan-1"),
    });
    const started: Started[] = [];
    const { host } = fakeAgentHost({ started, published: [] });
    const principals: Principal[] = [];
    const relay = createMessagingOutboundRelay({
      agentHost: {
        ...host,
        async subscribe(principal: Principal) {
          principals.push(principal);
          return { subscriptionId: "sub-1", scope: "host", starting: { epoch: "ep_1", sequence: 0 }, replayComplete: true } as never;
        },
      } as unknown as MessagingOutboundRelayHost,
      settings,
      getHost: () => ledgerPort([]),
    });
    await relay.started;
    expect(principals).toEqual([MESSAGING_OUTBOUND_RELAY_PRINCIPAL]);
    relay.stop();
    await relay.done;
  });
});
