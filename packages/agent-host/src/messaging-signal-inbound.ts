/**
 * The inbound Signal channel — the adapter half, over a signal-cli bridge.
 *
 * Signal's incoming direction here is a *pull*: the Host asks the bridge for
 * new envelopes and the bridge long-polls its own queue until something arrives
 * or its timeout expires. Nothing binds a port, no webhook exists and no public
 * address is needed — the connection is one the Host originates, to a process on
 * this machine. That is why the settings card says "a bridge you run yourself":
 * this build does not bundle, install, register or supervise signal-cli.
 *
 * Everything a pull channel shares with its siblings is the shared layer's: the
 * cursor, the apply-then-save barrier and the failure floor
 * (`messaging-ingress-polling.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is Signal's own:
 *
 * - **poll** — one `receive` call on the bridge client.
 * - **normalise** — [`normaliseSignalEnvelope`]: one envelope, filtered against
 *   receipts and typing notifications, this channel's own echo, an empty body
 *   and a missing sender or timestamp.
 * - **deliver** — one `send` call per chunk (see `messaging-signal-client.ts`),
 *   chunked by the shared character-aware chunker so a long reply becomes
 *   ordered messages rather than one truncation.
 * - **limit** — [`SIGNAL_MESSAGE_LIMIT`], declared in **characters**.
 *
 * # Message identity: timestamp, sender, body
 *
 * signal-cli's envelopes carry no message id. What they do carry is the sender's
 * own `timestamp` (milliseconds), the sender, and the body — so the replay key
 * is a hash over exactly those three, and it is stable across a restart, a
 * bridge restart and a redelivery. The timestamp alone is not enough: two
 * messages from one sender inside the same millisecond are possible on a busy
 * device, and a key that collapsed them would drop one. The body hash separates
 * them; if two *identical* bodies from one sender share a millisecond, they are
 * indistinguishable at this interface and are treated as one — the safe
 * direction, since a duplicate turn is worse than a merged one. There is no id
 * to use instead; that is the whole reason for the hash.
 *
 * # The cursor is a high-water mark, not a resume position
 *
 * `receive` has no "since" parameter and the bridge drains its own queue, so
 * there is no position to ask from. The polling transport still records the
 * newest envelope timestamp it saw — visible in the audit trail and saved like
 * any other cursor — but this adapter deliberately does **not** discard
 * envelopes older than it. Timestamps come from the *sender's* clock, and a
 * phone whose clock is a minute behind would have every message dropped by a
 * timestamp filter. Redelivery is handled where it can be handled exactly: by
 * the replay key above and the shared dedupe gate.
 *
 * # A number is a remote control unless the sender is checked
 *
 * Knowing an account's number is not an accident of a chat id — numbers are
 * shared, forwarded and guessed. So a message becomes a turn only when its
 * sender — the same identity this channel resolves for a reply, `sourceNumber`
 * then `sourceUuid` then `source` — is on the configured allowlist. Everything
 * else is dropped with one audit line naming the reason and nothing else: not
 * the sender, not the body. An **empty** allowlist permits nobody; it is a
 * channel that receives nothing, never one that accepts everything.
 *
 * A group is judged by the member who wrote, not by the group id. Membership is
 * not trust: a group the channel was added to does not grant every member the
 * right to command it, so there is exactly one rule for direct and group
 * messages alike, and it is the sender's.
 *
 * # Own echo
 *
 * A message this channel sent comes back in `receive` as a `syncMessage`, not a
 * `dataMessage`, so it is dropped before its body is even read. A note-to-self
 * arrives as a real `dataMessage` whose sender is the configured account, so the
 * own-identity check drops that too. Without both, replying to yourself would be
 * an infinite conversation.
 *
 * # Inbound is not instant
 *
 * The receive loop sleeps a minimum interval between polls (the shared floor), so
 * even when the bridge answers immediately a message is acted on within roughly
 * that interval. The panel says "polls", not "pushes".
 */

import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import {
  IngressGate,
  chunkIngressText,
  deliverInChunks,
  ingressMessageKey,
  type IngressAudit,
  type IngressCursorStore,
  type IngressDeliveryResult,
  type IngressHandledStore,
  type IngressNormalisation,
  type IngressPollResult,
  type IngressPostOutcome,
  type PollIngressAdapter,
} from "./messaging-ingress.js";
import { PollingIngressTransport } from "./messaging-ingress-polling.js";
import {
  SIGNAL_DEFAULT_BRIDGE_URL,
  SIGNAL_DEFAULT_RECEIVE_TIMEOUT_S,
  SIGNAL_DEFAULT_REQUEST_TIMEOUT_MS,
  SignalRpcClient,
  type SignalFetch,
  type SignalRpcAnswer,
} from "./messaging-signal-client.js";

export {
  SIGNAL_DEFAULT_BRIDGE_URL,
  SIGNAL_DEFAULT_RECEIVE_TIMEOUT_S,
  SIGNAL_DEFAULT_REQUEST_TIMEOUT_MS,
  SIGNAL_RPC_PATH,
  SignalRpcClient,
  readSignalRpcAnswer,
  signalRpcUrl,
  type SignalFetch,
  type SignalRpcAnswer,
  type SignalRpcClientOptions,
  type SignalRpcFailure,
  type SignalSendResult,
} from "./messaging-signal-client.js";

/** The settings section the Signal channel's record lives in, inside `app`. */
export const MESSAGING_SIGNAL_SECTION = "messagingSignal";
/** The record's self-identifying format. */
export const MESSAGING_SIGNAL_FORMAT = "pi-desktop-messaging-signal";
/** The record version this build reads. */
export const MESSAGING_SIGNAL_FORMAT_VERSION = 1;
/** Where the optional bridge bearer token lives in the secret store. */
export const MESSAGING_SIGNAL_TOKEN_SECRET_REF = "secret:messaging-signal:token";

/** The most message keys the settings-backed replay guard remembers. */
export const SIGNAL_HANDLED_CAPACITY = 2048;

/**
 * The reply budget, in characters.
 *
 * Signal's text messages are limited in practice to about two thousand
 * characters; a longer reply is split into ordered messages by the shared
 * chunker rather than truncated. Characters, not bytes: the limit is a count of
 * what the user typed, and the chunker never splits a surrogate pair.
 */
export const SIGNAL_MESSAGE_LIMIT = 2_000;

/** How many envelopes one poll hands to the gate, so one batch cannot become a burst. */
export const SIGNAL_MAX_ENVELOPES_PER_POLL = 20;

/** The prefix a group chat id carries, so a send knows which `send` shape to use. */
export const SIGNAL_GROUP_CHAT_PREFIX = "group:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One audit record. Structure and ids only — never message text and never a token. */
export type SignalInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed"; reason: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string }
  | { kind: "cursor-save-failed"; error: string };

export type SignalInboundAudit = (entry: SignalInboundAuditEntry) => void;

/** The shared audit vocabulary expressed in Signal's published entry type. */
function signalAudit(sink?: SignalInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "malformed":
        return sink({ kind: "malformed", reason: entry.reason });
      case "duplicate":
      case "processed":
        return sink({ kind: entry.kind, eventId: entry.eventId });
      case "process-failed":
        return sink({ kind: entry.kind, eventId: entry.eventId, error: entry.error });
      case "record-failed":
        return entry.eventId === "poll-cursor"
          ? sink({ kind: "cursor-save-failed", error: entry.error })
          : sink({ kind: "record-failed", eventId: entry.eventId, error: entry.error });
      case "auth-failed":
      case "connect-failed":
        return sink({ kind: entry.kind, error: entry.error });
      case "filtered":
        return sink({
          kind: "filtered",
          reason: entry.reason,
          ...(entry.channelId ? { channelId: entry.channelId } : {}),
        });
      default:
        // `disconnect`, `identity-failed` and `heartbeat-missed` belong to the
        // socket channels.
        return;
    }
  };
}

/** A 32-bit FNV-1a hash, hex. Stable across processes, which `String.hashCode` is not. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The message id for one envelope: the sender's timestamp plus a hash of the
 * sender and the body.
 *
 * Exported because the replay key is the channel's identity rule and a test —
 * or a future migration that has to recompute old keys — must be able to derive
 * it without re-implementing the format. See the module comment for why the
 * timestamp alone is not used.
 */
export function signalMessageId(timestamp: number, source: string, text: string): string {
  return `${timestamp}-${fnv1a(`${source}\u0000${text}`)}`;
}

/** What one classification decided. */
export type SignalClassification =
  | { accepted: true; message: InboundMessage; sender: string }
  | { accepted: false; reason: string; sender?: string };

export type SignalClassifyOptions = {
  /**
   * Identities that belong to this channel itself: the configured account
   * number, and its UUID when the user supplies one. An envelope from any of
   * them is this channel's own message coming back.
   */
  ownIdentities: readonly string[];
  /**
   * The senders a message may come from — numbers, or UUIDs where the bridge
   * reports one. Compared case-insensitively against the identity this module
   * resolves for the envelope. Empty means nobody: an unset list is a channel
   * that receives nothing, not one that accepts everything.
   */
  allowedSenders: readonly string[];
};

/** Normalise one allowlist entry: trimmed, and lowercased for comparison. */
function signalIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalise an allowlist: an array, or a comma/whitespace-separated string,
 * with blank entries and repeats dropped.
 *
 * Each entry is split on commas and whitespace as well, so a record written by
 * another path with `"a, b"` as one element is read the same way, and an entry
 * that is only a separator cannot become an "identity" that widens the list.
 * Exported for the settings writer and the wiring, so the form, the record and
 * the check agree on what one entry is.
 */
export function normaliseSignalSenders(value: unknown): string[] {
  const fields = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : [];
  const out: string[] = [];
  for (const field of fields) {
    for (const entry of field.split(/[,\s]+/)) {
      const identity = signalIdentity(entry);
      if (identity !== "" && !out.includes(identity)) out.push(identity);
    }
  }
  return out;
}

/** The envelope body, whether the bridge wrapped it (`{ envelope }`) or not. */
export function signalEnvelopeBody(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.envelope)) return raw.envelope;
  // A bare envelope: the daemon's push frame shape. Detected by the fields an
  // envelope has, so a wrapper that happens to carry an `envelope` key with a
  // non-object value is not mistaken for one.
  if ("sourceNumber" in raw || "sourceUuid" in raw || "dataMessage" in raw) return raw;
  return null;
}

/** The sender's timestamp: the data message's own, else the envelope's. */
function envelopeTimestamp(envelope: Record<string, unknown>): number | null {
  const data = isRecord(envelope.dataMessage) ? envelope.dataMessage : null;
  const candidates = [data?.timestamp, envelope.timestamp];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** The sender's identity: the number when present, else the UUID, else `source`. */
function envelopeSender(envelope: Record<string, unknown>): string {
  for (const field of ["sourceNumber", "sourceUuid", "source"]) {
    const value = envelope[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Classify one envelope into the neutral message shape.
 *
 * Refused, in this order and for these reasons — each a structural fact, never
 * the message's content:
 *
 * 1. the entry is not an envelope at all (a bridge wrapper of another shape);
 * 2. the envelope names no sender;
 * 3. it carries no `dataMessage` — a receipt, a typing notification, a read
 *    marker, a `syncMessage` (our own sent messages), a call event, a sticker
 *    pack sync: all of these are envelopes and none of them is a message;
 * 4. the sender is this channel's own account (a note-to-self);
 * 5. the sender is not on the allowlist — the remote-control guard. This is the
 *    sender of the message in a group too; the group id never stands in for it;
 * 6. the data message carries no text — an attachment-only message, a reaction,
 *    a deletion or an edit.
 *
 * Group messages keep their group in the chat id (`group:<groupId>`), because
 * that is where a reply has to go; a direct message's chat id is the sender's
 * number, because Signal has no room, only correspondents.
 */
export function classifySignalEnvelope(
  raw: unknown,
  options: SignalClassifyOptions,
): SignalClassification {
  const envelope = signalEnvelopeBody(raw);
  if (!envelope) return { accepted: false, reason: "the entry is not a Signal envelope" };

  const sender = envelopeSender(envelope);
  if (sender === "") return { accepted: false, reason: "the envelope names no sender" };

  const data = envelope.dataMessage;
  if (!isRecord(data)) {
    return { accepted: false, reason: "the envelope carries no data message", sender };
  }

  const own = new Set(
    options.ownIdentities.map((identity) => identity.trim()).filter((identity) => identity !== ""),
  );
  if (own.has(sender)) {
    return { accepted: false, reason: "the message is this channel's own message", sender };
  }

  const allowlist = new Set(options.allowedSenders.map(signalIdentity));
  if (!allowlist.has(signalIdentity(sender))) {
    // Deliberately no sender in the record: an unknown number is exactly the
    // value a stranger controls, so it must not be echoed into a log by them.
    return { accepted: false, reason: "the sender is not on the allowlist" };
  }

  const text = typeof data.message === "string" ? data.message : "";
  if (text.trim() === "") {
    // Attachments are out of scope, and a reaction/delete/edit carries no body
    // of its own. Saying "no text" is the honest reason for all of them.
    return { accepted: false, reason: "the message carries no text", sender };
  }

  const stamp = envelopeTimestamp(envelope);
  if (stamp === null) {
    return { accepted: false, reason: "the message names no timestamp", sender };
  }

  const groupInfo = isRecord(data.groupInfo) ? data.groupInfo : null;
  const groupId = groupInfo && typeof groupInfo.groupId === "string" ? groupInfo.groupId.trim() : "";
  const chatId = groupId !== "" ? `${SIGNAL_GROUP_CHAT_PREFIX}${groupId}` : sender;

  return {
    accepted: true,
    sender,
    message: { messageId: signalMessageId(stamp, sender, text), chatId, text },
  };
}

/** Project one envelope onto the shared shape, keyed on the chat and message id. */
export function normaliseSignalEnvelope(
  raw: unknown,
  options: SignalClassifyOptions,
): IngressNormalisation {
  const classification = classifySignalEnvelope(raw, options);
  if (!classification.accepted) {
    return {
      kind: "filtered",
      reason: classification.reason,
      ...(classification.sender ? { channelId: classification.sender } : {}),
    };
  }
  const message = classification.message;
  return { kind: "message", message, key: ingressMessageKey(message.chatId, message.messageId) };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type SignalIngressAdapterOptions = {
  /** The bridge base, e.g. `http://127.0.0.1:8080`. */
  bridgeUrl: string;
  /** The Signal account this channel speaks as, e.g. `+15551234567`. */
  account: string;
  /** An optional bearer token for the bridge. Never logged. */
  token?: string;
  /** Additional identities that are this channel (a UUID, a second number). */
  ownIdentities?: readonly string[];
  /**
   * The senders a message may come from. Empty means nobody: the poll is
   * refused, exactly as the email channel refuses to connect for an empty list.
   */
  allowedSenders: readonly string[];
  /** How long one `send` may take. */
  requestTimeoutMs?: number;
  /** How long one `receive` asks the bridge to block, in seconds. */
  receiveTimeoutS?: number;
  /** How many envelopes one poll hands over. */
  maxEnvelopesPerPoll?: number;
  /** Test seam: the HTTP call. */
  fetchImpl?: SignalFetch;
  /** Test seam: the client, in place of the one built from the options. */
  client?: SignalRpcClient;
  /** Where filtered and malformed envelopes are reported. */
  audit?: SignalInboundAudit;
  /** Override the delivery seam; by default the adapter's own client sends. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The Signal adapter's concrete shape: a poll whose events are envelopes, not
 * `unknown`.
 *
 * The shared `PollIngressAdapter` types a poll's events as `unknown[]`, which is
 * right for the suite but loses the one fact this channel's own loop needs: the
 * events it hands to `normalise` are `unknown` envelopes. Narrowing here keeps
 * the transport typed without a cast at the call site, exactly as the email
 * adapter does.
 */
export type SignalIngressAdapter = Omit<PollIngressAdapter<number>, "poll" | "deliver"> & {
  readonly poll: (
    cursor: number,
    signal?: AbortSignal,
  ) => Promise<IngressPollResult<number>>;
  readonly deliver: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/** The `send` target a chat id names: a group, or one correspondent. */
export function signalSendTarget(chatId: string): { recipient: string } | { groupId: string } {
  const trimmed = chatId.trim();
  if (trimmed.startsWith(SIGNAL_GROUP_CHAT_PREFIX)) {
    return { groupId: trimmed.slice(SIGNAL_GROUP_CHAT_PREFIX.length) };
  }
  return { recipient: trimmed };
}

/**
 * The Signal ingress adapter: the platform-specific seams and nothing else.
 *
 * A refused or unreachable bridge is reported as `ok: false`, never thrown, so
 * the shared loop backs off and retries instead of the Host failing. The token
 * never reaches an audit record: failures are the client's own short reasons,
 * and the client never puts the credential in one.
 */
export function createSignalIngressAdapter(
  options: SignalIngressAdapterOptions,
): SignalIngressAdapter {
  const audit = signalAudit(options.audit);
  const ownIdentities = [options.account, ...(options.ownIdentities ?? [])];
  const allowedSenders = normaliseSignalSenders(options.allowedSenders);
  const maxPerPoll = Math.max(1, options.maxEnvelopesPerPoll ?? SIGNAL_MAX_ENVELOPES_PER_POLL);
  const client =
    options.client ??
    new SignalRpcClient({
      bridgeUrl: options.bridgeUrl,
      account: options.account,
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.receiveTimeoutS !== undefined ? { receiveTimeoutS: options.receiveTimeoutS } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

  /** One `receive`, with the bridge's own failures reported rather than thrown. */
  const pollOnce = async (
    cursor: number,
    signal?: AbortSignal,
  ): Promise<IngressPollResult<number>> => {
    if (options.account.trim() === "") {
      return { ok: false, error: "the channel has no Signal account configured" };
    }
    if (allowedSenders.length === 0) {
      // Fail closed and say so. Polling here would only fetch messages that
      // every one of them would then be refused, so the loop states the real
      // fault instead: this channel has no senders it may obey.
      return { ok: false, error: "the channel has no allowed senders configured" };
    }
    const answer = await client.receive(signal);
    if (!answer.ok) {
      // A poll the Host itself cancelled is a clean stop, not a failure: the
      // loop's own abort check ends it on the next iteration.
      if (answer.reason === "aborted" && signal?.aborted) {
        return { ok: true, events: [], nextCursor: cursor };
      }
      if (answer.reason === "unreachable" || answer.reason === "http-status") {
        audit({ kind: "connect-failed", error: answer.error });
      }
      return { ok: false, error: answer.error };
    }
    const envelopes = answer.result.envelopes.slice(0, maxPerPoll);
    let highest = cursor;
    for (const envelope of envelopes) {
      const body = signalEnvelopeBody(envelope);
      if (!body) continue;
      const stamp = envelopeTimestamp(body);
      if (stamp !== null && stamp > highest) highest = stamp;
    }
    return { ok: true, events: envelopes, nextCursor: highest };
  };

  /**
   * The reply path: chunked at [`SIGNAL_MESSAGE_LIMIT`] characters, then one
   * `send` per chunk.
   *
   * A reply over the limit becomes several messages rather than one the bridge
   * refuses, and they leave in the order they were written because the shared
   * chunker posts each only after the previous one was accepted. A refusal is
   * reported as the chunk's refusal with the count already sent, so a partial
   * reply is visible rather than silent.
   */
  const deliverDefault = (chatId: string, text: string): Promise<IngressDeliveryResult> => {
    const target = signalSendTarget(chatId);
    return deliverInChunks(text, {
      platform: "signal",
      limit: SIGNAL_MESSAGE_LIMIT,
      limitUnit: "characters",
      chunk: (reply) => chunkIngressText(reply, SIGNAL_MESSAGE_LIMIT, "characters"),
      post: async (chunk): Promise<IngressPostOutcome> => {
        const answer: SignalRpcAnswer<{ timestamp: number | null }> = await client.send(
          target,
          chunk,
        );
        if (!answer.ok) {
          // A bridge that is down is worth retrying; a refused call (an
          // unregistered recipient, a device that is not linked) is not.
          if (answer.reason === "unreachable" || answer.reason === "timeout") {
            return { kind: "unavailable" };
          }
          if (answer.reason === "http-status" && (answer.status ?? 0) >= 500) {
            return { kind: "unavailable" };
          }
          return { kind: "refused", error: answer.error };
        }
        return {
          kind: "accepted",
          id: answer.result.timestamp !== null
            ? String(answer.result.timestamp)
            : `sent-${Date.now()}`,
        };
      },
    });
  };

  /**
   * The projection, plus the audit line a refusal owes.
   *
   * A filtered envelope is dropped by the shared poll loop before the gate sees
   * it, so the channel that decided to refuse is the only place the record can
   * be written. The reason is a structural fact; the sender is included only
   * where classification judged the sender itself safe to name.
   */
  const normalise = (raw: unknown): IngressNormalisation => {
    const normalisation = normaliseSignalEnvelope(raw, { ownIdentities, allowedSenders });
    if (normalisation.kind === "filtered") {
      audit({
        kind: "filtered",
        reason: normalisation.reason,
        ...(normalisation.channelId ? { channelId: normalisation.channelId } : {}),
      });
    }
    return normalisation;
  };

  return {
    platform: "signal",
    kind: "poll",
    messageLimit: SIGNAL_MESSAGE_LIMIT,
    messageLimitUnit: "characters",
    normalise,
    deliver: options.deliver ?? deliverDefault,
    poll: pollOnce,
  };
}

export type SignalInboundTransportOptions = {
  bridgeUrl: string;
  account: string;
  token?: string;
  ownIdentities?: readonly string[];
  /** The senders a message may come from. Empty receives nothing. */
  allowedSenders: readonly string[];
  requestTimeoutMs?: number;
  receiveTimeoutS?: number;
  maxEnvelopesPerPoll?: number;
  /** The restart-durable replay guard, keyed on the chat and message key. */
  handled: IngressHandledStore;
  /**
   * The newest envelope timestamp, persisted so an operator can see where the
   * channel got to. It is not a resume position — see the module comment.
   */
  cursor?: IngressCursorStore<number>;
  fetchImpl?: SignalFetch;
  audit?: SignalInboundAudit;
  /** How the loop waits; injected so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The receive side of the Signal channel: run the shared poll loop until
 * `signal` aborts.
 *
 * Each polled batch is applied through the shared dedupe gate, keyed on the
 * chat and the timestamp-plus-body hash, so an envelope the bridge offers twice
 * — or one redelivered after a restart — is recognised before it starts a
 * second turn. An envelope the gate could not hand to the Host throws, which
 * leaves the batch un-applied and the loop to retry it; the bridge's queue is
 * the redelivery mechanism (it holds what it has not been asked for until it is
 * asked again).
 */
export function createSignalInboundPushTransport(
  options: SignalInboundTransportOptions,
): MessagingInboundPushTransport {
  const audit = signalAudit(options.audit);
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async start(onMessage, signal) {
      const adapter = createSignalIngressAdapter({
        bridgeUrl: options.bridgeUrl,
        account: options.account,
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.ownIdentities !== undefined ? { ownIdentities: options.ownIdentities } : {}),
        allowedSenders: options.allowedSenders,
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
        ...(options.receiveTimeoutS !== undefined
          ? { receiveTimeoutS: options.receiveTimeoutS }
          : {}),
        ...(options.maxEnvelopesPerPoll !== undefined
          ? { maxEnvelopesPerPoll: options.maxEnvelopesPerPoll }
          : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        audit: options.audit ?? (() => {}),
      });
      const gate = new IngressGate({ handled: options.handled, onMessage, audit });
      const poller = new PollingIngressTransport<unknown, number>({
        poll: (cursor, pollSignal) => adapter.poll(cursor, pollSignal),
        normalise: (event: unknown) => adapter.normalise(event),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        initialCursor: 0,
        audit,
        wait,
      });
      await poller.run(async (message) => {
        const outcome = await gate.ingest(
          message,
          ingressMessageKey(message.chatId, message.messageId),
        );
        if (outcome === "process-failed") {
          throw new Error("the inbound turn could not be started");
        }
      }, signal);
    },
  };
}

/** The default bridge base, for a settings form that opens empty. */
export const SIGNAL_DEFAULT_ENDPOINT = SIGNAL_DEFAULT_BRIDGE_URL;
