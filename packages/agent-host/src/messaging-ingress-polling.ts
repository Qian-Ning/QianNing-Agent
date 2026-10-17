/**
 * The polling transport: the Host asks for what is new since a stored cursor,
 * applies the batch, and advances the cursor only after the batch has been
 * applied.
 *
 * Telegram is the channel this serves, and its loop previously lived inside the
 * inbound driver beside the routing code. It is a transport concern — cursor,
 * retry floor, platform back-off — so it lives with the other transports, and a
 * second pull channel gets it for free instead of growing a second loop.
 *
 * # Cursor durability, and why it is what stops a restart replaying
 *
 * The poll applies a returned batch in full and only then advances and saves the
 * cursor. That makes the path **at-least-once**: a crash in the window between
 * applying the batch and saving the cursor causes those messages to be offered
 * again on the next run, and nothing suppresses that copy after a restart —
 * which is the safe direction, since the alternative (saving first) would drop
 * them with no trace.
 *
 * The save is conditional on the cursor having actually moved, so an idle poll
 * writes nothing. A cursor store that cannot be written is reported and the last
 * good cursor stays in place: a persistently failing store degrades to a replay
 * from the last cursor that did save, and it never advances past an unsaved
 * batch. A store that cannot be read leaves the cursor at zero, which is the
 * state a run had before a store existed.
 *
 * The cursor only ever moves forward: a platform that answers a lower position
 * must not move it backwards and make the platform replay what this run has
 * already handled.
 */

import {
  ingressErrorMessage,
  ingressAudit,
  type IngressAudit,
  type IngressCursorStore,
  type IngressMessage,
  type IngressNormalise,
} from "./messaging-ingress.js";

/** One poll's answer, generic over the platform's own event unit. */
export type PollingIngressResult<TEvent> =
  | { ok: true; events: TEvent[]; nextCursor: number }
  | { ok: false; error: string; retryAfterMs?: number };

/** How long the loop waits after a failed poll before trying again. */
export const INGRESS_POLL_FAILURE_DELAY_MS = 5_000;
/** The least the loop waits between polls, so a fast answer cannot spin it. */
export const INGRESS_MIN_POLL_INTERVAL_MS = 1_000;

export type PollingIngressOptions<TEvent> = {
  /** One poll from `cursor`; a failure is reported in the result, never thrown. */
  poll: (cursor: number, signal?: AbortSignal) => Promise<PollingIngressResult<TEvent>>;
  /** Project one event of the batch onto the shared shape. */
  normalise: IngressNormalise | ((event: TEvent) => ReturnType<IngressNormalise>);
  /** Where the cursor is persisted; absent means this run only, from zero. */
  cursor?: IngressCursorStore;
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
  /** How the loop waits between polls; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/** The shared, channel-neutral handler a batch is applied through. */
export type PollingIngressHandler = (message: IngressMessage) => Promise<void>;

/**
 * The polling transport: one cursor, one barrier, one backoff floor.
 *
 * `apply` is the routing path's handler; the transport never interprets a
 * message. A batch is applied in the platform's order and the cursor advances
 * once, after the last message of the batch.
 */
export class PollingIngressTransport<TEvent> {
  private readonly options: PollingIngressOptions<TEvent>;
  private readonly audit: IngressAudit;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly cursor: IngressCursorStore | null;
  private offset = 0;

  constructor(options: PollingIngressOptions<TEvent>) {
    this.options = options;
    this.audit = ingressAudit(options.audit);
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.cursor = options.cursor ?? null;
  }

  /** The cursor the next poll asks from. */
  get nextCursor(): number {
    return this.offset;
  }

  /**
   * One poll, then one handling pass per event it returned.
   *
   * The poll is awaited here and no host state is touched while it is
   * outstanding. A failed poll is audited, advances no cursor, and reports the
   * platform's own back-off when it carried one.
   */
  async pollOnce(
    apply: PollingIngressHandler,
    signal?: AbortSignal,
  ): Promise<{ polled: boolean; retryAfterMs?: number }> {
    const result = await this.options.poll(this.offset, signal);
    if (!result.ok) {
      this.audit({ kind: "connect-failed", error: result.error });
      return {
        polled: false,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }
    for (const event of result.events) {
      const normalised = this.options.normalise(event);
      if (normalised.kind === "message") await apply(normalised.message);
    }
    if (result.nextCursor > this.offset) {
      this.offset = result.nextCursor;
      await this.saveCursor();
    }
    return { polled: true };
  }

  /**
   * Poll until `signal` aborts. Never throws: a failed poll waits a bounded
   * delay and tries again, so an unreachable channel can neither take the Host
   * down nor spin the CPU. A poll that returned waits a minimum interval, so a
   * fast-returning channel cannot spin it either; a platform back-off a poll
   * carried is honoured as the longer wait.
   */
  async run(apply: PollingIngressHandler, signal?: AbortSignal): Promise<void> {
    await this.loadCursor();
    while (!signal?.aborted) {
      let polled = false;
      let retryAfterMs = 0;
      try {
        const outcome = await this.pollOnce(apply, signal);
        polled = outcome.polled;
        retryAfterMs = outcome.retryAfterMs ?? 0;
      } catch (error) {
        // Defensive: a poll that throws instead of returning is still a poll
        // failure, not a Host failure.
        this.audit({ kind: "connect-failed", error: ingressErrorMessage(error) });
      }
      const floor = polled ? INGRESS_MIN_POLL_INTERVAL_MS : INGRESS_POLL_FAILURE_DELAY_MS;
      if (!signal?.aborted) await this.wait(Math.max(floor, retryAfterMs));
    }
  }

  /** Reload the persisted cursor before the first poll of a run. */
  private async loadCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      const saved = await this.cursor.load();
      if (typeof saved === "number" && Number.isFinite(saved) && saved > this.offset) {
        this.offset = saved;
      }
    } catch {
      // Nothing to recover here: the cursor stays where it is.
    }
  }

  /** Persist the current cursor; a failure is reported and the cursor stays. */
  private async saveCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      await this.cursor.save(this.offset);
    } catch (error) {
      this.audit({ kind: "record-failed", eventId: "poll-cursor", error: ingressErrorMessage(error) });
    }
  }
}
