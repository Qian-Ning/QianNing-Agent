import { describe, expect, it } from "vitest";

import {
  MESSAGING_SLACK_APP_TOKEN_SECRET_REF,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  type Principal,
  type SlackConnectionResult,
  type SlackOpenConnection,
  type SlackSocket,
  type SlackSocketFactory,
} from "@pi-desktop/agent-host";

import {
  createSlackInboundWiring,
  settleWithinBudget,
  type HostSettingsSurface,
  type MessagingInboundHandle,
  type MessagingInboundHostSurface,
  type MessagingInboundWiringLog,
} from "./messaging-inbound-wiring.js";

const CHAT_ID = "C-slack-1";
const SESSION_ID = "session-1";
const LINKED_PRINCIPAL: Principal = { subject: "linked-user", roles: ["controller", "approver"] };

/** A settings row in memory, merged at the top level the way `settings.set` does. */
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

/** A linked Slack section (the link and, when opted in, the session binding). */
function linkedSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_SLACK_FORMAT,
    version: MESSAGING_SLACK_FORMAT_VERSION,
    destination: CHAT_ID,
    inbound: {
      linkedPrincipal: { subject: LINKED_PRINCIPAL.subject, roles: [...LINKED_PRINCIPAL.roles] },
      ...extra,
    },
  };
}

type Routed = { operation: string; sessionId?: string };

function stubHost(routed: Routed[]): MessagingInboundHostSurface {
  const surface = {
    async startTurn(_principal: Principal, params: { sessionId: string }): Promise<unknown> {
      routed.push({ operation: "turn/start", sessionId: params.sessionId });
      return { turn: { id: "turn-1" } };
    },
    async stopTurn(): Promise<unknown> {
      return {};
    },
    async interruptTurn(): Promise<unknown> {
      return {};
    },
    async respondApproval(): Promise<void> {},
  };
  const snapshot = (async () => ({ activeTurn: { id: "turn-1" }, pendingApprovals: [] })) as unknown as
    MessagingInboundHostSurface["snapshot"];
  return { ...surface, snapshot } as MessagingInboundHostSurface;
}

/** A WebSocket client double; records its close and lets a test deliver frames. */
class FakeSocket implements SlackSocket {
  readonly sent: string[] = [];
  closed = false;
  private onMessageHandler: ((data: string) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(): void {}
  onError(): void {}
  deliver(frame: unknown): void {
    this.onMessageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
}

class FakeFactory {
  readonly created: FakeSocket[] = [];
  readonly urls: string[] = [];
  factory: SlackSocketFactory = (url) => {
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

/** The `apps.connections.open` double: answers `result`, records the tokens. */
function fakeOpen(result: SlackConnectionResult): { open: SlackOpenConnection; tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    open: async (token: string) => {
      tokens.push(token);
      return result;
    },
  };
}

function buildWiring(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  secrets: (secretRef: string) => Promise<string | null>;
  open: SlackOpenConnection;
  factory: FakeFactory;
  routed?: Routed[];
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
  wait?: (ms: number) => Promise<void>;
}) {
  const logs = options.logs ?? [];
  const log: MessagingInboundWiringLog = (level, message, data) => logs.push({ level, message, data });
  const wiring = createSlackInboundWiring({
    agentHost: stubHost(options.routed ?? []),
    settings: options.settings,
    secrets: options.secrets,
    signal: options.signal,
    openConnection: options.open,
    connect: options.factory.factory,
    // A test that exercises the reconnect path passes a yielding wait so the
    // loop relinquishes the event loop between attempts rather than spinning.
    wait: options.wait ?? (async () => {}),
    log,
  });
  return { wiring, logs };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// The config gate: the loop starts only when the app-level token is configured.
// The token is read at the external secret seam, which every test fakes.
// ---------------------------------------------------------------------------

describe("slack inbound config gate", () => {
  it("does NOT start the transport when no app-level token is configured", async () => {
    const settings = memorySettings({ messagingSlack: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    const open = fakeOpen({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" });
    const factory = new FakeFactory();
    const secretRefs: string[] = [];
    const { wiring, logs } = buildWiring({
      settings,
      signal: controller.signal,
      secrets: async (secretRef) => {
        secretRefs.push(secretRef);
        return null; // unconfigured
      },
      open: open.open,
      factory,
    });

    // The loop the composition root started resolves without opening anything.
    await expect(wiring.run()).resolves.toBeUndefined();

    // The gate: the external seam was consulted with the app-level token ref,
    // and nothing was opened — no handshake, no socket.
    expect(secretRefs).toEqual([MESSAGING_SLACK_APP_TOKEN_SECRET_REF]);
    expect(open.tokens).toEqual([]);
    expect(factory.created).toEqual([]);
    expect(factory.urls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("does NOT start the transport when the app-level token is blank", async () => {
    const settings = memorySettings({ messagingSlack: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    const open = fakeOpen({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" });
    const factory = new FakeFactory();
    const { wiring } = buildWiring({
      settings,
      signal: controller.signal,
      secrets: async () => "   ",
      open: open.open,
      factory,
    });

    await expect(wiring.run()).resolves.toBeUndefined();
    expect(open.tokens).toEqual([]);
    expect(factory.created).toEqual([]);
  });

  it("starts the transport, handshakes with the configured token, and routes a message", async () => {
    const settings = memorySettings({ messagingSlack: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    const open = fakeOpen({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" });
    const factory = new FakeFactory();
    const routed: Routed[] = [];
    const { wiring } = buildWiring({
      settings,
      signal: controller.signal,
      secrets: async () => "xapp-configured",
      open: open.open,
      factory,
      routed,
    });

    const run = wiring.run();
    await tick();

    // Configured: the handshake used the app-level token and the socket opened
    // to the returned URL.
    expect(open.tokens).toEqual(["xapp-configured"]);
    expect(factory.urls).toEqual(["wss://wss-primary.slack.com/link/?ticket=x"]);

    // A frame delivered over the socket reaches the one routing path: the link
    // names a bound session, so the command reaches an operation.
    factory.last.deliver({
      type: "events_api",
      envelope_id: "env-1",
      payload: {
        type: "event_callback",
        event_id: "Ev1",
        event: { type: "message", channel: CHAT_ID, ts: "1.1", text: "/start do it", channel_type: "im" },
      },
    });
    await tick();
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID }]);

    controller.abort();
    await run;
  });
});

// ---------------------------------------------------------------------------
// Shutdown pairing and the bounded stop.
// ---------------------------------------------------------------------------

describe("slack inbound shutdown pairing", () => {
  it("start then stop leaves no loop running and returns within its budget", async () => {
    const settings = memorySettings({ messagingSlack: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    const open = fakeOpen({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=x" });
    const factory = new FakeFactory();
    const { wiring } = buildWiring({
      settings,
      signal: controller.signal,
      secrets: async () => "xapp-configured",
      open: open.open,
      factory,
    });

    const run = wiring.run();
    await tick();
    expect(factory.created).toHaveLength(1);

    const started = Date.now();
    const handle: MessagingInboundHandle = { controller, done: run };
    controller.abort();
    await settleWithinBudget(handle.done, 2_000);

    // The stop paired with the start: the socket was closed, and the wait
    // returned well within the budget rather than hanging on the connection.
    expect(factory.last.closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not throw and stops cleanly when the handshake is refused", async () => {
    const settings = memorySettings({ messagingSlack: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    const open = fakeOpen({ ok: false, error: "invalid_auth" });
    const factory = new FakeFactory();
    const { wiring } = buildWiring({
      settings,
      signal: controller.signal,
      secrets: async () => "xapp-configured",
      open: open.open,
      factory,
      // A refused handshake reconnects; yield between attempts so the loop does
      // not spin, and keep each wait short so the test is quick.
      wait: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });

    const run = wiring.run();
    await tick();
    // Fail-safe: a refused handshake opens no socket and never throws out of the
    // loop; the owner still stops it and the wait is bounded.
    expect(open.tokens).toEqual(["xapp-configured"]);
    expect(factory.created).toEqual([]);
    controller.abort();
    await settleWithinBudget(run, 2_000);
  });
});
