/**
 * The fake IMAP and SMTP servers the email channel's tests drive.
 *
 * Both are *real* TCP servers on `127.0.0.1:0` and both speak bytes, because the
 * two rules this channel exists to hold are wire rules: an IMAP literal is not a
 * line, and a header is not free text. A double that handed the client
 * pre-split strings would skip both.
 *
 * This module is test support only; nothing imports it from production code.
 */

import { connect as netConnect, createServer, type Server, type Socket } from "node:net";

import { IMAP_DEFAULT_TLS_PORT, type ImapRawSocket, type ImapSocketFactory, type ImapTarget } from "./messaging-email-imap.js";
import type { SmtpRawSocket, SmtpSocketFactory, SmtpTarget } from "./messaging-email-smtp.js";

export const IMAP_TARGET: ImapTarget = { host: "127.0.0.1", port: IMAP_DEFAULT_TLS_PORT };
export const SMTP_TARGET: SmtpTarget = { host: "127.0.0.1", port: 587, security: "tls" };
/** The password every fixture authenticates with; a test asserts it never leaks. */
export const PASSWORD = "hunter2-app-password";
export const ALLOWED = ["alice@example.org"];
export const CRLF_BODY = "first line\r\nsecond line\r\n\r\nfourth line";

/** A plain-text message with a CRLF header block and a CRLF body. */
export function plainMessage(options: {
  from?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  extra?: string;
}): Buffer {
  const headers = [
    `From: ${options.from ?? "Alice <alice@example.org>"}`,
    "To: bot@example.org",
    `Subject: ${options.subject ?? "a plain subject"}`,
    `Message-ID: ${options.messageId ?? "<m-1@example.org>"}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    ...(options.extra ? [options.extra] : []),
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${options.body ?? CRLF_BODY}`, "utf8");
}

/** One connection's early bytes, held until a handler is attached. */
class EarlyBuffer<T> {
  private readonly pending: T[] = [];
  private attached = false;

  push(chunk: T, deliver: (chunk: T) => void): void {
    if (this.attached) deliver(chunk);
    else this.pending.push(chunk);
  }

  attach(deliver: (chunk: T) => void): void {
    this.attached = true;
    for (const chunk of this.pending.splice(0)) deliver(chunk);
  }
}

export type FakeImapOptions = {
  username?: string;
  password?: string;
  loginOk?: boolean;
  /** The UIDs the mailbox holds, and what `UID SEARCH UNSEEN` answers. */
  uids?: number[];
  messages?: Map<number, Buffer>;
  /** Answer `UID FETCH` with the uid *after* the literal, as several servers do. */
  uidAfterBody?: boolean;
};

/**
 * A fake IMAP4rev1 server: greeting, CAPABILITY, LOGIN, SELECT, UID SEARCH,
 * UID FETCH with real literals, LOGOUT.
 *
 * `commands` is every client line as it arrived, tag included — so an assertion
 * that `BODY.PEEK[]` was used is an assertion about what this server received.
 */
export class FakeImap {
  readonly commands: string[] = [];
  private readonly options: FakeImapOptions;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(options: FakeImapOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.write("* OK [CAPABILITY IMAP4rev1 UIDPLUS] fake imap ready\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        for (;;) {
          const newline = buffer.indexOf("\r\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          this.commands.push(line);
          this.handle(socket, line);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  get factory(): ImapSocketFactory {
    const port = this.port;
    return (_target: ImapTarget): ImapRawSocket => {
      const socket = netConnect({ host: "127.0.0.1", port });
      const data: Array<(chunk: Buffer) => void> = [];
      const close: Array<(reason?: string) => void> = [];
      const error: Array<(failure: unknown) => void> = [];
      const early = new EarlyBuffer<Buffer>();
      socket.on("data", (chunk) => early.push(chunk, (value) => data.forEach((h) => h(value))));
      socket.on("close", () => close.forEach((handler) => handler("the connection closed")));
      socket.on("error", (failure) => error.forEach((handler) => handler(failure)));
      return {
        write: (text) => socket.write(text),
        end: () => socket.end(),
        onData: (handler) => {
          data.push(handler);
          early.attach(handler);
        },
        onClose: (handler) => close.push(handler),
        onError: (handler) => error.push(handler),
      };
    };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private handle(socket: Socket, line: string): void {
    const space = line.indexOf(" ");
    const tag = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? "" : line.slice(space + 1);
    const upper = rest.toUpperCase();

    if (upper.startsWith("CAPABILITY")) {
      socket.write("* CAPABILITY IMAP4rev1 UIDPLUS\r\n");
      socket.write(`${tag} OK CAPABILITY completed\r\n`);
      return;
    }
    if (upper.startsWith("LOGIN ")) {
      if (!(this.options.loginOk ?? true)) {
        socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        return;
      }
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (upper.startsWith("SELECT ")) {
      socket.write("* 3 EXISTS\r\n");
      socket.write("* OK [UIDVALIDITY 1] UIDs valid\r\n");
      socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
      return;
    }
    if (upper.startsWith("UID SEARCH")) {
      const range = /UID (\d+):\*/i.exec(rest);
      const all = this.options.uids ?? [];
      let answered = all;
      if (range) {
        const from = Number(range[1]);
        // IMAP's `n:*` matches the highest message even when its uid is below
        // `n`. Answering that quirk is the point: the client must still filter,
        // or it re-delivers the newest mail on every poll.
        const highest = all.length > 0 ? all[all.length - 1]! : 0;
        answered = all.filter((uid) => uid >= from);
        if (highest > 0 && highest < from && !answered.includes(highest)) {
          answered = [...answered, highest];
        }
      }
      socket.write(`* SEARCH${answered.length > 0 ? ` ${answered.join(" ")}` : ""}\r\n`);
      socket.write(`${tag} OK SEARCH completed\r\n`);
      return;
    }
    if (upper.startsWith("UID FETCH")) {
      const set = /UID FETCH ([0-9,]+)/i.exec(rest)?.[1] ?? "";
      const messages = this.options.messages ?? new Map<number, Buffer>();
      let sequence = 1;
      for (const piece of set.split(",")) {
        const uid = Number(piece);
        const body = messages.get(uid);
        if (!body) continue;
        this.writeFetch(socket, sequence, uid, body);
        sequence += 1;
      }
      socket.write(`${tag} OK FETCH completed\r\n`);
      return;
    }
    if (upper.startsWith("LOGOUT")) {
      socket.write("* BYE fake imap logging out\r\n");
      socket.write(`${tag} OK LOGOUT completed\r\n`);
      return;
    }
    socket.write(`${tag} BAD unrecognised command\r\n`);
  }

  /** One FETCH response whose body is a true literal, CRLFs and all. */
  private writeFetch(socket: Socket, sequence: number, uid: number, body: Buffer): void {
    const after = this.options.uidAfterBody ?? false;
    const before = after
      ? `* ${sequence} FETCH (BODY[] {${body.length}}\r\n`
      : `* ${sequence} FETCH (UID ${uid} BODY[] {${body.length}}\r\n`;
    const afterText = after ? ` UID ${uid})\r\n` : ")\r\n";
    socket.write(Buffer.from(before, "latin1"));
    socket.write(body);
    socket.write(Buffer.from(afterText, "latin1"));
  }
}

export type FakeSmtpOptions = {
  /** The reply AUTH LOGIN's password step gets. */
  authCode?: number;
  /** The reply MAIL FROM gets, when it is not 250. */
  mailFromCode?: number;
  requireStartTls?: boolean;
};

/** A fake submission server: EHLO, AUTH LOGIN, MAIL/RCPT/DATA, QUIT. */
export class FakeSmtp {
  readonly commands: string[] = [];
  readonly dataPayloads: string[] = [];
  readonly connections: number[] = [];
  private readonly options: FakeSmtpOptions;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(options: FakeSmtpOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.connections.push(1);
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.write("220 fake.smtp.test ESMTP ready\r\n");
      let buffer = "";
      let dataMode = false;
      let step: "idle" | "user" | "password" = "idle";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        for (;;) {
          if (dataMode) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            this.dataPayloads.push(FakeSmtp.unstuff(buffer.slice(0, end)));
            buffer = buffer.slice(end + 5);
            dataMode = false;
            socket.write("250 2.0.0 Ok: queued as fake-1\r\n");
            continue;
          }
          const newline = buffer.indexOf("\r\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          this.commands.push(line);

          if (step === "user") {
            step = "password";
            socket.write("334 UGFzc3dvcmQ6\r\n");
            continue;
          }
          if (step === "password") {
            step = "idle";
            const code = this.options.authCode ?? 235;
            socket.write(
              code === 235
                ? "235 2.7.0 Authentication successful\r\n"
                : `${code} 5.7.8 Authentication failed\r\n`,
            );
            continue;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO")) {
            socket.write("250-fake.smtp.test\r\n");
            socket.write("250-AUTH LOGIN\r\n");
            if (this.options.requireStartTls) socket.write("250-STARTTLS\r\n");
            socket.write("250 SIZE 10485760\r\n");
            continue;
          }
          if (upper.startsWith("AUTH LOGIN")) {
            step = "user";
            socket.write("334 VXNlcm5hbWU6\r\n");
            continue;
          }
          if (upper.startsWith("MAIL FROM")) {
            const code = this.options.mailFromCode ?? 250;
            socket.write(
              code === 250 ? "250 2.1.0 Ok\r\n" : `${code} 4.3.2 Service not available\r\n`,
            );
            continue;
          }
          if (upper.startsWith("RCPT TO")) {
            socket.write("250 2.1.5 Ok\r\n");
            continue;
          }
          if (upper === "DATA") {
            dataMode = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            continue;
          }
          if (upper === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
            continue;
          }
          socket.write("500 5.5.2 unrecognised\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  get factory(): SmtpSocketFactory {
    const port = this.port;
    return (_target: SmtpTarget): SmtpRawSocket => {
      const socket = netConnect({ host: "127.0.0.1", port });
      const data: Array<(chunk: string) => void> = [];
      const close: Array<(reason?: string) => void> = [];
      const error: Array<(failure: unknown) => void> = [];
      const early = new EarlyBuffer<string>();
      socket.on("data", (chunk) => {
        const text = chunk.toString("latin1");
        early.push(text, (value) => data.forEach((h) => h(value)));
      });
      socket.on("close", () => close.forEach((handler) => handler("the connection closed")));
      socket.on("error", (failure) => error.forEach((handler) => handler(failure)));
      return {
        write: (text) => socket.write(text),
        end: () => socket.end(),
        onData: (handler) => {
          data.push(handler);
          early.attach(handler);
        },
        onClose: (handler) => close.push(handler),
        onError: (handler) => error.push(handler),
      };
    };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private static unstuff(payload: string): string {
    return payload
      .split("\r\n")
      .map((line) => (line.startsWith("..") ? line.slice(1) : line))
      .join("\r\n");
  }
}
