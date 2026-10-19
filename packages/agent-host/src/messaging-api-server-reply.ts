/**
 * The production reply seam for the local API channel.
 *
 * The endpoint in `messaging-api-server.ts` knows only one thing about the
 * agent: it hands a message to [`ApiServerReply`] and awaits text. This module
 * is one implementation of that seam, over the Agent Host surface the rest of
 * this package already exposes:
 *
 * 1. resolve the conversation — the caller's `conversationId` is a session id,
 *    and an omitted one falls back to the session the channel's record is
 *    bound to;
 * 2. subscribe to that session *before* starting the turn, so the first delta
 *    cannot be missed;
 * 3. `startTurn` with `admission: "queue"`, so a busy session queues the
 *    caller instead of refusing it;
 * 4. accumulate the assistant's message deltas for that turn only, keyed by the
 *    turn id `startTurn` returned;
 * 5. resolve on `turn.completed`, reject on `turn.interrupted` or
 *    `turn.failed`, and unsubscribe either way.
 *
 * # Why the turn id is the filter
 *
 * A session stream carries every event of the session, including any queued
 * behind this one. The reply is the text of *this* turn, so an envelope is only
 * read when its `turnId` equals the one `startTurn` answered with. Events that
 * arrive before that answer are buffered — the turn starts immediately — and
 * replayed the moment the id is known.
 *
 * # One conversation at a time
 *
 * Two requests for the same session are serialised here. The Host would queue
 * them anyway (`admission: "queue"`), but this adapter reads a single session
 * stream: two overlapping turns would interleave their deltas. One at a time is
 * the honest shape.
 *
 * # What it deliberately does not do
 *
 * - It does not stream. The endpoint answers once; this adapter therefore
 *   collects and returns.
 * - It does not retry a failed turn. A retry would be a second turn the caller
 *   never asked for and could not see.
 * - It does not answer approvals. A turn that stops for one is reported as an
 *   interruption, with the session left waiting exactly as the Host recorded it.
 */

import type { RacpEventEnvelope } from "@pi-desktop/shared";

import type { AgentHost } from "./agent-host.js";
import type { SubscriptionSink } from "./event-log.js";
import type { ApiServerReply } from "./messaging-api-server.js";
import { RandomIds, type IdSource, type Principal } from "./ports.js";

/**
 * The identity a message from the local API acts as.
 *
 * The token is the whole credential, so there is no per-caller identity to
 * derive: whoever holds the machine's token is the operator, and the `owner`
 * role is what the Agent Host's own session rule admits to every session. A
 * narrower role would make the endpoint refuse the caller's own conversation —
 * a session this app created, on this machine — which is not a security
 * boundary but a broken feature.
 */
export const MESSAGING_API_SERVER_PRINCIPAL: Principal = {
  subject: "local-api",
  roles: ["owner"],
};

/** The Agent Host methods this adapter needs; the same object the wiring has. */
export type ApiServerTurnSurface = Pick<AgentHost, "startTurn" | "subscribe" | "unsubscribe">;

export type ApiServerReplyOptions = {
  agentHost: ApiServerTurnSurface;
  /** The identity a message from this endpoint runs as. */
  principal: Principal;
  /** The session the channel is bound to, or `null` when none is. */
  sessionFor: () => Promise<string | null>;
  /** How long one turn may take before the caller is told it timed out. */
  timeoutMs: number;
  /** Id source for request ids; defaults to the host's own `RandomIds`. */
  ids?: IdSource;
};

type Terminal =
  | { kind: "completed" }
  | { kind: "interrupted" }
  | { kind: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fold one event into the reply text of a turn.
 *
 * `message_update` carries `deltaText` when the runtime streams. A snapshot
 * replacement carries the whole message and no delta, and is taken as the
 * item's text. `message_end` is authoritative: whatever the final content is,
 * that is what the item says.
 */
function applyTextEvent(text: Map<string, string>, payload: unknown): void {
  if (!isRecord(payload)) return;
  if (payload.itemType !== undefined && payload.itemType !== "message") return;
  const event = isRecord(payload.event) ? payload.event : null;
  if (!event) return;
  const message = isRecord(event.message) ? event.message : null;
  if (!message || message.role !== "assistant") return;
  const itemId = typeof message.id === "string" ? message.id : null;
  if (!itemId) return;
  if (typeof event.deltaText === "string" && event.deltaText !== "") {
    text.set(itemId, (text.get(itemId) ?? "") + event.deltaText);
    return;
  }
  if (event.type === "message_end" && typeof message.content === "string") {
    text.set(itemId, message.content);
  }
}

/** The terminal verdict an envelope carries, if it is one. */
function terminalOf(kind: string, payload: unknown): Terminal | null {
  if (kind === "turn.completed") return { kind: "completed" };
  if (kind === "turn.interrupted") return { kind: "interrupted" };
  if (kind === "turn.failed") {
    const event = isRecord(payload) && isRecord(payload.event) ? payload.event : null;
    const error = event && isRecord(event.error) ? event.error : null;
    return {
      kind: "failed",
      reason: typeof error?.message === "string" ? error.message : "the turn failed",
    };
  }
  return null;
}

/**
 * The reply adapter. One instance per started channel; it holds no state
 * between conversations beyond the in-flight queue it is serialising.
 */
export function createAgentTurnReply(options: ApiServerReplyOptions): ApiServerReply {
  const ids = options.ids ?? new RandomIds();
  const inFlight = new Map<string, Promise<void>>();

  const runTurn = async (sessionId: string, message: string): Promise<string> => {
    const text = new Map<string, string>();
    let turnId: string | null = null;
    let finished = false;
    let settle: (value: string) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const buffered: RacpEventEnvelope[] = [];

    const verdict = new Promise<string>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const finish = (outcome: Terminal): void => {
      if (finished) return;
      finished = true;
      if (outcome.kind === "completed") {
        const answer = [...text.values()].join("\n\n").trim();
        if (answer === "") fail(new Error("the agent answered nothing"));
        else settle(answer);
        return;
      }
      fail(
        new Error(
          outcome.kind === "interrupted"
            ? "the turn was interrupted before it answered"
            : outcome.reason,
        ),
      );
    };

    const handle = (envelope: RacpEventEnvelope): void => {
      if (finished) return;
      if (envelope.turnId !== turnId) return;
      applyTextEvent(text, envelope.payload);
      const terminal = terminalOf(envelope.kind, envelope.payload);
      if (terminal) finish(terminal);
    };

    const sink: SubscriptionSink = {
      deliver: (envelope) => {
        if (finished) return;
        if (turnId === null) {
          buffered.push(envelope);
          return;
        }
        handle(envelope);
      },
      close: () => {
        if (!finished) fail(new Error("the session event stream closed before the turn answered"));
      },
    };

    const subscription = await options.agentHost.subscribe(
      options.principal,
      { scope: "session", sessionId },
      sink,
    );
    let timer: NodeJS.Timeout | null = null;
    try {
      const started = await options.agentHost.startTurn(options.principal, {
        sessionId,
        admission: "queue",
        input: { text: message },
        context: { requestId: ids.next("api") },
      });
      turnId = started.turn.id;
      for (const envelope of buffered.splice(0)) {
        handle(envelope);
        if (finished) break;
      }

      timer = setTimeout(
        () => fail(new Error("the agent did not answer within the request timeout")),
        Math.max(1, options.timeoutMs),
      );
      timer.unref?.();
      return await verdict;
    } finally {
      if (timer !== null) clearTimeout(timer);
      options.agentHost.unsubscribe(subscription.subscriptionId, sessionId);
    }
  };

  return async ({ message, conversationId }) => {
    const sessionId = conversationId ?? (await options.sessionFor());
    if (!sessionId) {
      throw new Error("the channel has no conversation bound and none was given");
    }
    const previous = inFlight.get(sessionId) ?? Promise.resolve();
    const run = previous.then(
      () => runTurn(sessionId, message),
      () => runTurn(sessionId, message),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(sessionId, settled);
    try {
      return await run;
    } finally {
      if (inFlight.get(sessionId) === settled) inFlight.delete(sessionId);
    }
  };
}
