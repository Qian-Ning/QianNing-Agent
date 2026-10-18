/**
 * The IMAP client: wire framing, the command sequence this channel runs, and
 * the one rule that keeps the mailbox untouched.
 *
 * # Literals are not lines
 *
 * An IMAP response is a sequence of lines, except that any line may end with
 * `{n}` followed by `n` bytes of arbitrary data and then the rest of the line.
 * A message whose body contains CRLF therefore *looks* like several responses to
 * anything that splits on newlines, and a parser that does so corrupts exactly
 * the messages this channel exists to read. [`ImapWireReader`] is a byte
 * accumulator with explicit literal state: it emits one response only when the
 * last line of that response carried no literal, so a `FETCH` whose body has a
 * thousand CRLFs is one response carrying one literal buffer.
 *
 * # `BODY.PEEK[]`, never `BODY[]`
 *
 * `BODY[]` marks the message `\Seen` as a side effect of reading it. A channel
 * that marks a person's mail read merely by considering it is hostile, and the
 * damage is invisible — the user simply stops seeing unread mail. Every fetch
 * this module issues is `BODY.PEEK[]`, and a test asserts the exact command
 * string rather than a substring, because `BODY[]` is a prefix-shaped trap.
 *
 * # The session per poll
 *
 * `CAPABILITY` → `LOGIN` → `SELECT INBOX` → `UID SEARCH UNSEEN` →
 * `UID FETCH <set> (BODY.PEEK[] UID)` → `LOGOUT`. There is no IDLE and no
 * long-lived connection: the channel deliberately polls, which is stated in the
 * settings panel rather than hidden.
 */

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { isIP } from "node:net";

/** The registered IMAP-over-TLS port. */
export const IMAP_DEFAULT_TLS_PORT = 993;

/** The most responses one command may buffer before it is refused. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** How long one command may take before the session is abandoned. */
export const IMAP_COMMAND_TIMEOUT_MS = 20_000;

/** A raw byte connection to an IMAP server. Injected so tests need no TLS. */
export interface ImapRawSocket {
  write(text: string): void;
  end(): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** One server address; IMAP is TLS-only in this build. */
export type ImapTarget = { host: string; port: number };

/** Opens one connection; injected so a suite drives a loopback fake server. */
export type ImapSocketFactory = (target: ImapTarget) => ImapRawSocket;

/**
 * The production factory: implicit TLS, verified against the configured name.
 *
 * IMAP over a plaintext port is not offered at all — there is no relaxed-policy
 * branch here, because the credential is the user's own mail password and the
 * only correct answer for a server that cannot do TLS is "do not connect".
 */
export function createImapSocketFactory(): ImapSocketFactory {
  return (target) => {
    const socket: TLSSocket = tlsConnect({
      host: target.host,
      port: target.port,
      ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
      rejectUnauthorized: true,
    });
    socket.setNoDelay(true);
    const dataHandlers: Array<(chunk: Buffer) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];
    const errorHandlers: Array<(error: unknown) => void> = [];
    let closed = false;
    socket.on("data", (chunk: Buffer) => {
      for (const handler of dataHandlers) handler(chunk);
    });
    socket.on("close", () => {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler("the connection closed");
    });
    socket.on("error", (error) => {
      for (const handler of errorHandlers) handler(error);
    });
    return {
      write: (text) => socket.write(text),
      end: () => socket.end(),
      onData: (handler) => dataHandlers.push(handler),
      onClose: (handler) => closeHandlers.push(handler),
      onError: (handler) => errorHandlers.push(handler),
    };
  };
}

// ---------------------------------------------------------------------------
// Response framing
// ---------------------------------------------------------------------------

/** One piece of a response: a line of text, or a literal's bytes. */
export type ImapSegment = { text: string } | { literal: Buffer };

/** One complete response, in wire order. */
export type ImapResponse = { segments: ImapSegment[] };

const CRLF_BYTES = Buffer.from("\r\n", "latin1");

/**
 * The literal length a line ends with, or `null`.
 *
 * `{123}` and its non-synchronising spelling `{123+}` both open a literal;
 * only the bytes after the CRLF are data.
 */
export function literalLengthAtLineEnd(line: string): number | null {
  const match = /\{(\d+)\+?\}$/.exec(line);
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

/**
 * The byte-to-response splitter.
 *
 * State is the whole point: a literal's `n` bytes may arrive across any number
 * of reads, and the response is not finished until a line arrives that opens no
 * further literal. Both facts are kept here, so no caller ever sees a partial
 * response or a body mistaken for a line.
 */
export class ImapWireReader {
  private buffer: Buffer = Buffer.alloc(0);
  private current: ImapResponse | null = null;
  private pendingLiteral: number | null = null;

  /** Feed one read; answers every response it completed, in order. */
  push(chunk: Buffer): ImapResponse[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const completed: ImapResponse[] = [];
    for (;;) {
      if (this.pendingLiteral !== null) {
        if (this.buffer.length < this.pendingLiteral) break;
        const bytes = Buffer.from(this.buffer.subarray(0, this.pendingLiteral));
        this.buffer = this.buffer.subarray(this.pendingLiteral);
        this.pendingLiteral = null;
        if (this.current === null) this.current = { segments: [] };
        this.current.segments.push({ literal: bytes });
        continue;
      }
      const newline = this.buffer.indexOf(CRLF_BYTES);
      if (newline === -1) break;
      const line = this.buffer.subarray(0, newline).toString("latin1");
      this.buffer = this.buffer.subarray(newline + 2);
      if (this.current === null) this.current = { segments: [] };
      this.current.segments.push({ text: line });
      const literal = literalLengthAtLineEnd(line);
      if (literal !== null) {
        this.pendingLiteral = literal;
        continue;
      }
      completed.push(this.current);
      this.current = null;
    }
    if (this.buffer.length > MAX_BUFFERED_BYTES) {
      this.buffer = Buffer.alloc(0);
      this.pendingLiteral = null;
      this.current = null;
    }
    return completed;
  }
}

/** Every text line of one response, in order. */
export function imapResponseLines(response: ImapResponse): string[] {
  return response.segments.flatMap((segment) =>
    "text" in segment ? [segment.text] : [],
  );
}

/** The tag of one response: `*`, `+`, or the command tag. */
export function imapResponseTag(response: ImapResponse): string {
  const first = response.segments.find((segment) => "text" in segment);
  if (!first || !("text" in first)) return "";
  const space = first.text.indexOf(" ");
  return (space === -1 ? first.text : first.text.slice(0, space)).trim();
}

/** The status word of a tagged response: `OK`, `NO` or `BAD`. */
export function imapResponseStatus(response: ImapResponse): string {
  const lines = imapResponseLines(response);
  const last = lines[lines.length - 1] ?? "";
  const parts = last.split(" ");
  return (parts[1] ?? "").toUpperCase();
}

/**
 * The UIDs a `UID SEARCH` answered.
 *
 * The untagged line is `* SEARCH 4 5 9`; a search that matched nothing answers
 * `* SEARCH` with no ids, which is an empty list rather than a parse failure.
 */
export function parseSearchResponse(response: ImapResponse): number[] {
  const uids: number[] = [];
  for (const line of imapResponseLines(response)) {
    if (!/^\* SEARCH\b/i.test(line)) continue;
    for (const token of line.slice("* SEARCH".length).trim().split(/\s+/)) {
      if (token === "") continue;
      const uid = Number(token);
      if (Number.isInteger(uid) && uid > 0) uids.push(uid);
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

/**
 * Read one `FETCH` response into its uid and its message bytes.
 *
 * The uid is taken from the whole response, not from the text before the
 * literal: a server is free to answer `(BODY[] {n}\r\n… UID 42)`, with the uid
 * *after* the body, which is exactly what several servers do for the item list
 * this channel requests. Reading only the prefix would find no uid and drop the
 * message.
 */
export function parseFetchResponse(
  response: ImapResponse,
): { uid: number; source: Buffer } | null {
  const text = imapResponseLines(response).join("\n");
  if (!/\bFETCH\b/i.test(text)) return null;
  const uidMatch = /\bUID\s+(\d+)/i.exec(text);
  const literal = response.segments.find(
    (segment): segment is { literal: Buffer } => "literal" in segment,
  );
  if (!uidMatch || !literal) return null;
  const uid = Number(uidMatch[1]);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return { uid, source: literal.literal };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** A refusal the server gave: the status word and its numeric code, no text. */
export type ImapCommandFailure = {
  kind: "imap-failure";
  status: "NO" | "BAD";
  /** The server's response code (`AUTHENTICATIONFAILED`, …) when it gave one. */
  code?: string;
};

export type ImapClientOptions = {
  target: ImapTarget;
  username: string;
  password: string;
  mailbox?: string;
  commandTimeoutMs?: number;
  connect?: ImapSocketFactory;
};

/** What one fetched message is, before it is classified. */
export type ImapFetchedMessage = { uid: number; source: Buffer };

function failure(status: "NO" | "BAD", line: string): ImapCommandFailure {
  const code = /\[([A-Z0-9-]+)[ \]]/.exec(line);
  return { kind: "imap-failure", status, ...(code ? { code: code[1]! } : {}) };
}

/** Escape one IMAP quoted string; CR and LF are refused before this is called. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Whether a credential can be sent at all: no CR, no LF, no NUL. */
export function isImapCredentialSafe(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value);
}

/**
 * One IMAP session, one command at a time.
 *
 * The client is not a multiplexer: every method sends one command and waits for
 * its tagged completion, buffering the untagged responses in between. That is
 * all the polling session needs, and it keeps the ordering explicit — the
 * alternative (a concurrent command queue) would be machinery for a channel
 * that runs one poll at a time.
 */
export class ImapClient {
  private readonly options: ImapClientOptions;
  private socket: ImapRawSocket | null = null;
  private readonly reader = new ImapWireReader();
  private pending: {
    tag: string;
    untagged: ImapResponse[];
    resolve: (responses: ImapResponse[]) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private nextTag = 1;
  private failure: unknown = null;
  private capabilities: string[] = [];

  constructor(options: ImapClientOptions) {
    this.options = options;
  }

  /** The capability list the server answered to `CAPABILITY`. */
  get serverCapabilities(): string[] {
    return this.capabilities;
  }

  /** Open the connection and read the greeting. */
  async connect(): Promise<void> {
    if (!isImapCredentialSafe(this.options.username) || !isImapCredentialSafe(this.options.password)) {
      throw new Error("the IMAP credentials contain a character that cannot be sent");
    }
    const factory = this.options.connect ?? createImapSocketFactory();
    const socket = factory(this.options.target);
    this.socket = socket;
    socket.onData((chunk) => {
      for (const response of this.reader.push(chunk)) this.dispatch(response);
    });
    socket.onClose((reason) => {
      this.fail(new Error(reason ?? "the IMAP connection closed"));
    });
    socket.onError(() => {
      this.fail(new Error("the IMAP connection failed"));
    });
    // The greeting is an untagged `* OK`/`* BYE`, not a command's answer.
    const greeting = await this.readGreeting();
    if (!greeting) throw new Error("the IMAP server sent no greeting");
    if (/^\* BYE\b/i.test(greeting)) {
      throw new Error("the IMAP server refused the connection");
    }
  }

  /** `CAPABILITY`, remembered for the session. */
  async capability(): Promise<string[]> {
    const responses = await this.command("CAPABILITY");
    const line = responses
      .flatMap((response) => imapResponseLines(response))
      .find((entry) => /^\* CAPABILITY\b/i.test(entry));
    this.capabilities = line
      ? line.slice("* CAPABILITY".length).trim().split(/\s+/).filter(Boolean)
      : [];
    return this.capabilities;
  }

  /** `LOGIN <user> <password>`. A refusal is a typed failure, never a text echo. */
  async login(): Promise<void> {
    await this.command(`LOGIN ${quote(this.options.username)} ${quote(this.options.password)}`);
  }

  /** `SELECT <mailbox>`. */
  async select(mailbox = this.options.mailbox ?? "INBOX"): Promise<void> {
    await this.command(`SELECT ${quote(mailbox)}`);
  }

  /**
   * `UID SEARCH UNSEEN`, from `fromUid` upwards when one is given.
   *
   * The server-side range keeps the answer small on a busy mailbox; the caller
   * still filters, because the IMAP `n:*` range is specified to match the
   * highest message even when its uid is below `n` — a quirk that would
   * otherwise re-deliver the newest mail on every poll.
   */
  async searchUnseen(fromUid = 0): Promise<number[]> {
    const range = fromUid > 0 ? ` UID ${fromUid + 1}:*` : "";
    const responses = await this.command(`UID SEARCH UNSEEN${range}`);
    return parseSearchResponse(
      { segments: responses.flatMap((response) => response.segments) },
    );
  }

  /**
   * `UID FETCH <set> (BODY.PEEK[] UID)`.
   *
   * The command string is built in exactly one place so the "never marks a
   * message read" rule has one line to hold it, and the test that asserts the
   * command is asserting this line.
   */
  async fetchPeek(uids: readonly number[]): Promise<ImapFetchedMessage[]> {
    if (uids.length === 0) return [];
    const set = uids.join(",");
    const responses = await this.command(`UID FETCH ${set} (BODY.PEEK[] UID)`);
    const messages: ImapFetchedMessage[] = [];
    for (const response of responses) {
      const parsed = parseFetchResponse(response);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  /** `LOGOUT`; a failure here is not worth reporting, and never thrown to a poll. */
  async logout(): Promise<void> {
    try {
      if (this.socket) await this.command("LOGOUT");
    } catch {
      // The session is ending; the server's answer to LOGOUT changes nothing.
    } finally {
      this.close();
    }
  }

  /** Drop the connection without another command. */
  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  // -- internals ------------------------------------------------------------

  private readGreeting(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the IMAP server did not greet within the timeout"));
      }, this.options.commandTimeoutMs ?? IMAP_COMMAND_TIMEOUT_MS);
      this.greeting = { resolve, reject, timer };
    });
  }

  private greeting: {
    resolve: (line: string) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  private dispatch(response: ImapResponse): void {
    const tag = imapResponseTag(response);
    if (tag === "*" || tag === "+" || tag === "") {
      if (this.greeting) {
        const waiting = this.greeting;
        this.greeting = null;
        clearTimeout(waiting.timer);
        waiting.resolve(imapResponseLines(response).join("\r\n"));
        return;
      }
      this.pending?.untagged.push(response);
      return;
    }
    const pending = this.pending;
    if (!pending || pending.tag !== tag) return;
    this.pending = null;
    clearTimeout(pending.timer);
    const status = imapResponseStatus(response);
    const last = imapResponseLines(response).slice(-1)[0] ?? "";
    if (status === "OK") {
      pending.resolve([...pending.untagged, response]);
      return;
    }
    pending.reject(failure(status === "BAD" ? "BAD" : "NO", last));
  }

  private fail(error: unknown): void {
    this.failure = error;
    if (this.greeting) {
      const waiting = this.greeting;
      this.greeting = null;
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private command(text: string): Promise<ImapResponse[]> {
    if (!this.socket) return Promise.reject(new Error("the IMAP connection is not open"));
    if (this.failure) return Promise.reject(this.failure);
    const tag = `A${this.nextTag}`;
    this.nextTag += 1;
    return new Promise<ImapResponse[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.tag === tag) this.pending = null;
        reject(new Error("the IMAP server did not answer within the timeout"));
      }, this.options.commandTimeoutMs ?? IMAP_COMMAND_TIMEOUT_MS);
      this.pending = { tag, untagged: [], resolve, reject, timer };
      this.socket?.write(`${tag} ${text}\r\n`);
    });
  }
}
