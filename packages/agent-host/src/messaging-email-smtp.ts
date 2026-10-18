/**
 * The SMTP sender: one plain-text message per reply, framed for the wire.
 *
 * `EHLO` → `STARTTLS` (or implicit TLS on 465) → `AUTH LOGIN` → `MAIL FROM` →
 * `RCPT TO` → `DATA`. Nothing else: no attachments, no HTML alternative, no
 * OAuth. The password is a password — an app password where the provider offers
 * one — read from the secret store and written only into the `AUTH` exchange.
 *
 * # Header injection is the whole reason this module validates
 *
 * A subject is a header, and a header is a line. A value containing CR or LF
 * therefore ends the header early and starts a new one — `"Hi\r\nRCPT TO:
 * <attacker@example.org>"` is a second recipient, and `"Hi\r\nBcc: …"` is a
 * silent copy. The same is true of the addresses. So every value that becomes a
 * header is validated *before a socket is opened*, and a value containing CR,
 * LF or NUL is refused with a typed reason rather than sanitised: silently
 * stripping the newline would send a message the user did not write.
 *
 * # The Message-ID tag, and why it exists
 *
 * A reply can come back to the same mailbox — through a BCC, an alias, or a
 * mailing list that echoes to the sender. Every message this channel sends
 * carries a `Message-ID` whose local part starts with
 * [`EMAIL_OWN_MESSAGE_ID_PREFIX`]; the receive path drops anything whose
 * `In-Reply-To` or `References` names one of those ids, and anything whose
 * `From` is the channel's own account.
 */

import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import type { IngressDeliveryResult } from "./messaging-ingress.js";

/** The registered implicit-TLS submission port. */
export const SMTP_DEFAULT_TLS_PORT = 465;
/** The registered STARTTLS submission port. */
export const SMTP_DEFAULT_STARTTLS_PORT = 587;

/** How one submission connection is secured. */
export type SmtpSecurity = "tls" | "starttls";

export type SmtpTarget = { host: string; port: number; security: SmtpSecurity };

/** The local part every message this channel sends carries. */
export const EMAIL_OWN_MESSAGE_ID_PREFIX = "pi-desktop-agent.";

/** How long one SMTP command may take before the submission is abandoned. */
export const SMTP_TIMEOUT_MS = 20_000;

/** A raw text connection to a submission server; injected for tests. */
export interface SmtpRawSocket {
  write(text: string): void;
  end(): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
  /** Upgrade this connection to TLS in place; present only for STARTTLS. */
  startTls?(): void;
}

/** Opens one connection; injected so a suite drives a loopback fake server. */
export type SmtpSocketFactory = (target: SmtpTarget) => SmtpRawSocket;

/**
 * The production factory.
 *
 * `tls` opens an implicit-TLS connection (port 465). `starttls` opens plaintext
 * and upgrades in place when the sender issues `STARTTLS`, which is why the raw
 * socket exposes `startTls` rather than the factory opening the second
 * connection itself — the order is the protocol's, not the factory's.
 */
export function createSmtpSocketFactory(): SmtpSocketFactory {
  return (target) => {
    const dataHandlers: Array<(chunk: string) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];
    const errorHandlers: Array<(error: unknown) => void> = [];
    let closed = false;
    let stream: Socket | TLSSocket;
    let upgraded = false;

    const emitClose = (reason: string): void => {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler(reason);
    };
    const attach = (next: Socket | TLSSocket): void => {
      next.setNoDelay(true);
      next.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const handler of dataHandlers) handler(text);
      });
      next.on("close", () => emitClose("the connection closed"));
      next.on("error", (error) => {
        for (const handler of errorHandlers) handler(error);
      });
    };

    if (target.security === "tls") {
      stream = tlsConnect({
        host: target.host,
        port: target.port,
        ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
        rejectUnauthorized: true,
      });
    } else {
      stream = netConnect({ host: target.host, port: target.port });
    }
    attach(stream);

    return {
      write: (text) => stream.write(text),
      end: () => stream.end(),
      onData: (handler) => dataHandlers.push(handler),
      onClose: (handler) => closeHandlers.push(handler),
      onError: (handler) => errorHandlers.push(handler),
      startTls: () => {
        if (upgraded) return;
        upgraded = true;
        // `stream` is the plaintext socket here by construction: nothing else
        // offers STARTTLS after a TLS handshake.
        stream = tlsConnect({
          socket: stream as Socket,
          ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
          rejectUnauthorized: true,
        });
        attach(stream);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A bare `local@domain` address: one `@`, no whitespace, no angle brackets. */
const EMAIL_ADDRESS = /^[^\s@<>",;:]+@[^\s@<>",;:]+$/;

/**
 * Whether a value is a single address this channel may put in a header.
 *
 * CR, LF and NUL are refused here as well as by the structural check, so the
 * reason a caller gets is the one that matters — a header line break — rather
 * than a generic "not an address".
 */
export function isEmailAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/[\r\n\0]/.test(value)) return false;
  return EMAIL_ADDRESS.test(value.trim());
}

/**
 * Why a value may not become a header, or `null` when it may.
 *
 * One function for the subject and the addresses alike, because the rule is one
 * rule: a header is a line, and a line ends at CR or LF.
 */
export function headerInjectionReason(value: unknown, field: string): string | null {
  if (typeof value !== "string") return `the ${field} is not text`;
  if (/[\r\n\0]/.test(value)) {
    return `the ${field} contains a line break, which would inject a header`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

/** RFC 2047 encode a header value when it is not pure ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** RFC 5322 date, in the one form every server accepts. */
export function smtpDate(now: Date): string {
  return now.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * The `Message-ID` this channel stamps on its own mail.
 *
 * The local part begins with a fixed prefix, so the receive path can recognise
 * its own message from the header alone without a store of sent ids — the store
 * would have to persist forever to be complete, and a prefix cannot miss.
 */
export function buildOwnMessageId(from: string, now: Date = new Date()): string {
  const domain = from.includes("@") ? from.slice(from.lastIndexOf("@") + 1) : "pi-desktop.invalid";
  const random = Math.random().toString(36).slice(2, 10);
  return `<${EMAIL_OWN_MESSAGE_ID_PREFIX}${now.getTime()}.${random}@${domain}>`;
}

/** The domain a configured address belongs to; `""` when it names none. */
export function emailDomain(address: string): string {
  return address.includes("@") ? address.slice(address.lastIndexOf("@") + 1).toLowerCase() : "";
}

export type SmtpMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  now?: Date;
};

export type SmtpMessageResult =
  | { ok: true; message: string }
  | { ok: false; reason: string };

/**
 * Assemble the DATA payload: headers, a blank line, the body.
 *
 * Every header that carries a user-controlled value goes through
 * [`headerInjectionReason`] first, so a refusal happens here — before a socket,
 * before a credential, before the server saw anything.
 */
export function buildSmtpMessage(input: SmtpMessage): SmtpMessageResult {
  for (const [field, value] of [
    ["sender address", input.from],
    ["recipient address", input.to],
  ] as const) {
    const injection = headerInjectionReason(value, field);
    if (injection) return { ok: false, reason: injection };
    if (!isEmailAddress(value)) return { ok: false, reason: `the ${field} is not an address` };
  }
  // The subject is the one free-text header, so it is the one injection target.
  const injection = headerInjectionReason(input.subject, "subject");
  if (injection) return { ok: false, reason: injection };
  if (/[\r\n\0]/.test(input.messageId)) {
    return { ok: false, reason: "the message id contains a line break" };
  }

  const body = input.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const headers = [
    `From: <${input.from}>`,
    `To: <${input.to}>`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${smtpDate(input.now ?? new Date())}`,
    `Message-ID: ${input.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return { ok: true, message: `${headers.join("\r\n")}\r\n\r\n${body}` };
}

/** Dot-stuff a DATA payload: a line of `.` alone would end the message. */
export function dotStuff(message: string): string {
  return message
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export type SmtpSenderOptions = {
  target: SmtpTarget;
  /** The account the submission authenticates as. */
  username: string;
  /** The password, read from `secret:messaging-email:password`. */
  password: string;
  /** The address replies are sent from; usually the same as `username`. */
  from: string;
  /** The name announced in `EHLO`; never the machine's hostname. */
  clientName?: string;
  timeoutMs?: number;
  connect?: SmtpSocketFactory;
};

export type SmtpReply = { code: number; lines: string[] };

/** One reply line, as the transport produced it. */
export function parseSmtpReply(text: string): SmtpReply | null {
  const match = /^(\d{3})([- ])(.*)$/.exec(text.replace(/\r$/, ""));
  if (!match) return null;
  return { code: Number(match[1]), lines: [match[3] ?? ""] };
}

/**
 * One submission: one connection, one message, one reply chain.
 *
 * Failures are typed strings carrying the numeric reply only. A server's own
 * text can echo the submitted address but never the password; the numeric code
 * plus a short class is enough to act on and safe to record.
 */
export class SmtpSender {
  private readonly options: SmtpSenderOptions;

  constructor(options: SmtpSenderOptions) {
    this.options = options;
  }

  /** Send one plain-text message. Never throws. */
  async send(input: {
    to: string;
    subject: string;
    text: string;
    messageId?: string;
  }): Promise<IngressDeliveryResult> {
    const messageId = input.messageId ?? buildOwnMessageId(this.options.from);
    const built = buildSmtpMessage({
      from: this.options.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      messageId,
    });
    if (!built.ok) return { ok: false, error: built.reason, sent: 0 };

    let session: SmtpSession;
    try {
      session = await this.open();
    } catch (error) {
      return { ok: false, error: smtpErrorText(error), sent: 0 };
    }
    try {
      await session.transaction(this.options.from, input.to, dotStuff(built.message));
      await session.quit();
      return { ok: true, sent: 1, ids: [messageId] };
    } catch (error) {
      session.close();
      return { ok: false, error: smtpErrorText(error), sent: 0 };
    }
  }

  private async open(): Promise<SmtpSession> {
    const session = new SmtpSession(this.options);
    try {
      await session.connect();
      await session.ehlo();
      if (this.options.target.security === "starttls") {
        await session.startTls();
        await session.ehlo();
      }
      await session.authenticate();
    } catch (error) {
      // A handshake that fails half-way still owns a socket; without this the
      // failure leaks a connection per attempt on a server that keeps refusing.
      session.close();
      throw error;
    }
    return session;
  }
}

/** A typed SMTP refusal: the numeric reply, never the command that caused it. */
export class SmtpFailure extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`the SMTP server answered ${code}`);
    this.name = "SmtpFailure";
    this.code = code;
  }
}

function smtpErrorText(error: unknown): string {
  if (error instanceof SmtpFailure) {
    if (error.code === 535 || error.code === 534 || error.code === 530) {
      return `the SMTP server refused the authentication (${error.code})`;
    }
    if (error.code === 421) return "the SMTP server is not accepting mail (421)";
    return `the SMTP server answered ${error.code}`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "the SMTP submission failed";
}

/**
 * One SMTP conversation.
 *
 * The reply reader is a line buffer with SMTP's own continuation rule: a reply
 * is finished when a line's fourth character is a space rather than a hyphen.
 * Multi-line greetings (`250-…` then `250 …`) are the normal case, not an edge.
 */
export class SmtpSession {
  private readonly options: SmtpSenderOptions;
  private socket: SmtpRawSocket | null = null;
  private buffer = "";
  private replies: string[] = [];
  private waiter: {
    resolve: (reply: SmtpReply) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
    collected: string[];
  } | null = null;
  private failure: unknown = null;

  constructor(options: SmtpSenderOptions) {
    this.options = options;
  }

  get capabilities(): string[] {
    return this.capabilityLines;
  }

  private capabilityLines: string[] = [];

  async connect(): Promise<void> {
    if (!/\S/.test(this.options.username) || /[\r\n\0]/.test(this.options.username)) {
      throw new Error("the SMTP username contains a character that cannot be sent");
    }
    if (!/\S/.test(this.options.password) || /[\r\n\0]/.test(this.options.password)) {
      throw new Error("the SMTP password contains a character that cannot be sent");
    }
    const factory = this.options.connect ?? createSmtpSocketFactory();
    this.socket = factory(this.options.target);
    this.socket.onData((chunk) => this.consume(chunk));
    this.socket.onClose((reason) => this.fail(new Error(reason ?? "the SMTP connection closed")));
    this.socket.onError(() => this.fail(new Error("the SMTP connection failed")));
    const greeting = await this.readReply();
    if (greeting.code !== 220) throw new SmtpFailure(greeting.code);
  }

  async ehlo(): Promise<string[]> {
    const reply = await this.command(`EHLO ${this.options.clientName ?? "pi-desktop.local"}`, [250]);
    this.capabilityLines = reply.lines.slice(1).map((line) => line.trim());
    return this.capabilityLines;
  }

  /** `STARTTLS`, then upgrade the socket in place. */
  async startTls(): Promise<void> {
    const advertised = this.capabilityLines.some((line) => /^STARTTLS\b/i.test(line));
    if (!advertised) throw new Error("the SMTP server does not offer STARTTLS");
    await this.command("STARTTLS", [220]);
    if (!this.socket?.startTls) {
      throw new Error("the SMTP connection cannot be upgraded to TLS");
    }
    this.socket.startTls();
    this.buffer = "";
    this.capabilityLines = [];
  }

  /** `AUTH LOGIN`, the challenge/response exchange, base64 per step. */
  async authenticate(): Promise<void> {
    const first = await this.command("AUTH LOGIN", [334]);
    if (first.code !== 334) throw new SmtpFailure(first.code);
    await this.command(Buffer.from(this.options.username, "utf8").toString("base64"), [334]);
    await this.command(Buffer.from(this.options.password, "utf8").toString("base64"), [235]);
  }

  /** `MAIL FROM`, `RCPT TO`, `DATA`, the payload, and the final acceptance. */
  async transaction(from: string, to: string, payload: string): Promise<void> {
    await this.command(`MAIL FROM:<${from}>`, [250]);
    // 251 is "user not local, will forward" — accepted, not a refusal.
    await this.command(`RCPT TO:<${to}>`, [250, 251]);
    await this.command("DATA", [354]);
    this.write(`${payload}\r\n.\r\n`);
    const accepted = await this.readReply();
    if (accepted.code !== 250) throw new SmtpFailure(accepted.code);
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT", [221]);
    } catch {
      // The message was already accepted; a refused QUIT changes nothing.
    } finally {
      this.close();
    }
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  // -- internals ------------------------------------------------------------

  private write(text: string): void {
    this.socket?.write(text);
  }

  private command(text: string, expect: number[]): Promise<SmtpReply> {
    this.write(`${text}\r\n`);
    return this.readReply().then((reply) => {
      if (!expect.includes(reply.code)) throw new SmtpFailure(reply.code);
      return reply;
    });
  }

  private readReply(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter) this.waiter = null;
        reject(new Error("the SMTP server did not answer within the timeout"));
      }, this.options.timeoutMs ?? SMTP_TIMEOUT_MS);
      const waiter = { resolve, reject, timer, collected: [] as string[] };
      this.waiter = waiter;
      const ready = this.replies.shift();
      if (ready !== undefined) this.deliver(ready);
    });
  }

  private deliver(line: string): void {
    const waiter = this.waiter;
    if (!waiter) return;
    const reply = parseSmtpReply(line);
    if (!reply) {
      // A line that is not a reply cannot be interpreted; the session is unusable.
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the SMTP server sent a line that is not a reply"));
      return;
    }
    waiter.collected.push(reply.lines[0] ?? "");
    const completed = /^\d{3} /.test(line);
    if (!completed) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve({ code: reply.code, lines: waiter.collected });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") continue;
      if (this.waiter) this.deliver(line);
      else this.replies.push(line);
    }
  }

  private fail(error: unknown): void {
    this.failure = error;
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}
