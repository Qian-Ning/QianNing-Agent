/**
 * The inbound ntfy channel — the adapter half.
 *
 * ntfy's incoming direction is a *pull*: the Host holds
 * `GET {base}/{topic}/json?since=<id>` open and the server streams new messages
 * down it as newline-delimited JSON (NDJSON). Nothing binds a port and no public
 * callback URL is needed, so the acceptance precondition the other channels keep
 * (ADR 0326) stays true. There is no listener here.
 *
 * Everything a pull channel shares with its siblings is the shared layer's: the
 * cursor, the apply-then-save barrier and the failure floor
 * (`messaging-ingress-polling.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is ntfy's own:
 *
 * - **connect** — one long poll from the cursor the shared transport hands in.
 * - **normalise** — [`normaliseNtfyEvent`]: one NDJSON object, filtered against
 *   keepalive frames, this channel's own marker, an empty body and a missing id;
 *   keyed on the topic and the message id.
 * - **deliver** — `POST {base}/{topic}`, chunked by the shared byte-aware
 *   chunker at [`NTFY_MESSAGE_LIMIT`] and posted in order (see
 *   `messaging-ntfy-send.ts`).
 * - **limit** — [`NTFY_MESSAGE_LIMIT`], declared in **bytes**.
 *
 * # The cursor is a string, and it is the message id
 *
 * ntfy numbers nothing. `since=<id>` means "everything published after the
 * message with this id", so the position is an opaque string with no order: it
 * cannot be compared, only carried. The polling transport is built for exactly
 * that ([`IngressCursor`] accepts a string and `nextIsAhead` is stated as "the
 * server answered something other than what the poll asked from"), applies the
 * batch, and only then advances and saves the id — so a crash before the save
 * offers the batch again rather than dropping it, and a restart resumes from the
 * saved id instead of replaying the topic.
 *
 * Own messages are part of the batch and therefore also move the cursor: a
 * message this channel published is dropped by the filter but the position
 * still moves past it, otherwise the poll would be offered it again on every
 * iteration and the channel would spin on its own output.
 *
 * # NDJSON arrives in pieces that do not respect line boundaries
 *
 * A TCP read is not a line. One read can carry three events and the next can
 * carry the first half of a fourth, and a JSON object split across two reads is
 * still one message. [`NtfyNdjsonSplitter`] therefore buffers until it sees a
 * newline, decodes UTF-8 with a streaming decoder so a multibyte character split
 * across two reads is reassembled before the line is parsed, and only then hands
 * whole lines to the parser. An empty line is a keepalive probe and produces
 * nothing.
 *
 * # Keepalive frames are not messages
 *
 * ntfy sends `{"event":"keepalive"}` and `{"event":"open"}` frames to hold the
 * stream open, plus a bare newline every so often. They are dropped at the parse
 * step and, defensively, filtered again by [`classifyNtfyEvent`]: neither may
 * ever become a turn.
 *
 * # Trust boundary and the credential
 *
 * The access token is a bearer credential for both directions, carried in the
 * `Authorization` header — the platform's own location — and never in a URL, a
 * log line, an audit entry or an error this module reports. Everything arriving
 * on the stream is untrusted and is validated field by field before it reaches
 * the driver.
 *
 * # Testability without a network
 *
 * The HTTP client is injected ([`NtfyFetch`]) and the cursor store is an
 * interface, so a suite drives the real poll loop against an in-process fake
 * ntfy listening on a loopback port. Nothing leaves the machine.
 */

import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressMessageKey,
  type IngressAudit,
  type IngressCursorStore,
  type IngressDeliveryResult,
  type IngressHandledStore,
  type IngressNormalisation,
  type IngressPollResult,
  type PollIngressAdapter,
} from "./messaging-ingress.js";
import { PollingIngressTransport } from "./messaging-ingress-polling.js";
import {
  NTFY_MESSAGE_LIMIT,
  NTFY_OWN_TAG,
  createNtfySender,
  isValidNtfyTopic,
  ntfyApiBase,
  type NtfyFetch,
} from "./messaging-ntfy-send.js";

export {
  NTFY_MESSAGE_LIMIT,
  NTFY_OWN_TAG,
  createNtfySender,
  isValidNtfyTopic,
  ntfyApiBase,
  type NtfyFetch,
  type NtfySendResult,
  type NtfySender,
  type NtfySenderOptions,
} from "./messaging-ntfy-send.js";

/** The settings section the ntfy channel's record lives in, inside `app`. */
export const MESSAGING_NTFY_SECTION = "messagingNtfy";
/** The record's self-identifying format. */
export const MESSAGING_NTFY_FORMAT = "pi-desktop-messaging-ntfy";
/** The record version this build reads. */
export const MESSAGING_NTFY_FORMAT_VERSION = 1;
/** Where the optional access token lives in the host's secret store. */
export const MESSAGING_NTFY_ACCESS_TOKEN_SECRET_REF = "secret:messaging-ntfy:access-token";

/** The most message ids the settings-backed replay guard remembers. */
export const NTFY_HANDLED_CAPACITY = 2048;

/** How long one `/json` long poll may stay open, in milliseconds. */
export const NTFY_POLL_TIMEOUT_MS = 30_000;

/** The public ntfy server, the form's opening endpoint. */
export const NTFY_DEFAULT_ENDPOINT = "https://ntfy.sh";

const JSON_STREAM_SUFFIX = "/json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One audit record. Structure and ids only — never message text or a token. */
export type NtfyInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed"; reason: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string }
  | { kind: "cursor-save-failed"; error: string };

export type NtfyInboundAudit = (entry: NtfyInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in ntfy's published entry type: a
 * malformed frame is `malformed`, and a cursor save failure is
 * `cursor-save-failed` rather than a generic record failure.
 */
function ntfyAudit(sink?: NtfyInboundAudit): IngressAudit {
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

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

/**
 * The byte-to-line splitter for an ndjson stream.
 *
 * Two things it must get right, because a socket does not:
 *
 * 1. **Lines do not align with reads.** The buffer is kept between pushes and a
 *    line is emitted only once its newline has arrived, so one read holding
 *    three events yields three lines and a read holding half an object yields
 *    none until the rest arrives.
 * 2. **A multibyte character can straddle two reads.** The decoder runs in
 *    streaming mode, so an incomplete UTF-8 sequence at the end of one chunk is
 *    held until the next chunk completes it instead of becoming a replacement
 *    character in the middle of a message.
 *
 * A trailing `\r` is stripped (a server may end its lines either way), and an
 * empty or whitespace-only line — ntfy's keepalive probe — is not emitted.
 */
export class NtfyNdjsonSplitter {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  /** Feed one read; answers the whole lines it completed, in order. */
  push(chunk: string | Uint8Array): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") lines.push(line);
    }
    return lines;
  }

  /** Feed the end of the stream: a last line without a newline still counts. */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    return rest.trim() === "" ? [] : [rest];
  }
}

/** What one parsed line is: a message to consider, or a frame to drop. */
export type NtfyStreamFrame =
  | { kind: "message"; event: Record<string, unknown> }
  | { kind: "ignored"; reason: string }
  | { kind: "malformed"; reason: string };

/**
 * Classify one ndjson line.
 *
 * `message` is the only frame that can reach the routing path. `open`,
 * `keepalive` and `poll_request` are the platform holding the stream open, and
 * anything without an `event` field or without an id is not a message this build
 * can act on. A line that is not JSON is reported as malformed rather than
 * thrown: one corrupt frame must not end the poll.
 */
export function parseNtfyLine(line: string): NtfyStreamFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: "malformed", reason: "an ndjson line is not valid JSON" };
  }
  if (!isRecord(parsed)) return { kind: "malformed", reason: "the ndjson line is not an object" };
  const event = typeof parsed.event === "string" ? parsed.event : "";
  if (event === "keepalive") return { kind: "ignored", reason: "the frame is a keepalive" };
  if (event === "open") return { kind: "ignored", reason: "the frame opens the stream" };
  if (event === "poll_request") return { kind: "ignored", reason: "the frame is a poll notification" };
  if (event !== "message") return { kind: "ignored", reason: "the frame is not a message" };
  if (typeof parsed.id !== "string" || parsed.id.trim() === "") {
    return { kind: "malformed", reason: "the message frame carries no id" };
  }
  return { kind: "message", event: parsed };
}

// ---------------------------------------------------------------------------
// Classification and normalisation
// ---------------------------------------------------------------------------

/** What one classification decided. */
export type NtfyClassification =
  | { accepted: true; message: InboundMessage }
  | { accepted: false; reason: string };

/**
 * Classify one message frame into the neutral message shape.
 *
 * Refused, in this order and for these reasons:
 *
 * - a payload that is not an object, or a frame that is not a `message` (a
 *   keepalive, an `open`, a malformed line): the platform's own noise;
 * - a message carrying [`NTFY_OWN_TAG`] — this channel published it, and reading
 *   it back would turn every reply into another turn;
 * - a message with no text (an attachment-only notification, or a blank body);
 * - a message naming no id.
 *
 * The topic is the chat id: on ntfy a topic *is* the conversation. The topic is
 * taken from the frame when the server echoes it and from the configuration
 * otherwise, and the two are the same topic by construction.
 */
export function classifyNtfyEvent(raw: unknown, topic: string): NtfyClassification {
  if (!isRecord(raw)) return { accepted: false, reason: "the ntfy event is not an object" };
  if (typeof raw.event === "string" && raw.event !== "message") {
    return { accepted: false, reason: "the ntfy frame is not a message" };
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase())
    : [];
  if (tags.includes(NTFY_OWN_TAG)) {
    return { accepted: false, reason: "the message is this channel's own publish" };
  }
  const messageId = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!messageId) return { accepted: false, reason: "the message names no id" };
  const text = typeof raw.message === "string" ? raw.message : "";
  if (!text.trim()) return { accepted: false, reason: "the message carries no text" };
  const frameTopic = typeof raw.topic === "string" ? raw.topic.trim() : "";
  const chatId = frameTopic || topic.trim();
  if (!chatId) return { accepted: false, reason: "the message names no topic" };
  return { accepted: true, message: { messageId, chatId, text } };
}

/**
 * Project one message frame onto the shared shape, keyed on the topic and id.
 *
 * The key format is the shared helper's, because the driver recomputes the same
 * key when it logs a duplicate; a channel that restated the separator would
 * silently stop recognising its own redeliveries.
 */
export function normaliseNtfyEvent(raw: unknown, topic: string): IngressNormalisation {
  const classification = classifyNtfyEvent(raw, topic);
  if (!classification.accepted) {
    const channelId =
      isRecord(raw) && typeof raw.topic === "string" && raw.topic.trim()
        ? raw.topic.trim()
        : topic.trim() || undefined;
    return {
      kind: "filtered",
      reason: classification.reason,
      ...(channelId ? { channelId } : {}),
    };
  }
  const message = classification.message;
  return { kind: "message", message, key: ingressMessageKey(message.chatId, message.messageId) };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type NtfyIngressAdapterOptions = {
  /** The ntfy server's base URL the user configured. */
  endpoint: string;
  /** The topic the channel publishes to and reads from. */
  topic: string;
  /** An access token for a protected topic; absent means an open topic. */
  token?: string;
  /** How long one `/json` long poll may stay open. */
  pollTimeoutMs?: number;
  /** How long one publish may take. */
  requestTimeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetchImpl?: NtfyFetch;
  wait?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Where a malformed frame is reported; absent means it is dropped. */
  audit?: NtfyInboundAudit;
  /** Override the delivery seam; by default the adapter's own sender posts. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The ntfy ingress adapter: the platform-specific seams and nothing else.
 *
 * `poll` is one `/json` request from the cursor this adapter is handed; the
 * cursor type is the message id, so the transport never indexes or compares it
 * as a number.
 */
export function createNtfyIngressAdapter(
  options: NtfyIngressAdapterOptions,
): PollIngressAdapter<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const topic = options.topic.trim();
  const pollTimeoutMs = options.pollTimeoutMs ?? NTFY_POLL_TIMEOUT_MS;
  const token = options.token?.trim() ?? "";
  const audit = ntfyAudit(options.audit);
  const base = ntfyApiBase(options.endpoint, {
    allowInsecureHttp: options.allowInsecureHttp,
  });
  const sender = createNtfySender({
    endpoint: options.endpoint,
    topic,
    ...(token ? { token } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.allowInsecureHttp !== undefined
      ? { allowInsecureHttp: options.allowInsecureHttp }
      : {}),
  });

  /** Read the whole stream, answering the message frames it carried. */
  const readStream = async (
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal | undefined,
    cursor: string,
  ): Promise<IngressPollResult<string>> => {
    const splitter = new NtfyNdjsonSplitter();
    const events: Record<string, unknown>[] = [];
    let lastId = "";
    const consume = (line: string): void => {
      const frame = parseNtfyLine(line);
      if (frame.kind === "malformed") {
        audit({ kind: "malformed", reason: frame.reason });
        return;
      }
      if (frame.kind === "ignored") return;
      events.push(frame.event);
      const id = frame.event.id;
      if (typeof id === "string" && id.trim() !== "") lastId = id.trim();
    };
    if (body) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) for (const line of splitter.push(value)) consume(line);
        }
        for (const line of splitter.flush()) consume(line);
      } catch {
        // A stream that breaks mid-answer is a failed poll unless it was this
        // Host stopping: an aborted reader is the caller's own signal.
        if (signal?.aborted) return { ok: true, events: [], nextCursor: cursor };
        return { ok: false, error: "the ntfy stream ended before it was read" };
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return { ok: true, events, nextCursor: lastId || cursor };
  };

  return {
    platform: "ntfy",
    kind: "poll",
    messageLimit: NTFY_MESSAGE_LIMIT,
    messageLimitUnit: "bytes",
    normalise: (raw) => normaliseNtfyEvent(raw, topic),
    deliver: options.deliver ?? ((_chatId, text) => sender.send(text)),
    poll: async (cursor, signal): Promise<IngressPollResult<string>> => {
      if (!isValidNtfyTopic(topic)) {
        return { ok: false, error: "the configured topic is not a valid ntfy topic name" };
      }
      if (!base.ok) return { ok: false, error: base.error };
      // An empty cursor means "from now": asking `since=all` on a first run
      // would replay the topic's whole retained history as new commands.
      const suffix = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
      const url = `${base.base}/${encodeURIComponent(topic)}${JSON_STREAM_SUFFIX}${suffix}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), pollTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: {
              Accept: "application/x-ndjson",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
            // A followed redirect would carry the bearer token to another host.
            redirect: "manual",
          });
        } catch {
          // An abort is the long poll ending — either this Host stopping or the
          // poll's own idle timeout — not the server failing.
          if (signal?.aborted || controller.signal.aborted) {
            return { ok: true, events: [], nextCursor: cursor };
          }
          return { ok: false, error: "the ntfy request failed" };
        }

        if (response.status === 401 || response.status === 403) {
          audit({
            kind: "auth-failed",
            error: `ntfy refused the credentials (HTTP ${response.status})`,
          });
          return {
            ok: false,
            error: `ntfy refused the credentials (HTTP ${response.status})`,
          };
        }
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          const seconds = header !== null ? Number(header) : Number.NaN;
          return {
            ok: false,
            error: "ntfy is rate limiting the subscription",
            retryAfterMs:
              Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000,
          };
        }
        if (response.status >= 300 && response.status < 400) {
          return { ok: false, error: "ntfy answered a redirect for the subscription" };
        }
        if (!response.ok) {
          return {
            ok: false,
            error: `ntfy answered HTTP ${response.status} for the subscription`,
          };
        }
        return await readStream(response.body, signal, cursor);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export type NtfyInboundTransportOptions = {
  endpoint: string;
  topic: string;
  token?: string;
  /** The restart-durable replay guard, keyed on the topic and message id. */
  handled: IngressHandledStore;
  /** Where the message id is persisted so a restart resumes instead of replaying. */
  cursor: IngressCursorStore<string>;
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: NtfyFetch;
  allowInsecureHttp?: boolean;
  audit?: NtfyInboundAudit;
  /** How the loop waits; injected so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The receive side of the ntfy channel: run the shared long-poll loop until
 * `signal` aborts.
 *
 * Each polled batch is applied through the shared dedupe gate, keyed on the
 * topic and message id, so a message the server offers twice — or one
 * redelivered after a restart whose cursor had not been saved — is recognised
 * before it starts a second turn.
 */
export function createNtfyInboundPushTransport(
  options: NtfyInboundTransportOptions,
): MessagingInboundPushTransport {
  const audit = ntfyAudit(options.audit);
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async start(onMessage, signal) {
      const adapter = createNtfyIngressAdapter({
        endpoint: options.endpoint,
        topic: options.topic,
        ...(options.token ? { token: options.token } : {}),
        ...(options.pollTimeoutMs !== undefined ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: options.allowInsecureHttp }
          : {}),
        audit: options.audit ?? (() => {}),
      });
      const gate = new IngressGate({ handled: options.handled, onMessage, audit });
      const poller = new PollingIngressTransport<unknown, string>({
        poll: (cursor, pollSignal) => adapter.poll(cursor, pollSignal),
        normalise: (event) => adapter.normalise(event),
        cursor: options.cursor,
        // The message id is opaque: it advances only when the server answered a
        // batch whose last id differs from the one the poll asked from.
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
        // The cursor is this channel's only redelivery mechanism. A message the
        // gate could not hand to the Host leaves the id unadvanced, so the next
        // poll is offered the same batch and the durable guard skips what did
        // land. Advancing here instead would drop that message for good — ntfy
        // has no per-message acknowledgement to withhold.
        if (outcome === "process-failed") {
          throw new Error("the inbound turn could not be started");
        }
      }, signal);
    },
  };
}
