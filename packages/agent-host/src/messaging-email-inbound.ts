/**
 * The inbound email channel — the adapter half.
 *
 * Email's incoming direction is a *pull*: the Host opens an IMAP-over-TLS
 * connection, asks for unseen messages above a saved UID, fetches them with
 * `BODY.PEEK[]`, and closes. Nothing binds a port and no public address is
 * needed. There is deliberately **no IDLE**: IDLE is the correct long-term
 * answer for a mail channel and it is out of scope here, which is why the
 * settings panel says "polls on an interval" instead of implying a push.
 *
 * Everything a pull channel shares with its siblings is the shared layer's: the
 * cursor, the apply-then-save barrier and the failure floor
 * (`messaging-ingress-polling.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is email's own:
 *
 * - **poll** — one IMAP session from the cursor the shared transport hands in.
 * - **normalise** — [`normaliseEmailEvent`]: one fetched message, filtered
 *   against the sender allowlist, this channel's own echo, an empty body, a
 *   body with no plain-text part, and a missing address.
 * - **deliver** — one SMTP submission (see `messaging-email-smtp.ts`), chunked by
 *   the shared byte-aware chunker so a long reply becomes ordered messages.
 * - **limit** — [`EMAIL_MESSAGE_LIMIT_BYTES`], declared in **bytes**.
 *
 * # The cursor is the last seen UID, and it is a number
 *
 * IMAP has real, monotonic message numbers: a UID is never reused and never
 * goes backwards inside a mailbox. So the cursor is a number, the shared
 * transport's `nextIsAhead` default (`next > current`) is exactly right, and a
 * restart resumes at the UID it saved instead of replaying the mailbox.
 *
 * # The first poll starts at the newest unread message
 *
 * Enabling the channel on a mailbox with four thousand unread messages must not
 * fire four thousand turns. When the cursor is still zero — no position has ever
 * been saved — the poll reads the unseen set, advances the cursor to the highest
 * UID in it, and delivers **nothing**, recording one audit line saying so. Every
 * later poll delivers what arrived after that point. This is stated in the
 * panel's limitation note, because a user who expects their unread mail to be
 * answered on the first run deserves to know it will not be.
 *
 * # A mailbox is a remote control unless the sender is checked
 *
 * A mail address is public in a way a chat id is not: anyone who learns it can
 * send to it. So a message becomes a turn only when its `From` address is on the
 * configured allowlist; everything else is dropped with one audit line naming
 * the reason and nothing else — not the sender, not the subject, not the body.
 * The allowlist is exact addresses, compared case-insensitively; a display name
 * is not an identity and does not match.
 *
 * # Own echo
 *
 * Every message this channel sends carries a `Message-ID` whose local part
 * begins with [`EMAIL_OWN_MESSAGE_ID_PREFIX`]. Mail can come back — a BCC to
 * self, an alias, a mailing list — so a message whose `In-Reply-To` or
 * `References` names one of those ids is dropped, and so is a message whose
 * `From` is the account itself. Without this the channel answers its own replies
 * forever.
 */

import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import {
  IngressGate,
  deliverInChunks,
  ingressMessageKey,
  ingressUtf8Bytes,
  type IngressAudit,
  type IngressCursorStore,
  type IngressDeliveryResult,
  type IngressHandledStore,
  type IngressNormalisation,
  type IngressPollResult,
  type IngressPostOutcome,
  type PollIngressAdapter,
} from "./messaging-ingress.js";
import { PollingIngressTransport, type PollingIngressResult } from "./messaging-ingress-polling.js";
import { ImapClient, type ImapSocketFactory, type ImapTarget } from "./messaging-email-imap.js";
import {
  emailHeader,
  extractEmailBody,
  parseEmailAddresses,
  parseEmailMessage,
  parseMessageIds,
  type EmailHeaders,
} from "./messaging-email-message.js";
import {
  EMAIL_OWN_MESSAGE_ID_PREFIX,
  SmtpSender,
  type SmtpSecurity,
  type SmtpSocketFactory,
  type SmtpTarget,
} from "./messaging-email-smtp.js";

export {
  EMAIL_OWN_MESSAGE_ID_PREFIX,
  SMTP_DEFAULT_STARTTLS_PORT,
  SMTP_DEFAULT_TLS_PORT,
  SmtpSender,
  buildOwnMessageId,
  buildSmtpMessage,
  createSmtpSocketFactory,
  dotStuff,
  encodeHeaderValue,
  headerInjectionReason,
  isEmailAddress,
  type SmtpSecurity,
  type SmtpSenderOptions,
  type SmtpSocketFactory,
  type SmtpTarget,
} from "./messaging-email-smtp.js";
export {
  IMAP_DEFAULT_TLS_PORT,
  ImapClient,
  ImapWireReader,
  createImapSocketFactory,
  imapResponseTag,
  literalLengthAtLineEnd,
  parseFetchResponse,
  parseSearchResponse,
  type ImapRawSocket,
  type ImapResponse,
  type ImapSegment,
  type ImapSocketFactory,
  type ImapTarget,
} from "./messaging-email-imap.js";
export {
  decodeEmailCharset,
  decodeEmailHeaderValue,
  extractEmailBody,
  parseEmailAddresses,
  parseEmailHeaders,
  parseEmailMessage,
  type EmailHeaders,
} from "./messaging-email-message.js";

/** The settings section the email channel's record lives in, inside `app`. */
export const MESSAGING_EMAIL_SECTION = "messagingEmail";
/** The record's self-identifying format. */
export const MESSAGING_EMAIL_FORMAT = "pi-desktop-messaging-email";
/** The record version this build reads. */
export const MESSAGING_EMAIL_FORMAT_VERSION = 1;
/** Where the mail password (an app password, ideally) lives in the secret store. */
export const MESSAGING_EMAIL_PASSWORD_SECRET_REF = "secret:messaging-email:password";

/** The most message ids the settings-backed replay guard remembers. */
export const EMAIL_HANDLED_CAPACITY = 2048;

/**
 * The reply budget, in bytes.
 *
 * Mail has no hard per-message limit worth chasing; what matters is not sending
 * a novel. 32 KiB of UTF-8 is a long, readable reply, and the shared chunker
 * splits anything longer into ordered messages rather than truncating it.
 */
export const EMAIL_MESSAGE_LIMIT_BYTES = 32 * 1024;

/** How many messages one poll will fetch, so one poll cannot become a burst. */
export const EMAIL_MAX_MESSAGES_PER_POLL = 20;

/** The bytes a reply occupies on the SMTP wire: every LF becomes CRLF. */
export function emailWireBytes(text: string): number {
  return ingressUtf8Bytes(text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
}

/**
 * Split a reply into chunks whose *wire* size fits the limit.
 *
 * [`chunkIngressText`] measures the text it is given, but SMTP is a CRLF
 * protocol: a chunk of 32768 bytes of LF text becomes more than 32768 bytes once
 * every line break is doubled, and a mail server that counts the DATA octets
 * refuses the message this channel just built to fit. So the budget is measured
 * on the CRLF form while the chunks stay in LF form — which is what the shared
 * chunker's own scenario asserts they join back into.
 *
 * The break lands at the last newline or space within the final fifth of the
 * window where one exists, so a reply is cut between words rather than inside
 * one; a single unbroken token longer than the limit is still cut, because
 * refusing to send is worse than a hard break.
 */
export function chunkEmailText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (emailWireBytes(rest) <= limit) {
      chunks.push(rest);
      break;
    }
    let low = 0;
    let high = rest.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (emailWireBytes(rest.slice(0, mid)) <= limit) low = mid;
      else high = mid - 1;
    }
    let cut = Math.max(1, low);
    const floor = Math.floor(cut * 0.8);
    const window = rest.slice(floor, cut);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const at = newline >= 0 ? newline : space;
    if (at >= 0) cut = floor + at + 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One audit record. Structure and ids only — never message text or a password. */
export type EmailInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed"; reason: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string }
  | { kind: "cursor-save-failed"; error: string };

export type EmailInboundAudit = (entry: EmailInboundAuditEntry) => void;

/** The shared audit vocabulary expressed in email's published entry type. */
function emailAudit(sink?: EmailInboundAudit): IngressAudit {
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
// Classification
// ---------------------------------------------------------------------------

/** One message as the poll hands it over: its UID and its raw bytes. */
export type EmailInboundEvent = { uid: number; source: Buffer | string };

/** What one classification decided. */
export type EmailClassification =
  | { accepted: true; message: InboundMessage; sender: string }
  | { accepted: false; reason: string; sender?: string };

export type EmailClassifyOptions = {
  /** The exact sender addresses a message may come from. */
  allowedSenders: readonly string[];
  /**
   * Addresses that belong to this channel itself — the configured account. A
   * message from one of them is this channel's own mail coming back.
   */
  ownAddresses?: readonly string[];
};

/** Normalise an allowlist entry: an address, lowercased; anything else drops. */
export function normaliseAllowedSenders(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  const out: string[] = [];
  for (const entry of raw) {
    for (const address of parseEmailAddresses(entry)) {
      if (!out.includes(address)) out.push(address);
    }
  }
  return out;
}

/** The ids in a message's `In-Reply-To` and `References`, angle brackets gone. */
export function referencedMessageIds(headers: EmailHeaders): string[] {
  return [
    ...parseMessageIds(emailHeader(headers, "in-reply-to")),
    ...parseMessageIds(emailHeader(headers, "references")),
  ];
}

/** Whether an id was minted by this channel. */
export function isOwnMessageId(id: string): boolean {
  // Callers pass ids from `parseMessageIds` (brackets already stripped), but the
  // helper is exported and a raw `Message-ID` header keeps them; tolerating both
  // costs one line and removes a way to miss the guard.
  const bare = id.trim().replace(/^<|>$/g, "");
  const local = bare.includes("@") ? bare.slice(0, bare.lastIndexOf("@")) : bare;
  return local.toLowerCase().startsWith(EMAIL_OWN_MESSAGE_ID_PREFIX);
}

/**
 * Classify one fetched message into the neutral message shape.
 *
 * Refused, in this order and for these reasons — each a structural fact, never
 * the message's content:
 *
 * 1. the event carries no bytes or no UID (a malformed fetch);
 * 2. no `From` address at all;
 * 3. the sender is not on the allowlist (the remote-control guard);
 * 4. the message is this channel's own echo, by sender or by referenced id;
 * 5. the body has no plain-text part, or refuses to parse.
 */
export function classifyEmailEvent(
  raw: unknown,
  options: EmailClassifyOptions,
): EmailClassification {
  if (!isRecord(raw)) return { accepted: false, reason: "the event is not an email message" };
  const uid = typeof raw.uid === "number" ? raw.uid : Number(raw.uid);
  if (!Number.isInteger(uid) || uid <= 0) {
    return { accepted: false, reason: "the message names no uid" };
  }
  const source =
    typeof raw.source === "string"
      ? Buffer.from(raw.source, "utf8")
      : raw.source instanceof Uint8Array
        ? Buffer.from(raw.source)
        : null;
  if (!source || source.length === 0) {
    return { accepted: false, reason: "the message carries no bytes" };
  }

  const parsed = parseEmailMessage(source);
  const senders = parseEmailAddresses(emailHeader(parsed.headers, "from"));
  const sender = senders[0] ?? "";
  if (sender === "") return { accepted: false, reason: "the message names no sender" };

  const own = new Set((options.ownAddresses ?? []).map((entry) => entry.toLowerCase()));
  if (own.has(sender)) {
    return { accepted: false, reason: "the message is this channel's own mail", sender };
  }
  const allowlist = new Set(options.allowedSenders.map((entry) => entry.toLowerCase()));
  if (!allowlist.has(sender)) {
    // Deliberately no sender in the audit record: an unknown sender is exactly
    // the value that must not be echoed into a log by a hostile mailbox.
    return { accepted: false, reason: "the sender is not on the allowlist" };
  }

  const referenced = referencedMessageIds(parsed.headers);
  if (referenced.some((id) => isOwnMessageId(id))) {
    return { accepted: false, reason: "the message replies to this channel's own mail", sender };
  }

  const body = extractEmailBody(parsed.headers, parsed.body);
  if (!body.ok) return { accepted: false, reason: body.reason, sender };

  const messageId = emailHeader(parsed.headers, "message-id").trim();
  const id = messageId !== "" ? messageId : `uid-${uid}`;
  return {
    accepted: true,
    sender,
    message: { messageId: id, chatId: sender, text: body.text },
  };
}

/**
 * Project one fetched message onto the shared shape, keyed on the sender and the
 * message's own id.
 *
 * The chat id is the sender's address, because that is where a reply goes: email
 * has no room, only correspondents.
 */
export function normaliseEmailEvent(
  raw: unknown,
  options: EmailClassifyOptions,
): IngressNormalisation {
  const classification = classifyEmailEvent(raw, options);
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

export type EmailIngressAdapterOptions = {
  /** The IMAP server the poll reads from; TLS is implicit. */
  imap: ImapTarget;
  /** The SMTP server replies are submitted to. */
  smtp: SmtpTarget;
  /** The account both directions authenticate as. */
  username: string;
  /** The mail password, from the secret store. Never logged. */
  password: string;
  /** The address replies are sent from; defaults to the username. */
  from?: string;
  /** The exact sender addresses a message may come from. */
  allowedSenders: readonly string[];
  /** The subject prefix a reply carries, e.g. `[pi-desktop]`. */
  subjectPrefix?: string;
  mailbox?: string;
  /** How many messages one poll fetches. */
  maxMessagesPerPoll?: number;
  commandTimeoutMs?: number;
  /** Test seam: the IMAP connection factory, in place of the TLS one. */
  connect?: ImapSocketFactory;
  /** Test seam: the SMTP connection factory, in place of the TLS one. */
  connectSmtp?: SmtpSocketFactory;
  /** Where filtered and malformed messages are reported. */
  audit?: EmailInboundAudit;
  /** Override the delivery seam; by default the adapter's own sender submits. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/** The subject a reply carries: the configured prefix plus a stable marker. */
export function emailReplySubject(subjectPrefix: string | undefined): string {
  const prefix = (subjectPrefix ?? "").trim();
  return prefix === "" ? "pi-desktop" : `${prefix} reply`;
}

/**
 * The email adapter's concrete shape: a poll whose events are emails, not
 * `unknown`.
 *
 * The shared `PollIngressAdapter` types a poll's events as `unknown[]`, which is
 * right for the suite but loses the one fact this channel's own loop needs: the
 * events it hands to `normalise` are [`EmailInboundEvent`]s. Narrowing it here
 * keeps the transport typed without a cast at the call site.
 */
export type EmailIngressAdapter = Omit<PollIngressAdapter<number>, "poll" | "deliver"> & {
  readonly poll: (
    cursor: number,
    signal?: AbortSignal,
  ) => Promise<PollingIngressResult<EmailInboundEvent, number>>;
  readonly deliver: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The email ingress adapter: the platform-specific seams and nothing else.
 *
 * `poll` runs one IMAP session from the cursor it is handed. A refused login is
 * a `connect-failed` audit entry and an `ok: false` result; it is never thrown,
 * so the shared loop backs off instead of the Host failing.
 */
export function createEmailIngressAdapter(
  options: EmailIngressAdapterOptions,
): EmailIngressAdapter {
  const audit = emailAudit(options.audit);
  const allowedSenders = normaliseAllowedSenders(options.allowedSenders);
  const from = (options.from ?? options.username).trim();
  const classify: EmailClassifyOptions = {
    allowedSenders,
    ownAddresses: [options.username, from],
  };
  const maxPerPoll = Math.max(1, options.maxMessagesPerPoll ?? EMAIL_MAX_MESSAGES_PER_POLL);
  const subjectPrefix = options.subjectPrefix ?? "";
  const smtpTarget = options.smtp;

  const sender = new SmtpSender({
    target: smtpTarget,
    username: options.username,
    password: options.password,
    from,
    ...(options.commandTimeoutMs !== undefined ? { timeoutMs: options.commandTimeoutMs } : {}),
    ...(options.connectSmtp ? { connect: options.connectSmtp } : {}),
  });

  /**
   * One session, one search, one fetch. The baseline rule (cursor zero) is here
   * because only the poll knows the server's newest UID.
   */
  const pollOnce = async (
    cursor: number,
    signal?: AbortSignal,
  ): Promise<PollingIngressResult<EmailInboundEvent, number>> => {
    if (allowedSenders.length === 0) {
      return { ok: false, error: "the channel has no allowed senders configured" };
    }
    const client = new ImapClient({
      target: options.imap,
      username: options.username,
      password: options.password,
      ...(options.mailbox !== undefined ? { mailbox: options.mailbox } : {}),
      ...(options.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: options.commandTimeoutMs }
        : {}),
      ...(options.connect ? { connect: options.connect } : {}),
    });
    try {
      await client.connect();
      await client.capability();
      try {
        await client.login();
      } catch (error) {
        audit({
          kind: "auth-failed",
          error: "the IMAP server refused the login for the configured account",
        });
        return { ok: false, error: imapErrorText(error) };
      }
      await client.select();
      if (signal?.aborted) return { ok: true, events: [], nextCursor: cursor };

      const unseen = await client.searchUnseen(cursor);
      const fresh = unseen.filter((uid) => uid > cursor);
      if (fresh.length === 0) {
        await client.logout();
        return { ok: true, events: [], nextCursor: cursor };
      }
      if (cursor === 0) {
        // The first poll after enabling: start at the newest unread message
        // instead of answering a mailbox's whole unread history.
        audit({
          kind: "filtered",
          reason: "the first poll starts after the newest unread message",
        });
        await client.logout();
        return { ok: true, events: [], nextCursor: fresh[fresh.length - 1]! };
      }

      const batch = fresh.slice(0, maxPerPoll);
      const fetched = await client.fetchPeek(batch);
      await client.logout();
      const events: EmailInboundEvent[] = fetched
        .filter((message) => message.uid > cursor)
        .map((message) => ({ uid: message.uid, source: message.source }));
      const highest = events.reduce((max, event) => Math.max(max, event.uid), cursor);
      // A fetch that returned nothing still moves past the UIDs it asked for:
      // otherwise a message the server no longer holds would be retried forever.
      const nextCursor = events.length > 0 ? highest : batch[batch.length - 1]!;
      return { ok: true, events, nextCursor };
    } catch (error) {
      return { ok: false, error: imapErrorText(error) };
    } finally {
      client.close();
    }
  };

/**
 * The reply path: chunked at [`EMAIL_MESSAGE_LIMIT_BYTES`] of wire bytes, then
 * one SMTP submission per chunk.
 *
 * A reply over the limit becomes several messages rather than one mail server
 * refusing it, and they leave in the order they were written because the
 * shared chunker posts each only after the previous one was accepted. A
 * refusal from the server is reported as the chunk's refusal, with the count
 * already sent, so a partial reply is visible rather than silent.
 */
  const deliverDefault = (chatId: string, text: string): Promise<IngressDeliveryResult> =>
    deliverInChunks(text, {
      platform: "email",
      limit: EMAIL_MESSAGE_LIMIT_BYTES,
      limitUnit: "bytes",
      chunk: (reply) => chunkEmailText(reply, EMAIL_MESSAGE_LIMIT_BYTES),
      post: async (chunk): Promise<IngressPostOutcome> => {
        const result = await sender.send({
          to: chatId,
          subject: emailReplySubject(subjectPrefix),
          text: chunk,
        });
        if (result.ok) {
          return { kind: "accepted", id: result.ids[0] ?? `sent-${Date.now()}` };
        }
        return { kind: "refused", error: result.error };
      },
    });

  /**
   * The projection, plus the audit line a refusal owes.
   *
   * A filtered message is dropped by the shared poll loop before the gate sees
   * it (the gate only receives messages), so the channel that decided to refuse
   * is the only place the record can be written. Without this a mailbox could
   * be probed silently: a stranger's mail would be discarded with no evidence
   * that anything arrived. The reason is a structural fact; the sender is
   * included only where classification judged the sender itself safe to name.
   */
  const normalise = (raw: unknown): IngressNormalisation => {
    const normalisation = normaliseEmailEvent(raw, classify);
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
    platform: "email",
    kind: "poll",
    messageLimit: EMAIL_MESSAGE_LIMIT_BYTES,
    messageLimitUnit: "bytes",
    normalise,
    deliver: options.deliver ?? deliverDefault,
    poll: pollOnce,
  };
}

/** A refused login or a dead connection, in words that carry no credential. */
function imapErrorText(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    const failure = error as { kind?: unknown; status?: unknown; code?: unknown };
    if (failure.kind === "imap-failure") {
      const code = typeof failure.code === "string" ? ` (${failure.code})` : "";
      return `the IMAP server refused the command${code}`;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "the IMAP session failed";
}

export type EmailInboundTransportOptions = {
  imap: ImapTarget;
  smtp: SmtpTarget;
  username: string;
  password: string;
  from?: string;
  allowedSenders: readonly string[];
  subjectPrefix?: string;
  mailbox?: string;
  maxMessagesPerPoll?: number;
  commandTimeoutMs?: number;
  /** The restart-durable replay guard, keyed on the sender and message id. */
  handled: IngressHandledStore;
  /** Where the last seen UID is persisted so a restart resumes. */
  cursor: IngressCursorStore<number>;
  connect?: ImapSocketFactory;
  connectSmtp?: SmtpSocketFactory;
  audit?: EmailInboundAudit;
  /** How the loop waits; injected so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The receive side of the email channel: run the shared poll loop until
 * `signal` aborts.
 *
 * Each polled batch is applied through the shared dedupe gate, keyed on the
 * sender and the message id, so a message offered twice — or redelivered after
 * a restart whose cursor had not been saved — is recognised before it starts a
 * second turn. A message the gate could not hand to the Host leaves the UID
 * unadvanced, so the next poll is offered it again; its cursor is the channel's
 * only redelivery mechanism.
 */
export function createEmailInboundPushTransport(
  options: EmailInboundTransportOptions,
): MessagingInboundPushTransport {
  const audit = emailAudit(options.audit);
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async start(onMessage, signal) {
      const adapter = createEmailIngressAdapter({
        imap: options.imap,
        smtp: options.smtp,
        username: options.username,
        password: options.password,
        ...(options.from !== undefined ? { from: options.from } : {}),
        allowedSenders: options.allowedSenders,
        ...(options.subjectPrefix !== undefined ? { subjectPrefix: options.subjectPrefix } : {}),
        ...(options.mailbox !== undefined ? { mailbox: options.mailbox } : {}),
        ...(options.maxMessagesPerPoll !== undefined
          ? { maxMessagesPerPoll: options.maxMessagesPerPoll }
          : {}),
        ...(options.commandTimeoutMs !== undefined
          ? { commandTimeoutMs: options.commandTimeoutMs }
          : {}),
        ...(options.connect ? { connect: options.connect } : {}),
        ...(options.connectSmtp ? { connectSmtp: options.connectSmtp } : {}),
        audit: options.audit ?? (() => {}),
      });
      const gate = new IngressGate({ handled: options.handled, onMessage, audit });
      const poller = new PollingIngressTransport<EmailInboundEvent, number>({
        poll: (cursor, pollSignal) => adapter.poll(cursor, pollSignal),
        normalise: (event: EmailInboundEvent) => adapter.normalise(event),
        cursor: options.cursor,
        // A UID is a number that only moves forward.
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

/** The record's SMTP security, defaulted and validated. */
export function normaliseSmtpSecurity(value: unknown): SmtpSecurity {
  return value === "starttls" ? "starttls" : "tls";
}
