import { describe, expect, it, vi } from "vitest";
import type { RacpEventEnvelope } from "@pi-desktop/shared";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort } from "./approvals.js";
import { EventHub, type SubscriptionSink } from "./event-log.js";
import {
  CARD_NOTE_LIMIT,
  FORWARDED_EVENT_KINDS,
  MESSAGING_ENQUEUE_METHOD,
  MessagingRedactor,
  isForwardedKind,
  type MessageDeliverySummary,
} from "./messaging-redactor.js";
import {
  type Clock,
  type HostRpcPort,
  type IdSource,
  type Principal,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
} from "./ports.js";

/**
 * Distinctive text planted only in transcript-bearing event payload fields
 * (message text, tool arguments, tool results). If it ever appears in what the
 * redactor hands to the ledger, raw transcript content crossed the boundary.
 */
const SENTINEL = "SENTINEL_transcript_7d2f_message_text_leak";

class FixedClock implements Clock {
  now(): number {
    return 1_700_000_000_000;
  }
}

class SeqIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}

/** A transcript-bearing host-scope event payload, every text field sentinel. */
function sentinelPayload(): unknown {
  return {
    message: { role: "assistant", text: SENTINEL },
    toolCall: { name: "read_file", args: { path: SENTINEL } },
    toolResult: { content: SENTINEL },
  };
}

function hub(): EventHub {
  return new EventHub({ clock: new FixedClock(), ids: new SeqIds() });
}

/**
 * Hand-publish a forwarded event straight onto an {@link EventHub}. This is a
 * unit-level convenience for exercising the redactor in isolation; it is NOT the
 * real Host publish path. The real path is a kind emitted by `AgentHost.emit`,
 * which is what the tests below that build a Host drive.
 */
function publishForwarded(events: EventHub, kind: "turn.completed" | "turn.failed"): RacpEventEnvelope {
  return events.publish({
    scope: "host",
    sessionId: "session-1",
    turnId: "turn-1",
    revision: 12,
    kind,
    agentName: "worker",
    payload: sentinelPayload(),
  });
}

/** A subscriber that just records what the surface delivered to it. */
class RecordingSink implements SubscriptionSink {
  readonly received: RacpEventEnvelope[] = [];
  deliver(envelope: RacpEventEnvelope): void {
    this.received.push(envelope);
  }
  close(): void {}
}

/**
 * Drive one real agent turn through the Host: a start, then the terminal
 * `agent_end` that the Host maps to `turn.completed`. Both are fed as runtime
 * events through `ingest`, so every envelope the subscribers see was built and
 * published by the Host itself.
 */
function driveOneTurn(host: AgentHost): void {
  host.ingest({ sessionId: "s1", turnId: "t1", ts: 1_700_000_000_000, event: { type: "agent_start" } });
  host.ingest({
    sessionId: "s1",
    turnId: "t1",
    ts: 1_700_000_000_100,
    event: { type: "agent_end", messageIds: [] },
  });
}

function recordingPort(): {
  port: HostRpcPort;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: HostRpcPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params: params ?? {} });
      return {} as T;
    },
  };
  return { port, calls };
}

/** Let the fire-and-forget hand-off's promise reactions run. */
async function flushHandoff(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const owner: Principal = { subject: "messaging", roles: ["viewer"] };

/**
 * The fixture session's owner (ADR 0325). A viewer-role principal reaches a
 * session only when it is that session's owner — a `viewer` scoped to someone
 * else's session is the deferred per-session-role follow-on — so the fixture
 * session is owned by the `owner` principal above.
 */
const SESSION_OWNER_SUBJECT = "messaging";

class NullRuntime implements RuntimePort {
  async prompt(): Promise<{ turnId: string }> {
    return { turnId: "turn" };
  }
  async stop(): Promise<{ requested: boolean }> {
    return { requested: true };
  }
  async abort(): Promise<void> {}
  async respondInput(): Promise<void> {}
}

class NullSessions implements SessionPort {
  async get(sessionId: string): Promise<SessionSummary | null> {
    if (sessionId !== "s1") return null;
    return {
      id: "s1",
      title: "Session s1",
      mode: "agent",
      permissionMode: "ask",
      owner: SESSION_OWNER_SUBJECT,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
  }
  async history(): ReturnType<SessionPort["history"]> {
    return { items: [], hasMore: false };
  }
}

class NullApprovals implements ApprovalPort {
  async resolveTool(): Promise<void> {}
  async resolveContract(): Promise<void> {}
  async listPendingTools(): ReturnType<ApprovalPort["listPendingTools"]> {
    return [];
  }
}

function buildHost(): AgentHost {
  return new AgentHost({
    runtime: new NullRuntime(),
    sessions: new NullSessions(),
    approvals: new NullApprovals(),
    clock: new FixedClock(),
    ids: new SeqIds(),
  });
}

describe("MessagingRedactor", () => {
  it("enqueues one redacted summary for a forwarded host-scope event", async () => {
    const events = hub();
    const { port, calls } = recordingPort();
    events.subscribe({ scope: "host" }, new MessagingRedactor(port, "primary"));

    const published = publishForwarded(events, "turn.completed");
    await flushHandoff();

    // Exactly one delivery hand-off, on the real channel hand-off verb.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe(MESSAGING_ENQUEUE_METHOD);
    expect(call.params.channel).toBe("primary");

    // The summary is structure and metadata, and it is traceable back to the
    // envelope the surface published.
    const summary = call.params.payload as MessageDeliverySummary;
    expect(summary).toEqual({
      eventId: published.eventId,
      kind: "turn.completed",
      scope: "host",
      sessionId: "session-1",
      turnId: "turn-1",
      epoch: published.epoch,
      sequence: published.sequence,
      revision: 12,
      status: "completed",
      agentName: "worker",
      occurredAt: published.occurredAt,
    });
  });

  it("never carries planted transcript text in any field it hands over", async () => {
    const events = hub();
    const { port, calls } = recordingPort();
    events.subscribe({ scope: "host" }, new MessagingRedactor(port, "primary"));

    for (const kind of FORWARDED_EVENT_KINDS) {
      const published = events.publish({
        scope: "host",
        sessionId: "session-1",
        turnId: "turn-1",
        revision: 12,
        kind,
        payload: sentinelPayload(),
      });
      expect(published.kind).toBe(kind);
    }
    await flushHandoff();

    expect(calls).toHaveLength(FORWARDED_EVENT_KINDS.length);
    for (const call of calls) {
      // Nothing the ledger would store contains the sentinel...
      expect(JSON.stringify(call.params)).not.toContain(SENTINEL);
      // ...and no single field of the summary does either.
      const summary = call.params.payload as Record<string, unknown>;
      for (const value of Object.values(summary)) {
        expect(JSON.stringify(value)).not.toContain(SENTINEL);
      }
    }
  });

  it("enqueues nothing for a kind it does not forward", async () => {
    const events = hub();
    const { port, calls } = recordingPort();
    events.subscribe({ scope: "host" }, new MessagingRedactor(port, "primary"));

    for (const kind of ["item.delta", "item.completed", "session.changed", "approval.resolved"] as const) {
      expect(isForwardedKind(kind)).toBe(false);
      events.publish({ scope: "host", sessionId: "session-1", revision: 1, kind, payload: sentinelPayload() });
    }
    await flushHandoff();
    expect(calls).toHaveLength(0);

    // A forwarded kind does enqueue; the two sets do not overlap.
    publishForwarded(events, "turn.failed");
    await flushHandoff();
    expect(calls).toHaveLength(1);
  });

  it("sends to the channel it was constructed with, not a fixed one", async () => {
    const telegram = recordingPort();
    const slack = recordingPort();
    const a = hub();
    const b = hub();
    a.subscribe({ scope: "host" }, new MessagingRedactor(telegram.port, "primary"));
    b.subscribe({ scope: "host" }, new MessagingRedactor(slack.port, "secondary"));

    publishForwarded(a, "turn.completed");
    publishForwarded(b, "turn.completed");
    await flushHandoff();

    expect(telegram.calls[0]!.params.channel).toBe("primary");
    expect(slack.calls[0]!.params.channel).toBe("secondary");
  });

  it("is driven by the real Host subscription contract", async () => {
    const host = buildHost();
    const { port, calls } = recordingPort();
    const redactor = new MessagingRedactor(port, "primary");
    const deliver = vi.spyOn(redactor, "deliver");

    // The Host subscribes the redactor through its own public entry point.
    await host.subscribe(owner, { scope: "host" }, redactor);
    host.publishSessionChange("session.created", {
      id: "s1",
      title: "Session s1",
      mode: "agent",
      permissionMode: "ask",
      createdAt: "2026-10-14T09:00:00.000Z",
      updatedAt: "2026-10-14T09:00:00.000Z",
    });

    // The Host fanned its host-scope event out to the redactor as the sink...
    expect(deliver).toHaveBeenCalledTimes(1);
    const envelope = deliver.mock.calls[0]![0] as RacpEventEnvelope;
    expect(envelope.scope).toBe("host");
    expect(envelope.kind).toBe("session.created");
    // ...and a kind it does not forward enqueues nothing.
    expect(calls).toHaveLength(0);
  });

  it("publishes a forwarded kind at host scope without double-delivering to either scope", async () => {
    const host = buildHost();
    const sessionSink = new RecordingSink();
    const hostSink = new RecordingSink();
    await host.subscribe(owner, { scope: "session", sessionId: "s1" }, sessionSink);
    await host.subscribe(owner, { scope: "host" }, hostSink);

    driveOneTurn(host);

    // One turn, one `turn.completed` for each subscriber — never two for either.
    // The fan-out (EventHub.publish) drops every subscription whose scope does
    // not match the draft's, so the session draft reaches only the session
    // subscriber and the host draft only the host subscriber.
    const sessionTurns = sessionSink.received.filter((envelope) => envelope.kind === "turn.completed");
    const hostTurns = hostSink.received.filter((envelope) => envelope.kind === "turn.completed");
    expect(sessionTurns).toHaveLength(1);
    expect(hostTurns).toHaveLength(1);

    // Each saw the draft for its own scope, naming the same turn.
    expect(sessionTurns[0]!.scope).toBe("session");
    expect(hostTurns[0]!.scope).toBe("host");
    expect(hostTurns[0]!.sessionId).toBe("s1");
    expect(hostTurns[0]!.turnId).toBe("t1");

    // The host-scope forwarded kind is an addition, not a replacement: the
    // host-scope `session.changed` the Host always published still arrives.
    expect(
      hostSink.received.some((envelope) => envelope.kind === "session.changed" && envelope.scope === "host"),
    ).toBe(true);
  });

  it("drives a forwarded kind through the real Host publish path to exactly one enqueue", async () => {
    const host = buildHost();
    const { port, calls } = recordingPort();
    // The Host subscribes the redactor on its host-scope surface, exactly as it
    // would in production; no hand-published event stands in for a real one.
    await host.subscribe(owner, { scope: "host" }, new MessagingRedactor(port, "primary"));

    driveOneTurn(host);
    await flushHandoff();

    // The forwarded kind produced exactly one hand-off, and the host-scope
    // session.changed that rode along enqueued nothing.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe(MESSAGING_ENQUEUE_METHOD);
    expect(call.params.channel).toBe("primary");

    const summary = call.params.payload as MessageDeliverySummary;
    expect(summary.kind).toBe("turn.completed");
    expect(summary.scope).toBe("host");
    expect(summary.sessionId).toBe("s1");
    expect(summary.turnId).toBe("t1");
    expect(summary.status).toBe("completed");
    expect(summary.revision).toBeGreaterThan(0);
    expect(typeof summary.sequence).toBe("number");
  });

  it("reports a failed hand-off instead of swallowing it", async () => {
    const events = hub();
    const errors: unknown[] = [];
    const port: HostRpcPort = {
      async call(): Promise<never> {
        throw new Error("host unavailable");
      },
    };
    events.subscribe(
      { scope: "host" },
      new MessagingRedactor(port, "primary", (error) => errors.push(error)),
    );

    publishForwarded(events, "turn.completed");
    await flushHandoff();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("host unavailable");
  });
});

/**
 * The process card (ADR 0340). A card is the only feature that reads an
 * envelope payload, so these tests are as much about what cannot cross as about
 * what does: three named keys, strings only, each cut to length.
 */
describe("MessagingRedactor cards", () => {
  function cardRedactor(cards: boolean) {
    const call = vi.fn(async () => ({}));
    const redactor = new MessagingRedactor({ call } as unknown as HostRpcPort, "telegram", undefined, cards);
    return { call, redactor };
  }

  function event(kind: "turn.started" | "tool.progress" | "turn.completed", payload: unknown) {
    const events = new EventHub({ clock: new FixedClock(), ids: new SeqIds() });
    return events.publish({
      scope: "host",
      sessionId: "session-1",
      turnId: "turn-1",
      revision: 12,
      kind,
      agentName: "worker",
      payload,
    } as never);
  }

  it("does not forward a card kind while the card is off", () => {
    const { call, redactor } = cardRedactor(false);
    redactor.deliver(event("turn.started", {}));
    redactor.deliver(event("tool.progress", { tool: "shell" }));
    expect(call).not.toHaveBeenCalled();
  });

  it("opens a card when the turn starts", () => {
    const { call, redactor } = cardRedactor(true);
    redactor.deliver(event("turn.started", {}));
    const [, params] = call.mock.calls[0] as unknown as [string, { payload: MessageDeliverySummary }];
    expect(params.payload.kind).toBe("turn.started");
    expect(params.payload.status).toBe("running");
  });

  it("carries the three card fields and nothing else from the payload", () => {
    const { call, redactor } = cardRedactor(true);
    redactor.deliver(
      event("tool.progress", {
        phase: "reading",
        tool: "shell",
        note: "reading the file",
        args: { secret: SENTINEL },
        result: SENTINEL,
        text: SENTINEL,
      }),
    );
    const [, params] = call.mock.calls[0] as unknown as [string, { payload: MessageDeliverySummary }];
    expect(params.payload.phase).toBe("reading");
    expect(params.payload.tool).toBe("shell");
    expect(params.payload.note).toBe("reading the file");
    expect(JSON.stringify(params.payload)).not.toContain(SENTINEL.slice(0, 24));
  });

  it("cuts the note at the boundary instead of trusting it to be short", () => {
    const { call, redactor } = cardRedactor(true);
    redactor.deliver(event("tool.progress", { note: "n".repeat(400) }));
    const [, params] = call.mock.calls[0] as unknown as [string, { payload: MessageDeliverySummary }];
    expect(params.payload.note).toHaveLength(CARD_NOTE_LIMIT);
    expect(params.payload.note?.endsWith("…")).toBe(true);
  });

  it("drops a field that is not a string rather than stringifying it", () => {
    const { call, redactor } = cardRedactor(true);
    redactor.deliver(event("tool.progress", { tool: { name: SENTINEL }, phase: 7 }));
    const [, params] = call.mock.calls[0] as unknown as [string, { payload: MessageDeliverySummary }];
    expect(params.payload.tool).toBeUndefined();
    expect(params.payload.phase).toBeUndefined();
  });

  it("hands a card event to the card instead of enqueueing it", () => {
    const call = vi.fn(async () => ({}));
    const absorb = vi.fn(() => true);
    const redactor = new MessagingRedactor(
      { call } as unknown as HostRpcPort,
      "telegram",
      undefined,
      true,
      { absorb },
    );
    redactor.deliver(event("turn.started", {}));
    expect(absorb).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });

  it("delivers a summary itself when no card took it", () => {
    const call = vi.fn(async () => ({}));
    const redactor = new MessagingRedactor({ call } as unknown as HostRpcPort, "telegram", undefined, true, {
      absorb: () => false,
    });
    redactor.deliver(event("turn.completed", {}));
    expect(call).toHaveBeenCalledTimes(1);
  });
});
