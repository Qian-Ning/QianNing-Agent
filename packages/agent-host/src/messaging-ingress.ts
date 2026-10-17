/**
 * The shared messaging ingress layer: one contract every messaging channel
 * implements, and one home for the concerns they all share.
 *
 * Four channels already carry the same machinery — Telegram over an outbound
 * long poll, Slack over Socket Mode, Discord over the Gateway websocket, and
 * Mattermost over its own websocket. Each arrived with its own copy of the
 * replay guard's ordering, its own reconnect loop, its own socket lifecycle, and
 * its own reply chunker. A fifth channel written that way would copy a fifth
 * time, and the copies would drift.
 *
 * This module owns, once:
 *
 * - the shared inbound shape ([`IngressMessage`]) and the neutral projection a
 *   platform's classifier returns ([`IngressNormalisation`]);
 * - the dedupe gate ([`IngressGate`]): consult the restart-durable guard, handle
 *   the message, record it durably, then acknowledge — the ordering that makes
 *   the path at-least-once with dedupe rather than at-most-once with loss — and
 *   the in-run claim log ([`IngressClaimLog`]) beside it, for the copy that
 *   arrives while the first is still being applied;
 * - the reply chunker ([`chunkIngressText`]) and the sequential chunk delivery
 *   ([`deliverInChunks`]) every channel's send path uses, so one reply's pieces
 *   arrive in the order they were written;
 * - the reconnect delay ([`ingressReconnectDelayMs`]) and its bounds, with equal
 *   jitter and a cap.
 *
 * What a platform still implements is only what is genuinely its own: how to
 * connect (one connection attempt, or one poll), how to project one raw platform
 * event onto [`IngressNormalisation`], how to deliver a reply, and the platform's
 * message size limit. Everything else lives here or in one of the three
 * transport classes ([`./messaging-ingress-socket.js`],
 * [`./messaging-ingress-polling.js`], [`./messaging-ingress-webhook.js`]).
 *
 * The transports are named by their delivery shape, because that is what a new
 * channel has to choose before anything else:
 *
 * - **socket** — a long-lived connection the Host opens and the platform pushes
 *   frames down (Discord, Mattermost, Slack Socket Mode);
 * - **polling** — the Host asks for what is new since a cursor (Telegram);
 * - **webhook** — the platform calls in with one HTTP request per event
 *   (Slack's HTTP mode, and every callback-shaped channel after it).
 *
 * A channel declares its shape on the adapter ([`MessagingIngressAdapter`]) and
 * is served by the matching transport; nothing else about the shared layer
 * changes.
 */

/**
 * One inbound message, channel-neutral: the fields every receive path shares,
 * whatever transport delivered it.
 *
 * The text is the message's own text and nothing else. No transcript, no
 * attachment, no envelope: a channel that needed more would grow this shape
 * deliberately rather than smuggle fields through it.
 */
export type IngressMessage = {
  /** The message's own id; with the conversation, the replay guard's key. */
  messageId: string;
  /** The conversation the message came from. */
  chatId: string;
  /** The message text exactly as received. */
  text: string;
};

/**
 * What one raw platform event projects onto.
 *
 * `message` is the only case that can reach the routing path. `filtered` means
 * the platform delivered something this channel must not act on — its own
 * message, another bot's, a system event, an empty body — and carries the reason
 * so the audit record says why. A filter is never an exception: untrusted input
 * produces a typed refusal, never a throw.
 */
export type IngressNormalisation =
  | {
      kind: "message";
      message: IngressMessage;
      /**
       * The replay guard's key for this event, in the platform's own terms —
       * Slack's event id, Discord's channel plus message id, Mattermost's post
       * id. Chosen by the adapter because only the platform knows which id a
       * redelivery keeps stable.
       */
      key: string;
    }
  | { kind: "filtered"; reason: string; channelId?: string };

/** Project one raw platform event onto the shared shape. */
export type IngressNormalise = (raw: unknown) => IngressNormalisation;

/**
 * A restart-durable replay guard. `has` answers whether an event has already
 * been acted on; `record` durably remembers one and must not resolve until the
 * record would survive a restart.
 */
export interface IngressHandledStore {
  has(key: string): Promise<boolean>;
  record(key: string): Promise<void>;
}

/**
 * The neutral audit vocabulary the shared layer emits.
 *
 * Structure, ids and failure classes only — never message text and never a
 * credential. Each adapter maps this onto the entry type its channel publishes,
 * so the *decision* to record (and what may appear in a record) is shared while
 * the published vocabulary stays the channel's own.
 */
export type IngressAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "identity-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "malformed"; reason: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "heartbeat-missed" }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string };

export type IngressAudit = (entry: IngressAuditEntry) => void;

/** The shared sink: an absent sink drops every record. */
export function ingressAudit(sink?: IngressAudit): IngressAudit {
  return sink ?? (() => {});
}

/** The failure detail a reported error carries: its message, never its stack. */
export function ingressErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What handling one message at the gate did. */
export type IngressGateOutcome =
  | "delivered"
  | "duplicate"
  | "process-failed"
  | "record-failed";

export type IngressGateOptions = {
  /** The restart-durable guard; the gate consults and records it. */
  handled: IngressHandledStore;
  /** The neutral handler the routing path provides. */
  onMessage: (message: IngressMessage) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
};

/**
 * The replay key for a message whose platform ids are unique per conversation:
 * the conversation and the message id, joined by a separator neither can
 * contain in a way that would collide. Three channels key this way (Telegram's
 * update, Discord's message, Mattermost's post), and the driver's in-run claim
 * uses it too, so the format is written once — a channel that restated it and
 * drifted would silently stop recognising its own redeliveries.
 */
export function ingressMessageKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

/**
 * The in-run claim log: a bounded, synchronous record of the keys this run has
 * already admitted.
 *
 * It is a second *ordering*, not a second copy of the gate, and both orderings
 * are wanted:
 *
 * - [`IngressGate`] records **after** handling, because its record is what the
 *   platform's acknowledgement waits on: a handler that fails must leave the
 *   event unrecorded so the platform redelivers it.
 * - This log claims **before** the work starts, because the work can take a
 *   while and a redelivery arriving inside that window would otherwise start a
 *   second turn. A duplicate there must be recognised immediately, so the check
 *   is synchronous and cannot be interleaved with another frame.
 *
 * Both live here, once. No channel carries a third.
 *
 * It is in memory and covers one run: durability across a restart is the
 * transport's (a poll cursor) or the durable gate's, not this log's. It is
 * bounded to `capacity` keys, oldest evicted first, so a chatty or hostile
 * channel cannot grow it without limit; after that many messages a redelivery
 * of an older one is no longer recognised.
 */
export class IngressClaimLog {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.seen.has(key);
  }

  record(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}

/**
 * The dedupe gate: the one place the replay-guard ordering is written.
 *
 * A redelivery is recognised by the durable guard and audited without being
 * handled again. The message is handled *first* and recorded *after*, and the
 * acknowledgement (where the platform has one) waits on the record: a handler
 * that fails leaves the event unrecorded and unacknowledged, so the platform
 * redelivers it and the command is re-applied rather than silently lost. A
 * record that fails likewise leaves it unacknowledged. That is at-least-once
 * with dedupe — never at-most-once with loss — and it is the same ordering for
 * every channel.
 *
 * A guard that cannot be read is treated as "not seen": the gate re-applies the
 * message rather than refusing it on a store failure, which is the only failure
 * direction that cannot lose a command.
 */
export class IngressGate {
  private readonly handled: IngressHandledStore;
  private readonly onMessage: (message: IngressMessage) => Promise<void>;
  private readonly audit: IngressAudit;

  constructor(options: IngressGateOptions) {
    this.handled = options.handled;
    this.onMessage = options.onMessage;
    this.audit = ingressAudit(options.audit);
  }

  /**
   * Apply one normalised message.
   *
   * `ack` is the platform's acknowledgement, run exactly where the ordering
   * requires it: after the duplicate audit for a redelivery, and after the
   * durable record for a handled message. A channel with no acknowledgement
   * (Discord, Mattermost) simply omits it.
   */
  async ingest(
    message: IngressMessage,
    key: string,
    ack?: () => void,
  ): Promise<IngressGateOutcome> {
    let alreadyHandled: boolean;
    try {
      alreadyHandled = await this.handled.has(key);
    } catch {
      alreadyHandled = false;
    }
    if (alreadyHandled) {
      this.audit({ kind: "duplicate", eventId: key });
      ack?.();
      return "duplicate";
    }

    try {
      await this.onMessage(message);
    } catch (error) {
      // The handler owns the routing outcome; a throw here is a transport-level
      // failure, and leaving the event unrecorded lets the platform redeliver.
      this.audit({ kind: "process-failed", eventId: key, error: ingressErrorMessage(error) });
      return "process-failed";
    }

    try {
      await this.handled.record(key);
    } catch (error) {
      this.audit({ kind: "record-failed", eventId: key, error: ingressErrorMessage(error) });
      return "record-failed";
    }

    this.audit({ kind: "processed", eventId: key });
    ack?.();
    return "delivered";
  }
}

// ---------------------------------------------------------------------------
// Reply chunking and sequential delivery
// ---------------------------------------------------------------------------

/**
 * Split a reply at a channel's message limit, preserving order and content.
 *
 * A split prefers the last newline inside the window, then the last space, and
 * otherwise falls exactly at the limit. A cut never separates a surrogate pair,
 * so a message containing an emoji is not corrupted at the boundary. Joining the
 * chunks returns the original text exactly: the separator stays at the end of
 * the earlier chunk.
 *
 * The algorithm is one copy because the rule is one rule; only the limit is the
 * platform's.
 */
export function chunkIngressText(text: string, limit: number): string[] {
  const size = Math.max(1, Math.floor(limit));
  if (text.length <= size) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size - 1);
    if (cut <= 0) cut = rest.lastIndexOf(" ", size - 1);
    if (cut <= 0) cut = size;
    // Never split a surrogate pair: step back one unit when the cut lands
    // between a high and a low surrogate.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export type IngressDeliveryResult =
  | { ok: true; sent: number; ids: string[] }
  | { ok: false; error: string; sent: number };

/**
 * What one chunk's POST answered.
 *
 * The platform's HTTP call stays in the adapter — its URL, headers, body and
 * rate-limit spelling are the platform's — while the retry schedule, the chunk
 * loop and the error vocabulary are shared.
 */
export type IngressPostOutcome =
  | { kind: "accepted"; id: string }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "unavailable" }
  | { kind: "refused"; error: string };

export type ChunkedDeliveryOptions = {
  /** The platform's name, used in a status-only refusal detail. */
  platform: string;
  /** The platform's message limit; the reply is chunked at it. */
  limit: number;
  /** Post one chunk; a throw is treated as a transport failure. */
  post: (chunk: string) => Promise<IngressPostOutcome>;
  /** The most attempts per chunk after a 429/5xx. */
  maxAttempts?: number;
  /** How the sender waits out a rate limit; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 5;
/** The cap on the 5xx / transport backoff between attempts of one chunk. */
const MAX_POST_BACKOFF_MS = 30_000;

/**
 * Deliver one reply, chunked at the channel's limit and posted in order.
 *
 * A long reply arrives in the order it was written because each chunk is posted
 * only after the previous one was accepted. A 429 waits the platform's own
 * `retry_after`; a 5xx, and a thrown transport failure, retry on a bounded
 * exponential backoff; any other refusal ends the send with a status-only
 * detail. The response body and the token never appear in a result.
 */
export async function deliverInChunks(
  text: string,
  options: ChunkedDeliveryOptions,
): Promise<IngressDeliveryResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chunks = chunkIngressText(text, options.limit);
  if (chunks.length === 0) return { ok: true, sent: 0, ids: [] };

  const ids: string[] = [];
  for (const chunk of chunks) {
    let sent = false;
    for (let attempt = 0; attempt < maxAttempts && !sent; attempt += 1) {
      let outcome: IngressPostOutcome;
      try {
        outcome = await options.post(chunk);
      } catch (error) {
        if (attempt + 1 >= maxAttempts) {
          return {
            ok: false,
            error: error instanceof Error && error.name === "AbortError"
              ? "the send timed out"
              : "the send failed",
            sent: ids.length,
          };
        }
        await wait(Math.min(MAX_POST_BACKOFF_MS, 500 * 2 ** attempt));
        continue;
      }
      if (outcome.kind === "rate-limited") {
        await wait(outcome.retryAfterMs);
        continue;
      }
      if (outcome.kind === "unavailable") {
        await wait(Math.min(MAX_POST_BACKOFF_MS, 500 * 2 ** attempt));
        continue;
      }
      if (outcome.kind === "refused") {
        return { ok: false, error: outcome.error, sent: ids.length };
      }
      ids.push(outcome.id);
      sent = true;
    }
    if (!sent) {
      return { ok: false, error: `${options.platform} kept rate limiting the send`, sent: ids.length };
    }
  }
  return { ok: true, sent: ids.length, ids };
}

// ---------------------------------------------------------------------------
// Reconnect discipline
// ---------------------------------------------------------------------------

/** The least a reconnect loop waits, so a flapping connection cannot spin it. */
export const INGRESS_MIN_RECONNECT_DELAY_MS = 1_000;

/**
 * The most a reconnect loop waits between attempts. Without a cap a permanently
 * bad credential would back off without bound (minutes, then hours) and a
 * credential fixed while the Host runs would not be picked up for that long;
 * with the cap it retries at most every 30s, so a repaired credential is live
 * again quickly.
 */
export const INGRESS_MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * The reconnect delay after `attempt` consecutive failures (`attempt` 0 is the
 * first failure): exponential from `baseMs`, capped at `maxMs`, with equal
 * jitter — the value is drawn from [d/2, d] where `d` is the capped exponential.
 * The jitter keeps a fleet of Hosts from retrying a down platform in lockstep;
 * equal jitter is chosen over full jitter because it keeps the sequence
 * non-decreasing (the next exponential is twice the current, so its floor is the
 * current ceiling), which both avoids a retry shorter than the last and makes
 * the escalation testable without pinning the random source.
 */
export function ingressReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = exponential / 2;
  return Math.round(half + half * Math.random());
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/** The delivery shape a channel is served over. */
export type IngressTransportKind = "socket" | "poll" | "webhook";

/** What every adapter supplies, whatever its delivery shape. */
type IngressAdapterCommon = {
  /** The platform's name, for audit records and refusal details. */
  readonly platform: string;
  /** The platform's own message size limit, in characters. */
  readonly messageLimit: number;
  /**
   * Project one raw platform event onto the shared shape. The same function the
   * live client calls, so the conformance suite exercises the runtime path
   * rather than a parallel copy of it.
   */
  readonly normalise: IngressNormalise;
  /**
   * Deliver one reply, chunked at [`messageLimit`]. Absent where replies leave
   * through another process — Telegram's and Slack's senders are host-core's —
   * and the channel declares no deliverer rather than growing a second one.
   */
  readonly deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/** A channel the Host connects to and the platform pushes frames down. */
export type SocketIngressAdapter = IngressAdapterCommon & {
  readonly kind: "socket";
  /** Build one client for one connection attempt; the transport reconnects. */
  readonly openClient: (onMessage: (message: IngressMessage) => Promise<void>) => MessagingIngressClient;
};

/**
 * A position a pull channel polls from.
 *
 * Two kinds occur in the wild and they are not interchangeable. Telegram's
 * `offset` is a *count*: it moves forward, and a platform that answered a lower
 * position must not move it backwards. Matrix's `since` token is *opaque*: it
 * has no order at all, so "forward only" can only mean "the token the server
 * answered the current token with, and nothing else". The transports therefore
 * take the rule as a parameter rather than assuming a number; the default rule
 * stays the count comparison every existing channel relies on.
 */
export type IngressCursor = number | string;

/** A channel the Host asks for what is new since a cursor. */
export type PollIngressAdapter<
  TCursor extends IngressCursor = number,
> = IngressAdapterCommon & {
  readonly kind: "poll";
  /** One poll from `cursor`; a failure is reported, never thrown. */
  readonly poll: (cursor: TCursor, signal?: AbortSignal) => Promise<IngressPollResult<TCursor>>;
};

/** A channel that calls in with one request per event. */
export type WebhookIngressAdapter = IngressAdapterCommon & { readonly kind: "webhook" };

/**
 * A pull channel is admissible with either cursor kind; both instantiations are
 * named so a channel's own adapter stays precisely typed (Telegram's count,
 * Matrix's token) while the suite still accepts any of them.
 */
export type MessagingIngressAdapter =
  | SocketIngressAdapter
  | PollIngressAdapter<number>
  | PollIngressAdapter<string>
  | WebhookIngressAdapter;

/**
 * The three members every socket client offers, so the shared transport can
 * drive any of them: open one connection, wait until it is gone, close it.
 */
export interface MessagingIngressClient {
  connect(): Promise<void>;
  waitForClose(signal?: AbortSignal): Promise<void>;
  close(): void;
}

/** One poll's answer, in platform-neutral terms. */
export type IngressPollResult<TCursor extends IngressCursor = number> =
  | { ok: true; events: unknown[]; nextCursor: TCursor }
  | { ok: false; error: string; retryAfterMs?: number };

/**
 * Where a poll cursor is persisted so a restart resumes instead of replaying.
 * `load` answers the cursor the next poll asks from, or `null` when none has
 * been stored; `save` writes the cursor a poll advanced to.
 */
export interface IngressCursorStore<TCursor extends IngressCursor = number> {
  load(): Promise<TCursor | null>;
  save(cursor: TCursor): Promise<void>;
}
