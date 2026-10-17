import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressMessageKey,
  ingressReconnectDelayMs,
  INGRESS_MAX_RECONNECT_DELAY_MS,
  INGRESS_MIN_RECONNECT_DELAY_MS,
  type IngressAudit,
  type IngressCursorStore,
  type IngressDeliveryResult,
  type IngressHandledStore,
  type IngressNormalisation,
  type IngressPollResult,
  type PollIngressAdapter,
} from "./messaging-ingress.js";
import { PollingIngressTransport } from "./messaging-ingress-polling.js";

export {
  MATRIX_MESSAGE_LIMIT,
  MATRIX_TXN_ID_PREFIX,
  createMatrixSender,
  type MatrixFetch,
  type MatrixSendResult,
  type MatrixSender,
  type MatrixSenderOptions,
} from "./messaging-matrix-send.js";
import {
  MATRIX_MESSAGE_LIMIT,
  createMatrixSender,
  type MatrixFetch,
} from "./messaging-matrix-send.js";

/**
 * The inbound Matrix channel over the client-server API — the adapter half.
 *
 * Matrix's incoming direction is a *pull*: the Host long-polls
 * `GET /_matrix/client/v3/sync` and the homeserver answers with everything since
 * the `since` token it was given. Nothing binds a port and no public callback
 * URL is needed, so the acceptance precondition the other channels keep (ADR
 * 0326) stays true. There is no listener here.
 *
 * Everything a pull channel shares with its siblings is the shared layer's: the
 * cursor, the apply-then-save barrier and the failure floor
 * (`messaging-ingress-polling.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is Matrix's own:
 *
 * - **connect** — `GET /account/whoami` resolves the account's own user id, and
 *   then the sync loop starts. The id is authoritative: Matrix names the sender
 *   of every event, and a bot id in the wild varies between bridges, so the
 *   account's own id — not a configured guess — is what the own-message filter
 *   compares against. An access token (from Element, or from a password login)
 *   is the only credential; a pre-provisioned token is the primary path.
 * - **normalise** — [`normaliseMatrixEvent`]: one room event, filtered against
 *   the account's own sender, non-message event types, non-text `msgtype`s and
 *   end-to-end encrypted rooms; keyed on the room and event id.
 * - **deliver** — `PUT /rooms/{roomId}/send/m.room.message/{txnId}`, chunked by
 *   the shared chunker at [`MATRIX_MESSAGE_LIMIT`] and put sequentially, with a
 *   fresh transaction id per attempt (see `messaging-matrix-send.ts`).
 * - **limit** — [`MATRIX_MESSAGE_LIMIT`].
 *
 * # The cursor is the sync token, and it is the only replay filter
 *
 * `next_batch` from a sync answer is the token the next sync asks from. It is an
 * opaque string: it has no order, so "forward only" means "the token the server
 * answered the current token with". The polling transport applies the batch and
 * only then advances and saves the token, so a crash before the save offers the
 * batch again rather than dropping it. There is deliberately no second replay
 * filter on top: a reconnect asks from the saved token, and the homeserver
 * itself does not offer events before it.
 *
 * # Encrypted rooms are refused, not guessed at
 *
 * End-to-end encryption is not implemented in this build: this adapter holds no
 * device keys and cannot decrypt an event. A room with encryption turned on
 * delivers `m.room.encrypted` events whose `content` is opaque ciphertext, so
 * reading it is impossible rather than unimplemented-in-one-place. Such an event
 * is filtered with the reason [`MATRIX_ENCRYPTED_REASON`], and the receive path
 * emits an `encrypted` audit line naming the room so the operator can see why a
 * room went quiet. The panel's help text says the same thing in plain language.
 *
 * # Trust boundary and the credential
 *
 * The access token is a bearer credential for the sync poll, the identity lookup
 * and the send path. It travels in the `Authorization` header — the platform's
 * own location — and never in a URL, a log line, an audit entry or an error this
 * module reports. Everything arriving in a sync answer is untrusted and is
 * validated field by field before it reaches the driver.
 *
 * # Testability without a network
 *
 * The HTTP client is injected ([`MatrixFetch`]), as is the identity lookup
 * ([`MatrixIdentityLookup`]), and the cursor store is an interface. A suite
 * drives the real sync loop against an in-process fake homeserver, so identity,
 * filtering, the encrypted refusal, the cursor and the send path are all
 * reproducible with no server and no account.
 */

/** The settings section the Matrix channel's record lives in, inside `app`. */
export const MESSAGING_MATRIX_SECTION = "messagingMatrix";
/** The record's self-identifying format. */
export const MESSAGING_MATRIX_FORMAT = "pi-desktop-messaging-matrix";
/** The record version this build reads. */
export const MESSAGING_MATRIX_FORMAT_VERSION = 1;
/** Where the access token lives in the host's secret store. */
export const MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF = "secret:messaging-matrix:access-token";

/** The most event keys the settings-backed replay guard remembers. */
export const MATRIX_HANDLED_CAPACITY = 2048;

/** How long one sync long poll may stay open, in milliseconds. */
export const MATRIX_SYNC_TIMEOUT_MS = 30_000;

/** The reason an encrypted event is filtered with. */
export const MATRIX_ENCRYPTED_REASON =
  "the room event is end-to-end encrypted, which this build cannot read";

const SYNC_PATH = "/_matrix/client/v3/sync";
const WHOAMI_PATH = "/_matrix/client/v3/account/whoami";
const EVENT_MESSAGE = "m.room.message";
const EVENT_ENCRYPTED = "m.room.encrypted";
const MSGTYPE_TEXT = "m.text";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One audit record. Structure and ids only — never message text or a token. */
export type MatrixInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "identity-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  /** A room event this build cannot read because the room is encrypted. */
  | { kind: "encrypted"; reason: string; roomId: string }
  | { kind: "malformed-event"; reason: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string }
  | { kind: "cursor-save-failed"; error: string };

export type MatrixInboundAudit = (entry: MatrixInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in Matrix's published entry type: the id
 * field here is `eventId`, a malformed frame is `malformed-event`, and a cursor
 * save failure is `cursor-save-failed`.
 */
function matrixAudit(sink?: MatrixInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "malformed":
        return sink({ kind: "malformed-event", reason: entry.reason });
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
      case "identity-failed":
      case "connect-failed":
        return sink({ kind: entry.kind, error: entry.error });
      case "filtered":
        return sink({
          kind: "filtered",
          reason: entry.reason,
          ...(entry.channelId ? { channelId: entry.channelId } : {}),
        });
      default:
        // `disconnect` and `heartbeat-missed` belong to the socket channels.
        return;
    }
  };
}

/**
 * One room event as this module reads it.
 *
 * A sync answer groups events by room (`rooms.join[roomId].timeline.events`) and
 * the event itself carries no room id, so the sync parser puts the timeline's key
 * on each event before it is offered. Everything else is the event as the
 * homeserver sent it.
 */
export type MatrixRoomEvent = {
  room_id: string;
  event_id: string;
  sender: string;
  type: string;
  content?: unknown;
};

/** The base URL every Matrix path is appended to, or the reason it is refused. */
export function matrixApiBase(
  endpoint: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; base: string } | { ok: false; error: string } {
  const checked = validateInboundEndpoint(endpoint, options);
  if (!checked.ok) return checked;
  const base = `${checked.url.protocol}//${checked.url.host}${checked.url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, base };
}

/** What one classification decided. */
export type MatrixClassification =
  | { accepted: true; message: InboundMessage }
  | { accepted: false; reason: string; encrypted?: true };

/**
 * Classify one room event into the neutral message shape.
 *
 * Refused, in this order and for these reasons:
 *
 * - a payload that is not an object;
 * - an `m.room.encrypted` event — the room is encrypted and this build holds no
 *   device keys, so the text is unreadable rather than merely unknown;
 * - any event type other than `m.room.message` (membership, state, redaction,
 *   typing: the homeserver's own noise);
 * - a message whose `msgtype` is not `m.text` (an image, a file, an emote — this
 *   build acts on commands and has nothing to do with an attachment);
 * - the account's own event (Matrix echoes a send back through sync);
 * - an event naming no room, no id, or carrying no text.
 *
 * The room id is the chat id: a Matrix room is the conversation. `sender` is
 * never trusted for anything but the own-account comparison.
 */
export function classifyMatrixEvent(
  raw: unknown,
  ownUserId: string | null,
): MatrixClassification {
  if (!isRecord(raw)) return { accepted: false, reason: "event is not an object" };
  const type = typeof raw.type === "string" ? raw.type : "";
  if (type === EVENT_ENCRYPTED) {
    return { accepted: false, reason: MATRIX_ENCRYPTED_REASON, encrypted: true };
  }
  if (type !== EVENT_MESSAGE) return { accepted: false, reason: "event is not a room message" };
  const content = isRecord(raw.content) ? raw.content : null;
  const msgtype = content && typeof content.msgtype === "string" ? content.msgtype : "";
  if (msgtype !== MSGTYPE_TEXT) return { accepted: false, reason: "message is not plain text" };
  const sender = typeof raw.sender === "string" ? raw.sender.trim() : "";
  if (ownUserId !== null && sender === ownUserId) {
    return { accepted: false, reason: "event is the account's own message" };
  }
  const chatId = typeof raw.room_id === "string" ? raw.room_id.trim() : "";
  if (!chatId) return { accepted: false, reason: "event names no room" };
  const messageId = typeof raw.event_id === "string" ? raw.event_id.trim() : "";
  if (!messageId) return { accepted: false, reason: "event names no id" };
  const text = content && typeof content.body === "string" ? content.body : "";
  if (!text.trim()) return { accepted: false, reason: "message carries no text" };
  return { accepted: true, message: { messageId, chatId, text } };
}

/**
 * Project one room event onto the shared shape, keyed on the room and event id.
 *
 * An event id is unique server-wide, but the shared key helper is the one format
 * every conversation-plus-message channel uses, and the driver recomputes the
 * same key when it logs a duplicate — so the two must agree rather than each
 * inventing a separator.
 */
export function normaliseMatrixEvent(
  raw: unknown,
  ownUserId: string | null,
): IngressNormalisation {
  const classification = classifyMatrixEvent(raw, ownUserId);
  if (!classification.accepted) {
    const channelId =
      isRecord(raw) && typeof raw.room_id === "string" ? raw.room_id : undefined;
    return {
      kind: "filtered",
      reason: classification.reason,
      ...(channelId ? { channelId } : {}),
    };
  }
  const message = classification.message;
  return { kind: "message", message, key: ingressMessageKey(message.chatId, message.messageId) };
}

/** What one sync answer carried, once parsed. */
type MatrixSyncBatch = { nextBatch: string; events: MatrixRoomEvent[] };

/**
 * Parse one sync answer.
 *
 * `next_batch` is required: a batch without a cursor could be applied but could
 * never be resumed from, so the whole answer is reported as unusable instead of
 * being half-taken. The events the homeserver offered are read from every joined
 * room's timeline, with the room key put on each event. Nothing else in the
 * answer (`account_data`, `presence`, `to_device`, `ephemeral`) is read.
 */
function parseSyncAnswer(body: unknown): { ok: true; batch: MatrixSyncBatch } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "the sync answer is not an object" };
  const nextBatch = typeof body.next_batch === "string" ? body.next_batch.trim() : "";
  if (!nextBatch) return { ok: false, error: "the sync answer carried no next_batch token" };
  const events: MatrixRoomEvent[] = [];
  const rooms = isRecord(body.rooms) ? body.rooms : null;
  const join = rooms && isRecord(rooms.join) ? rooms.join : null;
  if (join) {
    for (const [roomId, room] of Object.entries(join)) {
      if (!isRecord(room)) continue;
      const timeline = isRecord(room.timeline) ? room.timeline : null;
      const list = timeline && Array.isArray(timeline.events) ? timeline.events : [];
      for (const event of list) {
        if (!isRecord(event)) continue;
        events.push({
          room_id: roomId,
          event_id: typeof event.event_id === "string" ? event.event_id : "",
          sender: typeof event.sender === "string" ? event.sender : "",
          type: typeof event.type === "string" ? event.type : "",
          content: event.content,
        });
      }
    }
  }
  return { ok: true, batch: { nextBatch, events } };
}

/** The identity answer: the account's own user id, or why it could not be read. */
export type MatrixIdentityResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/** `GET /account/whoami`, injected so a suite needs no server. */
export type MatrixIdentityLookup = (token: string) => Promise<MatrixIdentityResult>;

/** The production identity lookup: the homeserver's own answer for this token. */
export function createMatrixIdentityLookup(options: {
  endpoint: string;
  fetchImpl?: MatrixFetch;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
}): MatrixIdentityLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.requestTimeoutMs ?? 10_000;
  return async (token: string) => {
    const base = matrixApiBase(options.endpoint, {
      allowInsecureHttp: options.allowInsecureHttp,
    });
    if (!base.ok) return { ok: false, error: base.error };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${base.base}${WHOAMI_PATH}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, error: "matrix answered a redirect for the identity lookup" };
      }
      if (!response.ok) {
        return { ok: false, error: `matrix answered HTTP ${response.status} for the identity lookup` };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const userId = isRecord(body) && typeof body.user_id === "string" ? body.user_id.trim() : "";
      if (!userId) return { ok: false, error: "the identity answer named no user id" };
      return { ok: true, userId };
    } catch {
      return { ok: false, error: controller.signal.aborted ? "the identity lookup timed out" : "the identity lookup failed" };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type MatrixIngressAdapterOptions = {
  /** The homeserver base URL the user configured. */
  endpoint: string;
  /** The account's access token. */
  token: string;
  /** The account's own user id, when it is already known. */
  ownUserId?: string | null;
  /** How long one sync long poll may stay open. */
  syncTimeoutMs?: number;
  /** How long one send may take. */
  requestTimeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetchImpl?: MatrixFetch;
  wait?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  newTxnId?: () => string;
  /** Override the delivery seam; by default the adapter's own sender posts. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The Matrix ingress adapter: the platform-specific seams and nothing else.
 *
 * `poll` is one sync request from the cursor this adapter is handed; the cursor
 * type is the token, so the transport never indexes or compares it as a number.
 */
export function createMatrixIngressAdapter(
  options: MatrixIngressAdapterOptions,
): PollIngressAdapter<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const syncTimeoutMs = options.syncTimeoutMs ?? MATRIX_SYNC_TIMEOUT_MS;
  let ownUserId = options.ownUserId ?? null;
  const base = matrixApiBase(options.endpoint, {
    allowInsecureHttp: options.allowInsecureHttp,
  });
  const sender = createMatrixSender({
    endpoint: options.endpoint,
    token: options.token,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.newTxnId ? { newTxnId: options.newTxnId } : {}),
    ...(options.allowInsecureHttp !== undefined
      ? { allowInsecureHttp: options.allowInsecureHttp }
      : {}),
  });

  return {
    platform: "matrix",
    kind: "poll",
    messageLimit: MATRIX_MESSAGE_LIMIT,
    normalise: (raw) => normaliseMatrixEvent(raw, ownUserId),
    deliver: options.deliver ?? ((chatId, text) => sender.send(chatId, text)),
    poll: async (cursor, signal): Promise<IngressPollResult<string>> => {
      const token = options.token.trim();
      if (!token) return { ok: false, error: "the configured access token is empty" };
      if (!base.ok) return { ok: false, error: base.error };
      const query = new URLSearchParams({ timeout: String(syncTimeoutMs) });
      if (cursor) query.set("since", cursor);
      let response: Response;
      try {
        response = await fetchImpl(`${base.base}${SYNC_PATH}?${query.toString()}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
          redirect: "manual",
        });
      } catch {
        // An abort is this Host stopping, not the homeserver failing: report an
        // empty batch at the same cursor so the loop neither audits nor spins.
        if (signal?.aborted) return { ok: true, events: [], nextCursor: cursor };
        return { ok: false, error: "the sync request failed" };
      }
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header !== null ? Number(header) : Number.NaN;
        return {
          ok: false,
          error: "matrix is rate limiting the sync",
          retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000,
        };
      }
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, error: "matrix answered a redirect for the sync" };
      }
      if (!response.ok) {
        return { ok: false, error: `matrix answered HTTP ${response.status} for the sync` };
      }
      const parsed = parseSyncAnswer(await response.json().catch(() => null));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, events: parsed.batch.events, nextCursor: parsed.batch.nextBatch };
    },
  };
}

export type MatrixInboundTransportOptions = {
  endpoint: string;
  token: string;
  /** The account's own user id, when it is already known. */
  ownUserId?: string;
  /** The `whoami` seam, run once before the loop starts. */
  resolveIdentity?: MatrixIdentityLookup;
  /** The restart-durable replay guard, keyed on the room and event id. */
  handled: IngressHandledStore;
  /** Where the sync token is persisted so a restart resumes instead of replaying. */
  cursor: IngressCursorStore<string>;
  syncTimeoutMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: MatrixFetch;
  allowInsecureHttp?: boolean;
  audit?: MatrixInboundAudit;
  /** How the loop waits; injected so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
};

/**
 * The receive side of the Matrix channel: resolve the account's identity once,
 * then run the shared sync loop until `signal` aborts.
 *
 * The identity lookup is retried on the shared jittered backoff rather than
 * ending the loop, so a token rotated into the secret store while the Host runs
 * is picked up. Nothing is opened and nothing is polled until the identity is
 * known: without it there is no way to tell the bot's own events from anyone
 * else's, and running without that filter would make the bot answer itself.
 *
 * Each sync batch is applied through the shared dedupe gate, keyed on the room
 * and event id, so an event the homeserver offers twice — or one redelivered
 * after a restart whose cursor had not been saved — is recognised before it
 * starts a second turn.
 */
export function createMatrixInboundPushTransport(
  options: MatrixInboundTransportOptions,
): MessagingInboundPushTransport {
  const sink = options.audit;
  const audit = matrixAudit(options.audit);
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseDelay = Math.max(
    INGRESS_MIN_RECONNECT_DELAY_MS,
    options.reconnectDelayMs ?? INGRESS_MIN_RECONNECT_DELAY_MS,
  );
  const maxDelay = Math.max(baseDelay, options.maxReconnectDelayMs ?? INGRESS_MAX_RECONNECT_DELAY_MS);
  return {
    async start(onMessage, signal) {
      let ownUserId = options.ownUserId?.trim() || null;
      let failures = 0;
      while (!signal?.aborted) {
        if (!ownUserId) {
          const resolveIdentity =
            options.resolveIdentity ??
            createMatrixIdentityLookup({
              endpoint: options.endpoint,
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
              ...(options.allowInsecureHttp !== undefined
                ? { allowInsecureHttp: options.allowInsecureHttp }
                : {}),
              ...(options.requestTimeoutMs !== undefined
                ? { requestTimeoutMs: options.requestTimeoutMs }
                : {}),
            });
          const identity = await resolveIdentity(options.token);
          if (!identity.ok) {
            audit({ kind: "identity-failed", error: identity.error });
            await wait(ingressReconnectDelayMs(failures, baseDelay, maxDelay));
            failures += 1;
            continue;
          }
          ownUserId = identity.userId;
        }

        const adapter = createMatrixIngressAdapter({
          ...options,
          ownUserId,
        });
        const gate = new IngressGate({ handled: options.handled, onMessage, audit });
        const poller = new PollingIngressTransport<unknown, string>({
          poll: (cursor, pollSignal) => adapter.poll(cursor, pollSignal),
          // Every event is audited for what it was filtered as, so an encrypted
          // room leaves a line rather than going quiet with nothing to read.
          normalise: (event) => {
            const normalisation = adapter.normalise(event);
            if (normalisation.kind === "message") return normalisation;
            const roomId =
              isRecord(event) && typeof event.room_id === "string" ? event.room_id : "";
            if (isRecord(event) && event.type === EVENT_ENCRYPTED) {
              // A dedicated line, not the generic filter: an encrypted room is
              // the one filter the operator has to act on, so it says so.
              sink?.({
                kind: "encrypted",
                reason: normalisation.reason,
                roomId: roomId || normalisation.channelId || "",
              });
            } else {
              audit({
                kind: "filtered",
                reason: normalisation.reason,
                ...(roomId ? { channelId: roomId } : {}),
              });
            }
            return normalisation;
          },
          cursor: options.cursor,
          // The token is opaque: it advances only when the server answered
          // something other than what the poll asked from.
          initialCursor: "",
          nextIsAhead: (next, current) => next !== current,
          audit,
          wait,
        });
        await poller.run(async (message) => {
          const outcome = await gate.ingest(
            message,
            ingressMessageKey(message.chatId, message.messageId),
          );
          // A sync token is this channel's only redelivery mechanism. A message
          // the gate could not hand to the Host leaves the token unadvanced, so
          // the next poll is offered the same batch and the durable guard skips
          // the events that did land. Advancing here instead would drop that
          // event for good — the homeserver has no per-event acknowledgement to
          // withhold. The gate has already audited the event id; the throw only
          // stops this batch from being marked applied.
          if (outcome === "process-failed") {
            throw new Error("the inbound turn could not be started");
          }
        }, signal);
        return;
      }
    },
  };
}
