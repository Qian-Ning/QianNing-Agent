import { describe, expect, it } from "vitest";

import { MessagingGatewayRegistry } from "./messaging-gateway-registry.js";
import {
  MESSAGING_INBOUND_START_GATES,
  MessagingInboundSupervisor,
  createMessagingInboundReadiness,
  messagingChannelForSection,
  readMessagingInboundRecordState,
  type MessagingInboundStarter,
} from "./messaging-inbound-supervisor.js";
import {
  createSlackInboundWiring,
  type HostSecretReader,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";
import {
  MESSAGING_SLACK_APP_TOKEN_SECRET_REF,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  MESSAGING_SLACK_SECTION,
} from "@pi-desktop/agent-host";
import type { MessagingGatewayChannel } from "./messaging-gateway-registry.js";

/**
 * The defect these tests pin: a channel's record could be removed, or replaced
 * with one the transport can no longer start from, while the loop that record
 * configured kept running. The panel derives `启用` from "is there a saved
 * record" and `网关` from "is a loop alive", so the two then disagreed — `已关闭`
 * beside `运行中`, with a live socket and a live credential behind it.
 *
 * Each test drives the supervisor the desktop composition root and the settings
 * write path share, and reads the gateway through the same registry the renderer
 * reads. Everything here is real code: real readiness, real gates, real registry;
 * only the loop bodies and the host surfaces are doubles.
 */

const ALL_CHANNELS = Object.keys(MESSAGING_INBOUND_START_GATES) as MessagingGatewayChannel[];

/** A record that starts, built from the gate the transport's own start checks. */
function validRecord(channel: MessagingGatewayChannel): Record<string, unknown> {
  const gate = MESSAGING_INBOUND_START_GATES[channel];
  const record: Record<string, unknown> = { format: gate.format, version: gate.version };
  for (const field of gate.fields) {
    const value = field === "allowedSenders" ? ["owner@example.com"] : `value-for-${field}`;
    // A gate field may name a nested path (`inbound.sessionId`), so the fixture
    // writes the record the same way the gate reads it.
    const path = field.split(".");
    let target = record;
    for (const part of path.slice(0, -1)) {
      const next = target[part];
      const nested =
        typeof next === "object" && next !== null ? (next as Record<string, unknown>) : {};
      target[part] = nested;
      target = nested;
    }
    target[path[path.length - 1]] = value;
  }
  return record;
}

type SettingsStore = {
  surface: HostSettingsSurface;
  write(patch: Record<string, unknown>): Promise<void>;
};

function memorySettings(initial: Record<string, unknown> = {}): SettingsStore {
  let row: Record<string, unknown> = { ...initial };
  const write = async (patch: Record<string, unknown>) => {
    row = { ...row, ...patch };
  };
  return {
    surface: {
      async read() {
        return row;
      },
      write,
    },
    write,
  };
}

type SecretsStore = {
  reader: HostSecretReader;
  values: Map<string, string>;
};

function memorySecrets(initial: Record<string, string> = {}): SecretsStore {
  const values = new Map(Object.entries(initial));
  return { values, reader: async (secretRef) => values.get(secretRef) ?? null };
}

/** What one channel's loop did: how often it started, and whether it stopped. */
type LoopLog = { starts: number; aborts: number; live: number; maxLive: number };

/**
 * A loop that runs until its signal aborts — the shape every inbound loop has.
 * The listener is attached inside `run`, which the supervisor calls
 * synchronously, so an abort that arrives first is still observed.
 */
function abortableStarter(log: LoopLog): MessagingInboundStarter {
  return (signal) => ({
    run(): Promise<void> {
      log.starts += 1;
      log.live += 1;
      log.maxLive = Math.max(log.maxLive, log.live);
      return new Promise<void>((resolve) => {
        const finish = () => {
          log.aborts += 1;
          log.live -= 1;
          resolve();
        };
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener("abort", finish, { once: true });
      });
    },
  });
}

type Harness = ReturnType<typeof harness>;

function harness(
  channels: readonly MessagingGatewayChannel[] = ALL_CHANNELS,
  options: { secrets?: Record<string, string>; records?: Record<string, unknown> } = {},
) {
  const settings = memorySettings(options.records ?? {});
  const secrets = memorySecrets(options.secrets ?? {});
  const loops = new Map<MessagingGatewayChannel, LoopLog>();
  const starters: Partial<Record<MessagingGatewayChannel, MessagingInboundStarter>> = {};
  for (const channel of channels) {
    const log: LoopLog = { starts: 0, aborts: 0, live: 0, maxLive: 0 };
    loops.set(channel, log);
    starters[channel] = abortableStarter(log);
  }
  const registry = new MessagingGatewayRegistry();
  registry.markBooted();
  const supervisor = new MessagingInboundSupervisor({
    starters,
    readiness: createMessagingInboundReadiness({
      settings: settings.surface,
      secrets: secrets.reader,
    }),
    gateway: registry,
    // Short, so a loop that refused to stop could not hang a test — but these
    // loops honour the abort, so every stop settles at once.
    stopBudgetMs: 1_000,
  });
  return { settings, secrets, loops, registry, supervisor };
}

/** A settings patch carrying one channel's record. */
function recordPatch(channel: MessagingGatewayChannel, record: unknown): Record<string, unknown> {
  return { [MESSAGING_INBOUND_START_GATES[channel].section]: record };
}

/** The secrets every gate in `channels` needs, all present. */
function secretsFor(channels: readonly MessagingGatewayChannel[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const channel of channels) {
    for (const secretRef of MESSAGING_INBOUND_START_GATES[channel].secrets) {
      values[secretRef] = "stored";
    }
  }
  return values;
}

const loop = (deps: Harness, channel: MessagingGatewayChannel): LoopLog => deps.loops.get(channel)!;

describe("messaging inbound supervisor", () => {
  it("stops the loop when the channel's record is removed, and the gateway stops reporting it", async () => {
    const deps = harness(["telegram"], {
      secrets: secretsFor(["telegram"]),
      records: recordPatch("telegram", validRecord("telegram")),
    });

    await deps.supervisor.start("telegram");
    expect(deps.supervisor.isRunning("telegram")).toBe(true);
    expect(deps.registry.snapshot().telegram).toBe(true);

    // The panel's enable toggle turns a channel off by clearing its section.
    await deps.settings.write(recordPatch("telegram", null));
    // The settings write path reconciles that channel (IPC → supervisor.reconcile).
    await deps.supervisor.reconcile("telegram");

    expect(
      deps.registry.snapshot().telegram,
      "a channel with no saved record must not report its gateway as running",
    ).toBe(false);
    expect(loop(deps, "telegram").aborts, "the loop must be stopped, not merely hidden").toBe(1);
    expect(deps.supervisor.isRunning("telegram")).toBe(false);
  });

  it("stops the loop when the record is replaced but its secret is gone", async () => {
    const deps = harness(["telegram"], {
      secrets: secretsFor(["telegram"]),
      records: recordPatch("telegram", validRecord("telegram")),
    });

    await deps.supervisor.start("telegram");
    expect(deps.registry.snapshot().telegram).toBe(true);

    // The record is edited and saved while the credential is gone: the record no
    // longer justifies a loop, so the loop it used to justify must not survive.
    deps.secrets.values.delete(MESSAGING_INBOUND_START_GATES.telegram.secrets[0]!);
    await deps.settings.write(
      recordPatch("telegram", { ...validRecord("telegram"), endpoint: "https://moved.example" }),
    );
    await deps.supervisor.reconcile("telegram");

    expect(loop(deps, "telegram").aborts).toBe(1);
    expect(loop(deps, "telegram").starts, "an unstartable record starts no replacement").toBe(1);
    expect(deps.supervisor.isRunning("telegram")).toBe(false);
    expect(deps.registry.snapshot().telegram).toBe(false);
  });

  it("applies the same teardown to every channel that starts a loop", async () => {
    const records: Record<string, unknown> = {};
    for (const channel of ALL_CHANNELS) {
      Object.assign(records, recordPatch(channel, validRecord(channel)));
    }
    const deps = harness(ALL_CHANNELS, { secrets: secretsFor(ALL_CHANNELS), records });

    await deps.supervisor.reconcileAll();
    for (const channel of ALL_CHANNELS) {
      expect(deps.supervisor.isRunning(channel), `${channel} did not start`).toBe(true);
      expect(deps.registry.snapshot()[channel], `${channel} is not reported running`).toBe(true);
    }

    // Every record goes away at once, the shape a settings round-trip could take.
    await deps.settings.write(
      Object.fromEntries(
        ALL_CHANNELS.map((channel) => [MESSAGING_INBOUND_START_GATES[channel].section, null]),
      ),
    );
    await deps.supervisor.reconcileAll();

    for (const channel of ALL_CHANNELS) {
      expect(loop(deps, channel).aborts, `${channel} kept its loop`).toBe(1);
      expect(deps.supervisor.isRunning(channel), `${channel} is still held`).toBe(false);
      expect(deps.registry.snapshot()[channel], `${channel} still reports a gateway`).toBe(false);
    }
  });

  it("restarts a channel whose record is replaced but still startable", async () => {
    const deps = harness(["telegram"], {
      secrets: secretsFor(["telegram"]),
      records: recordPatch("telegram", validRecord("telegram")),
    });
    await deps.supervisor.start("telegram");

    // Every push transport reads its record once, at start: an edited record
    // reaches the transport through a fresh loop and no other way.
    await deps.settings.write(
      recordPatch("telegram", { ...validRecord("telegram"), endpoint: "https://moved.example" }),
    );
    await deps.supervisor.reconcile("telegram");

    expect(loop(deps, "telegram").aborts).toBe(1);
    expect(loop(deps, "telegram").starts).toBe(2);
    expect(deps.supervisor.isRunning("telegram")).toBe(true);
    expect(deps.registry.snapshot().telegram).toBe(true);
  });

  it("leaves a startable channel's loop alone when the invariant is re-applied", async () => {
    const deps = harness(["telegram"], {
      secrets: secretsFor(["telegram"]),
      records: recordPatch("telegram", validRecord("telegram")),
    });
    await deps.supervisor.reconcileAll();
    await deps.supervisor.reconcileAll();

    // A settings save that does not touch the record must not churn the socket.
    expect(loop(deps, "telegram").starts).toBe(1);
    expect(loop(deps, "telegram").aborts).toBe(0);
    expect(deps.registry.snapshot().telegram).toBe(true);
  });

  it("stops every loop it owns on stopAll, the shutdown path", async () => {
    const records: Record<string, unknown> = {};
    for (const channel of ALL_CHANNELS) {
      Object.assign(records, recordPatch(channel, validRecord(channel)));
    }
    const deps = harness(ALL_CHANNELS, { secrets: secretsFor(ALL_CHANNELS), records });
    await deps.supervisor.reconcileAll();

    await deps.supervisor.stopAll();
    for (const channel of ALL_CHANNELS) {
      expect(loop(deps, channel).aborts, `${channel} outlived stopAll`).toBe(1);
      expect(deps.registry.snapshot()[channel]).toBe(false);
    }
  });

  it("never runs two loops for one channel when reconcilations overlap", async () => {
    const deps = harness(["telegram"], {
      secrets: secretsFor(["telegram"]),
      records: recordPatch("telegram", validRecord("telegram")),
    });
    await deps.supervisor.start("telegram");

    // A settings write and a general settings save can land together; both
    // reconcile the same channel. Neither may leave a second loop behind.
    await Promise.all([
      deps.supervisor.reconcile("telegram"),
      deps.supervisor.reconcile("telegram"),
      deps.supervisor.reconcileAll(),
    ]);

    expect(loop(deps, "telegram").maxLive).toBe(1);
    expect(deps.supervisor.isRunning("telegram")).toBe(true);
    expect(deps.registry.snapshot().telegram).toBe(true);
  });

  it("stops a production wiring's loop when its record is removed", async () => {
    // The tests above use a loop double. This one goes through the real driver
    // and the real Slack wiring, so the abort it observes is the one the driver
    // hands its transport — the same path the app runs.
    const settings = memorySettings({
      [MESSAGING_SLACK_SECTION]: {
        format: MESSAGING_SLACK_FORMAT,
        version: MESSAGING_SLACK_FORMAT_VERSION,
        destination: "C012345",
      },
    });
    const secrets = memorySecrets({ [MESSAGING_SLACK_APP_TOKEN_SECRET_REF]: "xapp-token" });
    const agentHost = {
      async startTurn() {},
      async stopTurn() {},
      async interruptTurn() {},
      async respondApproval() {},
      async snapshot() {
        return {};
      },
    } as unknown as MessagingInboundHostSurface;
    let started = 0;
    let aborted = 0;
    const transport = {
      async start(_onMessage: (message: never) => Promise<void>, signal: AbortSignal) {
        started += 1;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted += 1;
      },
    };
    const registry = new MessagingGatewayRegistry();
    registry.markBooted();
    const supervisor = new MessagingInboundSupervisor({
      starters: {
        slack: (signal) =>
          createSlackInboundWiring({
            agentHost,
            settings: settings.surface,
            secrets: secrets.reader,
            signal,
            transport: transport as never,
          }),
      },
      readiness: createMessagingInboundReadiness({
        settings: settings.surface,
        secrets: secrets.reader,
      }),
      gateway: registry,
      stopBudgetMs: 1_000,
    });

    await supervisor.start("slack");
    expect(started).toBe(1);
    expect(registry.snapshot().slack).toBe(true);

    await settings.write({ [MESSAGING_SLACK_SECTION]: null });
    await supervisor.reconcile("slack");

    expect(aborted, "the driver's loop must hand the abort to its transport").toBe(1);
    expect(supervisor.isRunning("slack")).toBe(false);
    expect(registry.snapshot().slack).toBe(false);
  });

  it("starts nothing for a channel with no record, and reports nothing", async () => {
    const deps = harness(["telegram"]);
    await deps.supervisor.start("telegram");

    expect(loop(deps, "telegram").starts).toBe(0);
    expect(deps.supervisor.isRunning("telegram")).toBe(false);
    expect(deps.registry.snapshot().telegram).toBe(false);
  });
});

describe("the Signal channel's supervisor gate", () => {
  it("starts the loop from its record and stops it when the record is cleared", async () => {
    const deps = harness(["signal"], {
      records: recordPatch("signal", validRecord("signal")),
    });

    await deps.supervisor.start("signal");
    expect(deps.supervisor.isRunning("signal")).toBe(true);
    expect(deps.registry.snapshot().signal).toBe(true);
    expect(loop(deps, "signal").starts).toBe(1);

    // The panel's enable toggle clears the section rather than editing it.
    await deps.settings.write(recordPatch("signal", null));
    await deps.supervisor.reconcile("signal");

    expect(loop(deps, "signal").aborts, "the poll loop must be stopped, not hidden").toBe(1);
    expect(deps.supervisor.isRunning("signal")).toBe(false);
    expect(deps.registry.snapshot().signal).toBe(false);
  });

  it("starts nothing while the record names no account", async () => {
    const gate = MESSAGING_INBOUND_START_GATES.signal;
    const withoutAccount = { ...validRecord("signal") };
    delete withoutAccount.account;
    const deps = harness(["signal"], { records: recordPatch("signal", withoutAccount) });

    await deps.supervisor.reconcileAll();

    expect(readMessagingInboundRecordState("signal", recordPatch("signal", withoutAccount))).toBe(
      "incomplete",
    );
    expect(loop(deps, "signal").starts).toBe(0);
    expect(deps.supervisor.isRunning("signal")).toBe(false);
    expect(deps.registry.snapshot().signal).toBe(false);
    expect(gate.fields).toEqual(["endpoint", "account"]);
    // The bridge token is optional, so readiness must not require one: a
    // listener on loopback normally has none.
    expect(gate.secrets).toEqual([]);
  });
});

describe("inbound record readiness", () => {
  it("names every channel's section back to its channel", () => {
    for (const channel of ALL_CHANNELS) {
      expect(messagingChannelForSection(MESSAGING_INBOUND_START_GATES[channel].section)).toBe(channel);
    }
    expect(messagingChannelForSection("messagingSomethingElse")).toBeNull();
  });

  it("keeps a webhook receiver with no bound session from listening", () => {
    // The receiver answers its HTTP request before the turn starts, so a
    // listener with no session to act on would accept events it can only drop.
    // The binding is therefore a start condition, read at `inbound.sessionId`.
    const gate = MESSAGING_INBOUND_START_GATES.webhookReceiver;
    const base = { format: gate.format, version: gate.version, port: 8787, bindAddress: "127.0.0.1" };
    const section = (inbound: unknown): Record<string, unknown> => ({
      [gate.section]: inbound === undefined ? base : { ...base, inbound },
    });

    expect(gate.fields).toEqual(["port", "inbound.sessionId"]);
    expect(readMessagingInboundRecordState("webhookReceiver", section(undefined))).toBe(
      "incomplete",
    );
    expect(readMessagingInboundRecordState("webhookReceiver", section({}))).toBe("incomplete");
    expect(readMessagingInboundRecordState("webhookReceiver", section({ sessionId: "  " }))).toBe(
      "incomplete",
    );
    expect(readMessagingInboundRecordState("webhookReceiver", section({ sessionId: "s-1" }))).toBe(
      "ready",
    );
  });

  it("reads absent, foreign, incomplete and ready records apart", () => {
    const channel: MessagingGatewayChannel = "discord";
    const gate = MESSAGING_INBOUND_START_GATES[channel];
    expect(readMessagingInboundRecordState(channel, {})).toBe("absent");
    expect(readMessagingInboundRecordState(channel, { [gate.section]: null })).toBe("absent");
    expect(
      readMessagingInboundRecordState(channel, { [gate.section]: { format: "other", version: 1 } }),
    ).toBe("foreign");
    expect(
      readMessagingInboundRecordState(channel, {
        [gate.section]: { format: gate.format, version: gate.version },
      }),
    ).toBe("incomplete");
    expect(
      readMessagingInboundRecordState(channel, { [gate.section]: validRecord(channel) }),
    ).toBe("ready");
  });
});
