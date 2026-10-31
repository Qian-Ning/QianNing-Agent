import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AskToolResolution, PlanningStateEvent, RacpPermissionMode } from "@pi-desktop/shared";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort, PendingToolRequest } from "./approvals.js";
import {
  createAgentHostTargets,
  createTelegramInboundTransport,
  MessagingInboundDriver,
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  readInboundLink,
  validateInboundEndpoint,
  type MessagingInboundAuditEntry,
  type MessagingInboundConfig,
  type MessagingInboundCursorStore,
  type MessagingInboundOperationSurface,
  type TelegramInboundMessage,
  type TelegramInboundTransport,
  type TelegramPollResult,
} from "./messaging-inbound.js";
import {
  MemoryQueueStore,
  type Clock,
  type IdSource,
  type Principal,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
  type TurnStartRequest,
  type TurnSteerRequest,
} from "./ports.js";

// ---------------------------------------------------------------------------
// A real Agent Host over fake ports: every command the driver routes is applied
// by the same object the RACP handlers call, so the role gate, the admission
// rule, and the approval broker are the production ones.
// ---------------------------------------------------------------------------

class FixedClock implements Clock {
  constructor(public current = Date.parse("2026-09-10T00:00:00.000Z")) {}
  now(): number {
    return this.current;
  }
}

class SeqIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}

class FakeRuntime implements RuntimePort {
  prompts: TurnStartRequest[] = [];
  async prompt(request: TurnStartRequest): Promise<{ turnId: string }> {
    this.prompts.push(request);
    return { turnId: `rt_${this.prompts.length}` };
  }
  async steer(_request: TurnSteerRequest): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stop(): Promise<{ requested: boolean }> {
    return { requested: true };
  }
  async abort(): Promise<void> {}
  async respondInput(_resolution: AskToolResolution): Promise<void> {}
  isBusy(): boolean {
    return false;
  }
}

class FakeSessions implements SessionPort {
  summaries = new Map<string, SessionSummary>();
  async get(sessionId: string): Promise<SessionSummary | null> {
    return this.summaries.get(sessionId) ?? null;
  }
  async history(): Promise<{ items: never[]; hasMore: boolean }> {
    return { items: [], hasMore: false };
  }
}

class FakeApprovals implements ApprovalPort {
  resolved: Array<{ requestId: string; decision: string }> = [];
  async resolveTool(requestId: string, decision: "allow-once" | "allow-session" | "deny"): Promise<void> {
    this.resolved.push({ requestId, decision });
  }
  async resolveContract(input: { proposalId: string; action: string }): Promise<void> {
    this.resolved.push({ requestId: input.proposalId, decision: input.action });
  }
  async listPendingTools(): Promise<PendingToolRequest[]> {
    return [];
  }
}

const SESSION_ID = "session-1";
const CHAT_ID = "chat-9";
const LINKED_PRINCIPAL: Principal = { subject: "linked-user", roles: ["controller", "approver"] };

function sessionSummary(): SessionSummary {
  return {
    id: SESSION_ID,
    title: "t",
    mode: "agent",
    permissionMode: "ask",
    planningState: "inactive",
    // The bind records the linked principal as the session's owner (ADR 0325),
    // so a real bound conversation reaches its session; the fixture mirrors the
    // post-bind state rather than an unowned row.
    owner: LINKED_PRINCIPAL.subject,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

type HostFixture = {
  host: AgentHost;
  runtime: FakeRuntime;
  approvals: FakeApprovals;
  sessions: FakeSessions;
  /** Every operation the driver actually routed into, in order. */
  routed: string[];
  surface: MessagingInboundOperationSurface;
};

function buildHost(): HostFixture {
  const sessions = new FakeSessions();
  sessions.summaries.set(SESSION_ID, sessionSummary());
  const runtime = new FakeRuntime();
  const approvals = new FakeApprovals();
  const host = new AgentHost({
    runtime,
    sessions,
    approvals,
    queueStore: new MemoryQueueStore(),
    clock: new FixedClock(),
    ids: new SeqIds(),
  });
  const routed: string[] = [];
  const surface: MessagingInboundOperationSurface = {
    startTurn: (principal, params) => {
      routed.push("turn/start");
      return host.startTurn(principal, params);
    },
    stopTurn: (principal, turnId) => {
      routed.push("turn/stop");
      return host.stopTurn(principal, turnId);
    },
    interruptTurn: (principal, turnId) => {
      routed.push("turn/interrupt");
      return host.interruptTurn(principal, turnId);
    },
    respondApproval: (principal, response) => {
      routed.push("approval/respond");
      return host.respondApproval(principal, response);
    },
  };
  return { host, runtime, approvals, routed, surface, sessions };
}

function linkedSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_TELEGRAM_FORMAT,
    version: MESSAGING_TELEGRAM_FORMAT_VERSION,
    endpoint: "https://api.example.invalid",
    destination: CHAT_ID,
    inbound: {
      linkedPrincipal: { subject: LINKED_PRINCIPAL.subject, roles: [...LINKED_PRINCIPAL.roles] },
      permissionMode: "accept-edits" as RacpPermissionMode,
    },
    ...overrides,
  };
}

function inboundMessage(overrides: Partial<TelegramInboundMessage> = {}): TelegramInboundMessage {
  return { updateId: 1, messageId: "m1", chatId: CHAT_ID, text: "/start hello", ...overrides };
}

const idleTransport: TelegramInboundTransport = {
  poll: async (offset): Promise<TelegramPollResult> => ({ ok: true, messages: [], nextOffset: offset }),
};

function buildDriver(options: {
  surface: MessagingInboundOperationSurface;
  config?: MessagingInboundConfig | null;
  target?: Record<string, string>;
  audit?: MessagingInboundAuditEntry[];
}): { driver: MessagingInboundDriver; audit: MessagingInboundAuditEntry[] } {
  const audit = options.audit ?? [];
  const driver = new MessagingInboundDriver({
    channelLabel: "telegram",
    agentHost: options.surface,
    transport: idleTransport,
    readConfig: async () =>
      options.config === undefined ? { link: readInboundLink(linkedSection()) } : options.config,
    targets: { resolve: async () => options.target ?? { sessionId: SESSION_ID } },
    audit: (entry) => audit.push(entry),
    ids: new SeqIds(),
    wait: async () => {},
  });
  return { driver, audit };
}

// ---------------------------------------------------------------------------
// A small dedicated loopback HTTP server.
//
// The tree's existing loopback fixture is the Rust one
// (`crates/host-core/src/messaging_outbound/fixture.rs`). It is not reachable
// from a TypeScript test, and no shared TypeScript loopback fixture exists;
// the closest are per-test `node:http` servers with no shared contract. That
// Rust fixture also answers its status and body from single global values, so
// it cannot script a response *sequence* — and a long poll needs one, because
// the answer changes from poll to poll. So this server is written here rather
// than extending anything: it serves a queue of scripted answers, one per
// request, and records every request it saw.
// ---------------------------------------------------------------------------

type ScriptedAnswer = { status: number; body: string; headers?: Record<string, string> };

async function startScriptedServer(answers: ScriptedAnswer[]): Promise<{
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  let index = 0;
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const answer = answers[index] ?? answers[answers.length - 1] ?? { status: 200, body: '{"ok":true,"result":[]}' };
    index += 1;
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the test server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()!();
});

// ---------------------------------------------------------------------------
// The link, fail closed.
// ---------------------------------------------------------------------------

describe("readInboundLink", () => {
  it("reads the link, the principal's roles, and the out-of-band mode", () => {
    expect(readInboundLink(linkedSection())).toEqual({
      chatId: CHAT_ID,
      principal: { subject: LINKED_PRINCIPAL.subject, roles: [...LINKED_PRINCIPAL.roles] },
      permissionMode: "accept-edits",
    });
  });

  it("treats every incomplete or foreign record as not linked", () => {
    const cases: Array<[string, unknown]> = [
      ["absent", undefined],
      ["null", null],
      ["not an object", "messagingTelegram"],
      ["foreign format", linkedSection({ format: "pi-desktop-messaging-telegram-v2" })],
      ["other version", linkedSection({ version: 2 })],
      ["no destination", linkedSection({ destination: "" })],
      ["no inbound object", linkedSection({ inbound: null })],
      ["no linked principal", linkedSection({ inbound: { permissionMode: "auto" } })],
      ["blank subject", linkedSection({ inbound: { linkedPrincipal: { subject: "  ", roles: ["controller"] } } })],
      ["no roles", linkedSection({ inbound: { linkedPrincipal: { subject: "u", roles: [] } } })],
      ["roles not an array", linkedSection({ inbound: { linkedPrincipal: { subject: "u", roles: "controller" } } })],
      ["unknown roles only", linkedSection({ inbound: { linkedPrincipal: { subject: "u", roles: ["wizard"] } } })],
    ];
    for (const [name, value] of cases) {
      expect(readInboundLink(value), name).toBeNull();
    }
  });

  it("drops a mode that is not an accepted mode instead of trusting it", () => {
    const section = linkedSection({
      inbound: { linkedPrincipal: { subject: "u", roles: ["controller"] }, permissionMode: "yolo" },
    });
    expect(readInboundLink(section)).toEqual({
      chatId: CHAT_ID,
      principal: { subject: "u", roles: ["controller"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Routing into the existing operation surface, and only there.
// ---------------------------------------------------------------------------

describe("MessagingInboundDriver routing", () => {
  it("routes a linked chat's /start into the Host's turn/start", async () => {
    const { runtime, routed, surface } = buildHost();
    const { driver, audit } = buildDriver({ surface });

    const outcome = await driver.handleMessage(inboundMessage({ text: "/start  do the thing " }));

    expect(outcome).toEqual({ kind: "invoked", messageId: "m1", operation: "turn/start" });
    expect(routed).toEqual(["turn/start"]);
    expect(runtime.prompts).toHaveLength(1);
    // The command's argument reaches the turn inside the channel envelope;
    // `/start` itself is not part of it.
    expect(runtime.prompts[0].content).toBe(
      '<msg channel="telegram">\ndo the thing\n</msg>',
    );
    expect(runtime.prompts[0].principal).toEqual(LINKED_PRINCIPAL);
    expect(audit).toEqual([{ kind: "operation", messageId: "m1", operation: "turn/start" }]);
  });

  it("carries the out-of-band mode onto a contract approval, and only where it is needed", async () => {
    const { host, approvals } = buildHost();
    const proposal: PlanningStateEvent = {
      sessionId: SESSION_ID,
      state: "awaiting_approval",
      kind: "plan",
      proposalId: "proposal-1",
    };
    const open = host.approvals.fromPlanningState(proposal, {
      turnId: "rt_1",
      revision: 1,
      lifetimeMs: 60_000,
    });
    expect(open?.allowedPermissionModes).toContain("accept-edits");

    const { driver } = buildDriver({
      surface: host,
      target: { sessionId: SESSION_ID, approvalId: open!.id },
    });
    const outcome = await driver.handleMessage(inboundMessage({ messageId: "m-approve", text: "/approve" }));

    expect(outcome).toEqual({ kind: "invoked", messageId: "m-approve", operation: "approval/respond" });
    expect(approvals.resolved).toEqual([{ requestId: "proposal-1", decision: "approve" }]);

    // A tool decision needs no mode, so none is attached to it.
    const tool = host.approvals.fromToolPermission(
      { requestId: "tool-1", sessionId: SESSION_ID, toolCallId: "tc-1", toolName: "Bash", argsPreview: {}, reason: "r", risk: "low" },
      { turnId: "rt_1", revision: 1, lifetimeMs: 60_000, allowSession: false },
    );
    const { driver: denyDriver } = buildDriver({
      surface: host,
      target: { sessionId: SESSION_ID, approvalId: tool.id },
    });
    await denyDriver.handleMessage(inboundMessage({ messageId: "m-deny", text: "/deny" }));
    expect(approvals.resolved).toContainEqual({ requestId: "tool-1", decision: "deny" });
  });

  it("maps a refusal to an outcome and never reaches an operation", async () => {
    const { routed, surface } = buildHost();
    const { driver } = buildDriver({ surface });

    const outcome = await driver.handleMessage(inboundMessage({ text: "/fly away" }));

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(routed).toEqual([]);
  });

  it("turns a Host error into an outcome instead of a crash", async () => {
    const { routed, surface } = buildHost();
    // A viewer holds no role for turn/start, so the Host's own gate refuses.
    const { driver, audit } = buildDriver({
      surface,
      config: {
        link: readInboundLink(
          linkedSection({ inbound: { linkedPrincipal: { subject: "linked-user", roles: ["viewer"] } } }),
        ),
      },
    });

    const outcome = await driver.handleMessage(inboundMessage({ text: "/start hi" }));

    expect(outcome.kind).toBe("failed");
    expect(routed).toEqual(["turn/start"]);
    expect(audit.some((entry) => entry.kind === "operation-failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed link and the audit of an unlinked chat.
// ---------------------------------------------------------------------------

describe("MessagingInboundDriver unlinked chats", () => {
  it("does nothing at all for an unlinked chat and audits it", async () => {
    const { routed, surface } = buildHost();
    const { driver, audit } = buildDriver({ surface, config: { link: null } });

    const outcome = await driver.handleMessage(inboundMessage({ text: "/start hi" }));

    expect(outcome).toEqual({ kind: "unlinked", messageId: "m1" });
    expect(routed).toEqual([]);
    expect(audit).toEqual([{ kind: "unlinked-chat", chatId: CHAT_ID, messageId: "m1" }]);
  });

  it("ignores a message from a conversation that is not the linked one", async () => {
    const { routed, surface } = buildHost();
    const { driver, audit } = buildDriver({ surface });

    const outcome = await driver.handleMessage(inboundMessage({ chatId: "chat-other", text: "/start hi" }));

    expect(outcome).toEqual({ kind: "unlinked", messageId: "m1" });
    expect(routed).toEqual([]);
    expect(audit).toEqual([{ kind: "unlinked-chat", chatId: "chat-other", messageId: "m1" }]);
  });

  it("treats a host whose settings could not be read as unlinked rather than crashing", async () => {
    const { routed, surface } = buildHost();
    const { driver, audit } = buildDriver({ surface, config: null });

    const outcome = await driver.handleMessage(inboundMessage());

    expect(outcome).toEqual({ kind: "unlinked", messageId: "m1" });
    expect(routed).toEqual([]);
    expect(audit).toEqual([{ kind: "unlinked-chat", chatId: CHAT_ID, messageId: "m1" }]);
  });
});

// ---------------------------------------------------------------------------
// The replay guard: the message's own id, held in the driver, across kinds.
// ---------------------------------------------------------------------------

function replayDriver(surface: MessagingInboundOperationSurface): MessagingInboundDriver {
  return new MessagingInboundDriver({
    channelLabel: "telegram",
    agentHost: surface,
    transport: idleTransport,
    readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
    targets: { resolve: async () => ({ sessionId: SESSION_ID, turnId: "rt_1" }) },
    ids: new SeqIds(),
    wait: async () => {},
  });
}

describe("MessagingInboundDriver replay guard", () => {
  it("acts exactly once for a redelivered id, across more than one operation kind", async () => {
    const { runtime, routed, surface } = buildHost();
    const driver = replayDriver(surface);

    // Two different operation kinds, each acting once.
    expect(await driver.handleMessage(inboundMessage({ messageId: "m-start", text: "/start hello" }))).toEqual({
      kind: "invoked",
      messageId: "m-start",
      operation: "turn/start",
    });
    expect(await driver.handleMessage(inboundMessage({ messageId: "m-stop", text: "/stop" }))).toEqual({
      kind: "invoked",
      messageId: "m-stop",
      operation: "turn/stop",
    });
    expect(runtime.prompts).toHaveLength(1);
    expect(routed).toEqual(["turn/start", "turn/stop"]);

    // Each id redelivered — including with text that maps onto a *different*
    // operation — acts no second time. The request context could not have
    // covered the second kind: turn/stop carries no context at all.
    expect(await driver.handleMessage(inboundMessage({ messageId: "m-start", text: "/stop" }))).toEqual({
      kind: "duplicate",
      messageId: "m-start",
    });
    expect(await driver.handleMessage(inboundMessage({ messageId: "m-stop", text: "/interrupt" }))).toEqual({
      kind: "duplicate",
      messageId: "m-stop",
    });
    expect(runtime.prompts).toHaveLength(1);
    expect(routed).toEqual(["turn/start", "turn/stop"]);
  });

  it("guards an approval decision too, where the response context is read nowhere", async () => {
    const { host, routed, surface, approvals } = buildHost();
    host.approvals.fromToolPermission(
      { requestId: "tool-1", sessionId: SESSION_ID, toolCallId: "tc-1", toolName: "Bash", argsPreview: {}, reason: "r", risk: "low" },
      { turnId: "rt_1", revision: 1, lifetimeMs: 60_000, allowSession: false },
    );
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: idleTransport,
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID, approvalId: "tool-1" }) },
      ids: new SeqIds(),
      wait: async () => {},
    });

    const first = await driver.handleMessage(inboundMessage({ messageId: "m-a", text: "/deny" }));
    const again = await driver.handleMessage(inboundMessage({ messageId: "m-a", text: "/allow-once" }));

    expect(first.kind, JSON.stringify(first)).toBe("invoked");
    expect(approvals.resolved).toEqual([{ requestId: "tool-1", decision: "deny" }]);
    // A redelivery that names a *different* decision changes nothing: the
    // response context is read by nothing on this path, so only the guard stops it.
    expect(again).toEqual({ kind: "duplicate", messageId: "m-a" });
    expect(routed).toEqual(["approval/respond"]);
  });

  it("keys the guard on the conversation, so a message id reused in another chat is not a duplicate", async () => {
    const { routed, surface } = buildHost();
    let linkedChat = CHAT_ID;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: idleTransport,
      readConfig: async () => ({ link: { chatId: linkedChat, principal: LINKED_PRINCIPAL } }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID, turnId: "rt_1" }) },
      ids: new SeqIds(),
      wait: async () => {},
    });

    expect(
      await driver.handleMessage(inboundMessage({ chatId: CHAT_ID, messageId: "m1", text: "/start a" })),
    ).toEqual({ kind: "invoked", messageId: "m1", operation: "turn/start" });
    // The same message id in another conversation is not the same message, so it
    // is handled rather than dismissed as a duplicate of the first.
    linkedChat = "chat-other";
    expect(
      await driver.handleMessage(inboundMessage({ chatId: "chat-other", messageId: "m1", text: "/stop" })),
    ).toEqual({ kind: "invoked", messageId: "m1", operation: "turn/stop" });
    expect(routed).toEqual(["turn/start", "turn/stop"]);
  });

  it("records the key only after the link check, so an unlinked message leaves no guard entry", async () => {
    const { routed, surface } = buildHost();
    // The unlinked copies share the accepted message's chat *and* id, so their
    // key would be the accepted message's key. Recording such a copy before the
    // link check would make the later accepted message a duplicate; the guard
    // must record only after the link check. Both unlinked shapes are exercised:
    // no conversation linked, and a conversation other than this one linked.
    let link: { chatId: string; principal: Principal } | null = null;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: idleTransport,
      readConfig: async () => ({ link }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID, turnId: "rt_1" }) },
      ids: new SeqIds(),
      wait: async () => {},
    });

    expect(
      await driver.handleMessage(inboundMessage({ chatId: CHAT_ID, messageId: "m1", text: "/start hi" })),
    ).toEqual({ kind: "unlinked", messageId: "m1" });
    link = { chatId: "chat-other", principal: LINKED_PRINCIPAL };
    expect(
      await driver.handleMessage(inboundMessage({ chatId: CHAT_ID, messageId: "m1", text: "/start hi" })),
    ).toEqual({ kind: "unlinked", messageId: "m1" });

    // The linked conversation's message with that same chat and id must now act:
    // neither unlinked copy left a guard entry behind.
    link = { chatId: CHAT_ID, principal: LINKED_PRINCIPAL };
    expect(
      await driver.handleMessage(inboundMessage({ chatId: CHAT_ID, messageId: "m1", text: "/start hi" })),
    ).toEqual({ kind: "invoked", messageId: "m1", operation: "turn/start" });
    expect(routed).toEqual(["turn/start"]);
  });
});

// ---------------------------------------------------------------------------
// The poll cursor survives a restart; the guard does not.
// ---------------------------------------------------------------------------

class MemoryCursorStore implements MessagingInboundCursorStore {
  saved: number | null = null;
  async load(): Promise<number | null> {
    return this.saved;
  }
  async save(offset: number): Promise<void> {
    this.saved = offset;
  }
}

describe("MessagingInboundDriver poll cursor", () => {
  it("persists the poll cursor as a poll advances it", async () => {
    const { surface } = buildHost();
    const store = new MemoryCursorStore();
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: { poll: async () => ({ ok: true, messages: [], nextOffset: 42 }) },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: store,
      ids: new SeqIds(),
      wait: async () => {},
    });

    await driver.pollOnce();

    expect(store.saved).toBe(42);
  });

  it("resumes from the stored cursor after a restart instead of replaying from zero", async () => {
    const { runtime, routed, surface } = buildHost();
    const store = new MemoryCursorStore();
    const first = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async () => ({
          ok: true,
          messages: [inboundMessage({ updateId: 41, messageId: "m-one", text: "/start first" })],
          nextOffset: 42,
        }),
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: store,
      ids: new SeqIds(),
      wait: async () => {},
    });

    await first.pollOnce();
    expect(store.saved).toBe(42);
    expect(routed).toEqual(["turn/start"]);

    // A restart: a fresh driver over the same store. A poll asking from zero
    // would be handed the last day's redelivered updates; asked from 42 the
    // platform has nothing left to redeliver, so the command does not run again.
    const seen: number[] = [];
    const controller = new AbortController();
    const second = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (offset) => {
          seen.push(offset);
          controller.abort();
          const messages =
            offset === 0
              ? [inboundMessage({ updateId: 41, messageId: "m-one", text: "/start first" })]
              : [];
          return { ok: true, messages, nextOffset: offset };
        },
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: store,
      ids: new SeqIds(),
      wait: async () => {},
    });

    await second.run(controller.signal);

    expect(seen).toEqual([42]);
    expect(routed).toEqual(["turn/start"]);
    expect(runtime.prompts).toHaveLength(1);
  });

  it("applies the batch before it advances and saves the cursor, so a crash cannot drop a command", async () => {
    const { surface } = buildHost();
    const store = new MemoryCursorStore();
    const order: string[] = [];
    const recordingSurface: MessagingInboundOperationSurface = {
      ...surface,
      startTurn: (principal, params) => {
        order.push("apply");
        return surface.startTurn(principal, params);
      },
    };
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: recordingSurface,
      transport: {
        poll: async () => ({
          ok: true,
          messages: [inboundMessage({ updateId: 1, messageId: "m-one", text: "/start first" })],
          nextOffset: 2,
        }),
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: {
        load: async () => null,
        save: async (offset) => {
          order.push("save");
          await store.save(offset);
        },
      },
      ids: new SeqIds(),
      wait: async () => {},
    });

    await driver.pollOnce();

    // The command is applied before the cursor that records it as seen is saved.
    // The reverse order is at-most-once: a crash between the two drops the
    // command with no trace. This pins the order, which no other test observes.
    expect(order).toEqual(["apply", "save"]);
    expect(store.saved).toBe(2);
  });

  it("never moves the persisted cursor backwards", async () => {
    const { surface } = buildHost();
    const store = new MemoryCursorStore();
    let next = 10;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: { poll: async () => ({ ok: true, messages: [], nextOffset: next }) },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: store,
      ids: new SeqIds(),
      wait: async () => {},
    });

    await driver.pollOnce();
    expect(driver.nextOffset).toBe(10);
    expect(store.saved).toBe(10);

    // A transport that answers a lower offset must not drag the cursor back and
    // make the platform replay updates this run has already handled.
    next = 4;
    await driver.pollOnce();
    expect(driver.nextOffset).toBe(10);
    expect(store.saved).toBe(10);
  });

  it("audits a cursor save that fails instead of swallowing it", async () => {
    const { surface } = buildHost();
    const audit: MessagingInboundAuditEntry[] = [];
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: { poll: async () => ({ ok: true, messages: [], nextOffset: 3 }) },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      cursor: {
        load: async () => null,
        save: async () => {
          throw new Error("the settings row could not be written");
        },
      },
      audit: (entry) => audit.push(entry),
      ids: new SeqIds(),
      wait: async () => {},
    });

    await driver.pollOnce();

    expect(audit).toContainEqual({
      kind: "cursor-save-failed",
      error: "the settings row could not be written",
    });
  });
});

// ---------------------------------------------------------------------------
// The poll loop: failures and the lock rule.
// ---------------------------------------------------------------------------

describe("MessagingInboundDriver poll loop", () => {
  it("survives a failed poll and keeps the host usable", async () => {
    const { runtime, surface } = buildHost();
    const audit: MessagingInboundAuditEntry[] = [];
    const controller = new AbortController();
    let polls = 0;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (): Promise<TelegramPollResult> => {
          polls += 1;
          if (polls >= 3) controller.abort();
          return { ok: false, error: "the channel answered 503" };
        },
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      audit: (entry) => audit.push(entry),
      ids: new SeqIds(),
      wait: async () => {},
    });

    await expect(driver.run(controller.signal)).resolves.toBeUndefined();

    expect(polls).toBe(3);
    expect(audit.filter((entry) => entry.kind === "poll-failed")).toHaveLength(3);
    // The Host is still there: a command after the failed polls still lands.
    await driver.handleMessage(inboundMessage({ text: "/start after the outage" }));
    expect(runtime.prompts).toHaveLength(1);
  });

  it("holds no host state across the poll: a command completes while a poll is in flight", async () => {
    const { runtime, surface } = buildHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (): Promise<TelegramPollResult> => {
          await gate;
          return { ok: true, messages: [], nextOffset: 0 };
        },
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      ids: new SeqIds(),
      wait: async () => {},
    });

    const poll = driver.pollOnce();
    // With the poll outstanding, a command must still run to completion. If the
    // driver held anything across the poll, this would never settle.
    await driver.handleMessage(inboundMessage({ text: "/start during the poll" }));
    expect(runtime.prompts).toHaveLength(1);

    release();
    await expect(poll).resolves.toEqual({ polled: true, outcomes: [] });
  });

  it("advances the cursor and applies every message a poll returns", async () => {
    const { routed, surface } = buildHost();
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (): Promise<TelegramPollResult> => ({
          ok: true,
          messages: [inboundMessage({ updateId: 7, messageId: "m-one", text: "/start first" })],
          nextOffset: 8,
        }),
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      ids: new SeqIds(),
      wait: async () => {},
    });

    const result = await driver.pollOnce();

    expect(driver.nextOffset).toBe(8);
    expect(result.polled).toBe(true);
    expect(routed).toEqual(["turn/start"]);
  });

  it("waits a minimum interval even when a poll returns an answer immediately", async () => {
    const { surface } = buildHost();
    const controller = new AbortController();
    const waits: number[] = [];
    let polls = 0;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (offset): Promise<TelegramPollResult> => {
          polls += 1;
          if (polls >= 2) controller.abort();
          return { ok: true, messages: [], nextOffset: offset };
        },
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      ids: new SeqIds(),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    await driver.run(controller.signal);

    expect(polls).toBe(2);
    // A fast-returning answer must not let the loop poll again with no pause.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it("honours a platform back-off a refused poll carried", async () => {
    const { surface } = buildHost();
    const controller = new AbortController();
    const waits: number[] = [];
    let polls = 0;
    const driver = new MessagingInboundDriver({
      channelLabel: "telegram",
      agentHost: surface,
      transport: {
        poll: async (): Promise<TelegramPollResult> => {
          polls += 1;
          if (polls >= 2) controller.abort();
          return { ok: false, error: "the channel refused the poll: Too Many Requests", retryAfterMs: 7_000 };
        },
      },
      readConfig: async () => ({ link: readInboundLink(linkedSection()) }),
      targets: { resolve: async () => ({ sessionId: SESSION_ID }) },
      ids: new SeqIds(),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    await driver.run(controller.signal);

    expect(waits).toEqual([7_000]);
  });
});

// ---------------------------------------------------------------------------
// The outbound long-poll transport, against the scripted loopback server.
// ---------------------------------------------------------------------------

describe("createTelegramInboundTransport", () => {
  it("long-polls by outbound HTTP and maps the updates it reads", async () => {
    const server = await startScriptedServer([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [
            { update_id: 41, message: { message_id: 900, chat: { id: 9 }, text: "/start hi" } },
            { update_id: 42, message: { message_id: 901, chat: { id: 9 } } },
            { update_id: 43, edited_message: { message_id: 902 } },
          ],
        }),
      },
    ]);
    running.push(server.close);
    const transport = createTelegramInboundTransport({
      endpoint: server.origin,
      token: "test-token",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: true,
    });

    const result = await transport.poll(41);

    expect(result).toEqual({
      ok: true,
      messages: [
        { updateId: 41, messageId: "900", chatId: "9", text: "/start hi" },
        { updateId: 42, messageId: "901", chatId: "9", text: "" },
      ],
      nextOffset: 44,
    });
    expect(server.requests[0]).toContain("offset=41");
    expect(server.requests[0]).toContain("/bottest-token/getUpdates");
  });

  it("gets successive answers from successive polls", async () => {
    const server = await startScriptedServer([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [{ update_id: 1, message: { message_id: 10, chat: { id: 9 }, text: "/start a" } }],
        }),
      },
      { status: 200, body: JSON.stringify({ ok: true, result: [] }) },
    ]);
    running.push(server.close);
    const transport = createTelegramInboundTransport({ endpoint: server.origin, token: "t", requestTimeoutMs: 5_000, allowInsecureHttp: true });

    const first = await transport.poll(0);
    const second = await transport.poll(2);

    expect(first).toMatchObject({ ok: true, nextOffset: 2 });
    expect(second).toEqual({ ok: true, messages: [], nextOffset: 2 });
  });

  it("reports a non-2xx, an unreadable body, and a refused poll as failures, never as throws", async () => {
    const server = await startScriptedServer([
      { status: 503, body: "nope" },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ ok: false, description: "conflict" }) },
    ]);
    running.push(server.close);
    const transport = createTelegramInboundTransport({ endpoint: server.origin, token: "t", requestTimeoutMs: 5_000, allowInsecureHttp: true });

    await expect(transport.poll(0)).resolves.toEqual({ ok: false, error: "the channel answered HTTP 503" });
    await expect(transport.poll(0)).resolves.toMatchObject({ ok: false });
    const refused = await transport.poll(0);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false ? refused.error : "").toContain("conflict");
  });

  it("keeps the token out of every failure it reports", async () => {
    const server = await startScriptedServer([{ status: 400, body: "bad" }]);
    running.push(server.close);
    const secret = "123456:SUPER-SECRET-TOKEN";
    const transport = createTelegramInboundTransport({ endpoint: server.origin, token: secret, requestTimeoutMs: 5_000, allowInsecureHttp: true });

    const result = await transport.poll(0);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refuses to poll with an empty token rather than posting nowhere", async () => {
    const transport = createTelegramInboundTransport({
      endpoint: "https://api.example.invalid",
      token: "  ",
      requestTimeoutMs: 1_000,
    });
    await expect(transport.poll(0)).resolves.toEqual({ ok: false, error: "the configured bot token is empty" });
  });

  it("does not follow a redirect that would carry the token to another host", async () => {
    const target = await startScriptedServer([{ status: 200, body: '{"ok":true,"result":[]}' }]);
    const redirector = await startScriptedServer([
      { status: 302, body: "", headers: { location: `${target.origin}/bottest-token/getUpdates` } },
    ]);
    running.push(target.close, redirector.close);
    const transport = createTelegramInboundTransport({
      endpoint: redirector.origin,
      token: "test-token",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: true,
    });

    const result = await transport.poll(0);

    // The redirect is reported, not followed: the token stays on the origin it
    // was configured for, and the other host is never contacted.
    expect(result).toEqual({ ok: false, error: "the channel answered a redirect (HTTP 302)" });
    expect(target.requests).toHaveLength(0);
  });

  it("refuses a plaintext endpoint to a public host before it sends the token", async () => {
    const transport = createTelegramInboundTransport({
      endpoint: "http://api.example.invalid",
      token: "test-token",
      requestTimeoutMs: 5_000,
    });
    const relaxed = createTelegramInboundTransport({
      endpoint: "http://api.example.invalid",
      token: "test-token",
      requestTimeoutMs: 5_000,
      allowInsecureHttp: true,
    });

    expect(await transport.poll(0)).toEqual({
      ok: false,
      error: "plaintext HTTP requires the relaxed network policy",
    });
    // Even with the relaxed policy, a public host stays refused.
    const result = await relaxed.poll(0);
    expect(result).toEqual({
      ok: false,
      error: "plaintext HTTP is limited to localhost, .local, or private LAN addresses",
    });
    expect(JSON.stringify(result)).not.toContain("test-token");
  });
});

// ---------------------------------------------------------------------------
// The endpoint rule, the one the Rust channels apply.
// ---------------------------------------------------------------------------

describe("validateInboundEndpoint", () => {
  it("accepts an HTTPS endpoint and drops any query and fragment", () => {
    const result = validateInboundEndpoint("https://api.example.invalid/base?q=1#frag");
    expect(result).toEqual({ ok: true, url: new URL("https://api.example.invalid/base") });
  });

  it("refuses a non-HTTPS scheme, an address that is not a URL, and userinfo", () => {
    const cases = [
      "ftp://api.example.invalid",
      "api.telegram.org",
      "https://user:secret@api.example.invalid",
      "https://user@api.example.invalid",
    ];
    for (const endpoint of cases) {
      expect(validateInboundEndpoint(endpoint), endpoint).toMatchObject({ ok: false });
    }
  });

  it("refuses plaintext HTTP to a public host even under the relaxed policy", () => {
    expect(validateInboundEndpoint("http://api.example.invalid")).toMatchObject({ ok: false });
    expect(validateInboundEndpoint("http://api.example.invalid", { allowInsecureHttp: true })).toMatchObject({
      ok: false,
    });
    // A public literal, not just a name.
    expect(validateInboundEndpoint("http://93.184.216.34", { allowInsecureHttp: true })).toMatchObject({
      ok: false,
    });
  });

  it("accepts plaintext HTTP only to loopback, .local, or a private LAN host under the relaxed policy", () => {
    const lanEndpoints = [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://printer.local",
      "http://10.0.0.7",
      "http://172.16.5.5",
      "http://192.168.1.4",
      "http://[::1]:8080",
      "http://[fc00::1]:8080",
      "http://[fd00::9]:8080",
      "http://[fe80::1]:8080",
    ];
    for (const endpoint of lanEndpoints) {
      expect(validateInboundEndpoint(endpoint, { allowInsecureHttp: true }), endpoint).toMatchObject({ ok: true });
    }
    // Without the relaxed policy even a loopback endpoint is refused.
    expect(validateInboundEndpoint("http://127.0.0.1:8080")).toMatchObject({ ok: false });
  });

  it("refuses a mapped or compatible IPv4-in-IPv6 literal exactly as the Rust rule does", () => {
    // Rust parses these as ordinary IPv6 addresses, not as their embedded IPv4:
    // the loopback test is false and the prefix is neither ULA nor link-local, so
    // every mapped or compatible spelling is refused. The shared classifier
    // instead folds the embedded IPv4 and would accept the loopback and private
    // ones; this pins that fold as undone, so the plaintext exception is no wider
    // than the Rust side.
    expect(validateInboundEndpoint("http://[::ffff:127.0.0.1]:8080", { allowInsecureHttp: true })).toEqual({
      ok: false,
      error: "plaintext HTTP is limited to localhost, .local, or private LAN addresses",
    });
    const refused = [
      "http://[::ffff:7f00:1]:8080",
      "http://[::ffff:10.0.0.1]:8080",
      "http://[::ffff:192.168.1.1]:8080",
      "http://[::ffff:169.254.1.1]:8080",
      "http://[::10.0.0.1]:8080",
      "http://[::127.0.0.1]:8080",
      "http://[::ffff:8.8.8.8]:8080",
      "http://[0:0:0:0:0:ffff:10.0.0.1]:8080",
    ];
    for (const endpoint of refused) {
      expect(validateInboundEndpoint(endpoint, { allowInsecureHttp: true }), endpoint).toMatchObject({
        ok: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The production target resolver reads host state, not a guess.
// ---------------------------------------------------------------------------

describe("createAgentHostTargets", () => {
  it("admits the linked principal only to a session the bind recorded it as owning", async () => {
    const { host, sessions } = buildHost();
    const request = { sessionId: SESSION_ID, input: { text: "do it" }, context: { requestId: "r1" } };

    // An unowned row (every pre-existing session, and any path that names no
    // principal) is host-local: the linked principal is refused.
    sessions.summaries.set(SESSION_ID, { ...sessionSummary(), owner: undefined });
    await expect(host.startTurn(LINKED_PRINCIPAL, request)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // What the bind does: the same session now records the linked principal as
    // its owner, so the path is usable.
    sessions.summaries.set(SESSION_ID, sessionSummary());
    await expect(host.startTurn(LINKED_PRINCIPAL, { ...request, context: { requestId: "r2" } })).resolves.toMatchObject({ accepted: true });
  });

  it("resolves the session the wiring names, and nothing it does not hold", async () => {
    const { host } = buildHost();
    const targets = createAgentHostTargets(host, async () => SESSION_ID);

    const resolved = await targets.resolve(LINKED_PRINCIPAL);

    expect(resolved).toEqual({ sessionId: SESSION_ID });
  });

  it("returns no target when the wiring names no current session", async () => {
    const { host } = buildHost();
    const targets = createAgentHostTargets(host, async () => null);
    expect(await targets.resolve(LINKED_PRINCIPAL)).toEqual({});
  });
});
