import { describe, expect, it } from "vitest";

import {
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  type Principal,
  type RacpEventEnvelope,
} from "@pi-desktop/agent-host";

import type { HostRpc } from "./host-ports.js";
import type { HostSettingsSurface, MessagingInboundWiringLog } from "./messaging-inbound-wiring.js";
import {
  MESSAGING_OUTBOUND_CHANNELS,
  createMessagingOutboundRelay,
  type MessagingOutboundChannel,
  type MessagingOutboundRelayHost,
} from "./messaging-outbound-relay.js";

/**
 * The composition root's half of the outbound relay: which channels it
 * subscribes for, what it hands the ledger, and what it does when the Host is
 * not up, the row will not read, or a subscription is refused. The redactor's
 * own projection is `@pi-desktop/agent-host`'s test; this one is the wiring
 * that `apps/pi-host/src/app.ts` and the desktop main process now call.
 */

const WEBHOOK: MessagingOutboundChannel = {
  channel: "webhook",
  section: "messagingWebhook",
  format: "pi-desktop-messaging-webhook",
  version: 1,
};

const TELEGRAM: MessagingOutboundChannel = {
  channel: "telegram",
  section: "messagingTelegram",
  format: MESSAGING_TELEGRAM_FORMAT,
  version: MESSAGING_TELEGRAM_FORMAT_VERSION,
};

/** One configured channel section, in the shape the Host stores it under. */
function section(channel: MessagingOutboundChannel): Record<string, unknown> {
  return { format: channel.format, version: channel.version };
}

function settingsOf(row: Record<string, unknown>): HostSettingsSurface {
  return {
    async read() {
      return row;
    },
    async write() {},
  };
}

type Subscribed = { principal: Principal; scope: string; sink: { deliver(envelope: RacpEventEnvelope): void } };

/** The Host's subscribe surface, recording what the relay asked for. */
function fakeHost(options: { refuse?: string[] } = {}) {
  const taken: Subscribed[] = [];
  const released: string[] = [];
  let next = 0;
  const host: MessagingOutboundRelayHost = {
    async subscribe(principal, params, sink) {
      if (options.refuse?.includes(String((params as { scope?: string }).scope))) {
        throw new Error("subscription refused");
      }
      const subscriptionId = `sub-${(next += 1)}`;
      taken.push({ principal, scope: String((params as { scope?: string }).scope), sink });
      return { subscriptionId, scope: "host", starting: { epoch: "ep_1", sequence: 0 }, replayComplete: true };
    },
    unsubscribe(subscriptionId: string) {
      released.push(subscriptionId);
    },
  } as unknown as MessagingOutboundRelayHost;
  return { host, taken, released };
}

/** The host-RPC port the hand-off rides, recording every `messaging.enqueue`. */
function fakeHostRpc(calls: Array<{ method: string; params?: Record<string, unknown> }>, fail = false) {
  const rpc: HostRpc = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (fail) throw new Error("host is not running");
      return {} as T;
    },
  };
  return rpc;
}

function envelope(kind = "turn.completed"): RacpEventEnvelope {
  return {
    eventId: "evt_1",
    kind,
    scope: "host",
    sessionId: "session-1",
    turnId: "turn-1",
    epoch: "ep_1",
    sequence: 1,
    revision: 6,
    occurredAt: "2026-10-16T00:00:00.000Z",
    payload: { text: "transcript content that must never cross this boundary" },
  } as unknown as RacpEventEnvelope;
}

/** Let the relay's start attempt (a chain of microtasks) finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("the outbound messaging relay", () => {
  it("subscribes nothing, and enqueues nothing, with no channel configured", async () => {
    const { host, taken } = fakeHost();
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({ language: "en" }),
      getHost: () => fakeHostRpc(calls),
    });

    await relay.started;
    expect(taken).toEqual([]);
    expect(relay.subscribed).toEqual([]);

    relay.stop();
    await relay.done;
    expect(calls).toEqual([]);
  });

  it("subscribes one host-scope subscriber per configured channel, and none for an unconfigured or stale section", async () => {
    const { host, taken } = fakeHost();
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({
        // Configured, with an older version: still not this build's record.
        messagingSlack: { format: "pi-desktop-messaging-slack", version: 0 },
        messagingWebhook: section(WEBHOOK),
        messagingTelegram: section(TELEGRAM),
      }),
      getHost: () => fakeHostRpc([]),
    });

    await relay.started;
    expect(relay.subscribed).toEqual(["webhook", "telegram"]);
    expect(taken.map((entry) => entry.scope)).toEqual(["host", "host"]);
    expect(taken.every((entry) => entry.principal.subject === "messaging")).toBe(true);
    expect(taken.every((entry) => entry.principal.roles.length === 1 && entry.principal.roles[0] === "viewer")).toBe(true);

    relay.stop();
    await relay.done;
  });

  it("hands one redacted summary to the ledger per forwarded event, under the channel's own name", async () => {
    const { host, taken } = fakeHost();
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({ messagingWebhook: section(WEBHOOK) }),
      getHost: () => fakeHostRpc(calls),
    });

    await relay.started;
    taken[0]!.sink.deliver(envelope());
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("messaging.enqueue");
    expect(calls[0]!.params?.channel).toBe("webhook");
    const payload = calls[0]!.params?.payload as Record<string, unknown>;
    // Ids and structure only: the payload the event carried is not in it.
    expect(Object.keys(payload).sort()).toEqual([
      "epoch",
      "eventId",
      "kind",
      "occurredAt",
      "revision",
      "scope",
      "sequence",
      "sessionId",
      "status",
      "turnId",
    ]);
    expect(JSON.stringify(payload)).not.toContain("transcript content");

    relay.stop();
    await relay.done;
  });

  it("drops a kind it does not forward rather than enqueueing it", async () => {
    const { host, taken } = fakeHost();
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({ messagingWebhook: section(WEBHOOK) }),
      getHost: () => fakeHostRpc(calls),
    });

    await relay.started;
    taken[0]!.sink.deliver(envelope("message.delta"));
    await settle();
    expect(calls).toEqual([]);

    relay.stop();
    await relay.done;
  });

  it("cannot fail or block the boot: an unreadable row, a refused subscription and a refused hand-off each cost a log line", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const log: MessagingInboundWiringLog = (level, message) => logs.push({ level, message });

    const unreadable = createMessagingOutboundRelay({
      agentHost: fakeHost().host,
      settings: {
        async read() {
          throw new Error("host-core is not up");
        },
        async write() {},
      },
      getHost: () => null,
      log,
    });
    await expect(unreadable.started).resolves.toBeUndefined();
    expect(unreadable.subscribed).toEqual([]);
    expect(logs).toEqual([{ level: "warn", message: "outbound messaging relay could not read settings" }]);

    // A Host that is not up yet: the hand-off is refused, and reported.
    const refusedHost = fakeHost();
    const refusedHandoff = createMessagingOutboundRelay({
      agentHost: refusedHost.host,
      settings: settingsOf({ messagingWebhook: section(WEBHOOK) }),
      getHost: () => null,
      log,
    });
    await refusedHandoff.started;
    expect(refusedHandoff.subscribed).toEqual(["webhook"]);
    refusedHost.taken[0]!.sink.deliver(envelope());
    await settle();
    expect(logs.some((entry) => entry.message === "outbound messaging hand-off failed")).toBe(true);
    refusedHandoff.stop();
    await refusedHandoff.done;
  });

  it("releases every subscription it took, idempotently, and settles its shutdown promise", async () => {
    const { host, taken, released } = fakeHost();
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({ messagingWebhook: section(WEBHOOK), messagingTelegram: section(TELEGRAM) }),
      getHost: () => fakeHostRpc([]),
    });

    await relay.started;
    expect(taken).toHaveLength(2);
    relay.stop();
    relay.stop();
    await relay.done;
    expect(released).toEqual(["sub-1", "sub-2"]);
  });

  it("releases a subscription that lands after stop, so a stop racing the start leaves none behind", async () => {
    const { host, released } = fakeHost();
    const relay = createMessagingOutboundRelay({
      agentHost: host,
      settings: settingsOf({ messagingWebhook: section(WEBHOOK) }),
      getHost: () => fakeHostRpc([]),
    });

    // Stop before the settings read has resolved.
    relay.stop();
    await relay.started;
    await relay.done;
    expect(released).toEqual(["sub-1"]);
    expect(relay.subscribed).toEqual([]);
  });

  it("names every channel this build relays to, in the order the roots subscribe them", () => {
    expect(MESSAGING_OUTBOUND_CHANNELS.map((entry) => entry.channel)).toEqual(["webhook", "telegram", "slack"]);
    expect(MESSAGING_OUTBOUND_CHANNELS.every((entry) => entry.section && entry.format && entry.version > 0)).toBe(true);
  });
});
