/**
 * IRC's send half: the byte budget, the line framing, and the raw socket the
 * inbound client registers on.
 *
 * IRC has no HTTP API and no JSON envelope. A connection is a stream of
 * CRLF-terminated lines, and the only reply primitive is `PRIVMSG <target>
 * :<text>`. Three things follow, and each is a place ports of this channel
 * usually go wrong:
 *
 * 1. **The limit is bytes, not characters.** The protocol caps a line at 512
 *    bytes *including* CRLF and the `:nick!user@host` prefix the server adds to
 *    every relayed message. A 400-byte payload budget leaves room for a long
 *    hostmask. Counting characters instead would let 400 Chinese characters —
 *    1200 bytes — through, and the server would truncate the line mid-character,
 *    which is why non-English replies arrive mangled on channels that got this
 *    wrong. [`chunkIrcMessage`] measures UTF-8 and never cuts inside a code
 *    point.
 *
 * 2. **A message is a line.** Text containing a newline cannot travel in one
 *    PRIVMSG: the CRLF would end the line and the remainder would be parsed as
 *    a command. [`chunkIrcMessage`] therefore splits on newlines first, then by
 *    the byte budget, and [`ircPrivmsgLine`] strips CR/LF so a reply can never
 *    inject a second protocol line.
 *
 * 3. **Chunks go out in order.** [`createIrcSender`] rides the shared
 *    [`deliverInChunks`], which posts one chunk at a time and waits for each to
 *    be accepted before writing the next.
 *
 * The socket itself is injected ([`IrcSocketFactory`]) so the whole path is
 * testable against an in-process pair with no network.
 */

import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { StringDecoder } from "node:string_decoder";

import {
  chunkIngressText,
  deliverInChunks,
  type IngressDeliveryResult,
} from "./messaging-ingress.js";

/**
 * The protocol's own line limit, in bytes, including CRLF.
 *
 * Kept as a named constant beside the budget because the two are the same fact
 * seen from two sides: the budget is what is left of 512 after the prefix and
 * the framing.
 */
export const IRC_LINE_LIMIT_BYTES = 512;

/**
 * The payload budget for one PRIVMSG, in bytes.
 *
 * 400 of the 512 leaves 112 bytes for `CRLF` plus a prefix of the form
 * `:nick!user@host PRIVMSG #channel :` — generous for a long hostmask and a
 * long channel name, and deliberately not 512 so a relayed line is never
 * trimmed by the server.
 */
export const IRC_MESSAGE_LIMIT_BYTES = 400;

/** The registered TLS port for IRC. */
export const IRC_DEFAULT_TLS_PORT = 6697;

/** The registered plaintext port, accepted only for an explicitly configured LAN host. */
export const IRC_DEFAULT_PLAINTEXT_PORT = 6667;

/** Where one connection goes. */
export type IrcSocketTarget = {
  host: string;
  port: number;
  /** TLS is the default; plaintext is only ever a relaxed LAN hop. */
  tls: boolean;
};

/**
 * The minimal raw-socket surface this client uses.
 *
 * Deliberately smaller than `net.Socket`: four methods, string chunks in, one
 * line-oriented protocol out. A suite substitutes an in-process pair; the
 * production factory below adapts `node:net` / `node:tls`.
 */
export interface IrcRawSocket {
  /** Write one complete IRC line; the adapter appends the CRLF. */
  write(text: string): void;
  /** Close the connection. */
  end(): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** Opens one connection; injected so a suite needs no socket. */
export type IrcSocketFactory = (target: IrcSocketTarget) => IrcRawSocket;

/**
 * The production factory: TLS by default, plaintext only when the caller has
 * already decided the hop is a LAN one.
 *
 * Incoming bytes go through a `StringDecoder` so a UTF-8 character split across
 * two TCP reads is reassembled rather than turned into two replacement
 * characters — the same multibyte hazard as the send budget, on the receive
 * side. The TLS peer is verified against the host name the user configured, and
 * SNI carries that name only when it is a name and not an IP literal.
 */
export function createIrcSocketFactory(): IrcSocketFactory {
  return (target) => {
    const decoder = new StringDecoder("utf8");
    const socket: Socket | TLSSocket = target.tls
      ? tlsConnect({
          host: target.host,
          port: target.port,
          ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
          rejectUnauthorized: true,
        })
      : netConnect({ host: target.host, port: target.port });
    socket.setNoDelay(true);

    const dataHandlers: Array<(chunk: string) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];
    const errorHandlers: Array<(error: unknown) => void> = [];
    let closed = false;
    const emitClose = (reason: string) => {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler(reason);
    };

    socket.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (text.length === 0) return;
      for (const handler of dataHandlers) handler(text);
    });
    socket.on("close", () => emitClose("the connection closed"));
    socket.on("error", (error) => {
      for (const handler of errorHandlers) handler(error);
      emitClose(error instanceof Error ? error.message : "the connection failed");
    });

    return {
      write(text) {
        if (closed) return;
        try {
          socket.write(text);
        } catch {
          // The close event drives the reconnect; a failed write is not thrown
          // into the client's frame handler.
        }
      },
      end() {
        try {
          socket.end();
        } catch {
          // Already gone.
        }
      },
      onData(handler) {
        dataHandlers.push(handler);
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
      onError(handler) {
        errorHandlers.push(handler);
      },
    };
  };
}

/**
 * Split a reply into PRIVMSG payloads that respect IRC's byte budget.
 *
 * Newlines are split first — a payload can never contain CR or LF — and each
 * line is then divided by the shared byte-counted chunker, so:
 *
 * - no payload exceeds `budget` UTF-8 bytes;
 * - no multibyte character is split across two payloads;
 * - `chunks.join("")` is the input with CRLF normalised to LF, so nothing is
 *   lost or duplicated at a boundary.
 *
 * A blank line yields a chunk that is only a newline; the line formatter then
 * produces no wire line for it, which is the correct translation of "an empty
 * line" into a protocol where an empty PRIVMSG would be meaningless.
 */
export function chunkIrcMessage(
  text: string,
  budget: number = IRC_MESSAGE_LIMIT_BYTES,
): string[] {
  const size = Math.max(1, Math.floor(budget));
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks: string[] = [];
  let rest = normalised;
  while (rest.length > 0) {
    const newline = rest.indexOf("\n");
    const line = newline === -1 ? rest : rest.slice(0, newline);
    const tail = newline === -1 ? "" : "\n";
    const pieces = chunkIngressText(line, size, "bytes");
    if (pieces.length === 0) {
      chunks.push(tail);
    } else {
      pieces.forEach((piece, index) => {
        chunks.push(index === pieces.length - 1 ? `${piece}${tail}` : piece);
      });
    }
    rest = newline === -1 ? "" : rest.slice(newline + 1);
  }
  return chunks;
}

/**
 * One PRIVMSG line, without the CRLF.
 *
 * Every CR and LF is removed: the chunker never produces one in the middle of a
 * payload, so this is defence in depth against a reply — model output, which is
 * untrusted — injecting a second protocol line (`QUIT`, `OPER`, another
 * `PRIVMSG`) through a stray newline.
 */
export function ircPrivmsgLine(target: string, chunk: string): string {
  const text = chunk.replace(/[\r\n]+/g, " ");
  return `PRIVMSG ${target} :${text}`;
}

/** How the sender reaches the connection it was built for. */
export type IrcSenderOptions = {
  /** Write one line to the server, CRLF excluded. */
  write: (line: string) => void;
  /** Whether a connection is open right now. */
  isOpen: () => boolean;
  /** How the sender waits out a retry; injectable so tests need no sleeps. */
  wait?: (ms: number) => Promise<void>;
  /**
   * Reports each chunk as it is posted.
   *
   * A wire line cannot carry the newline a chunk ended on, so a suite that only
   * read the socket could not reconstruct what the chunker produced. This is the
   * seam that lets the shared conformance suite assert chunking and ordering at
   * the sender rather than inferring them from framing.
   */
  onChunk?: (chunk: string) => void;
};

export type IrcSender = {
  /** Deliver one reply, one PRIVMSG per chunk, in order. */
  send(target: string, text: string): Promise<IngressDeliveryResult>;
};

/**
 * The reply path: the shared sequential chunk delivery over `PRIVMSG`.
 *
 * A connection that is not open refuses the send instead of writing into a dead
 * socket: the reply is lost either way, and "refused" tells the caller why
 * rather than looking like a success. Nothing here reaches the network by
 * itself — every line goes through the client's own `write`.
 */
export function createIrcSender(options: IrcSenderOptions): IrcSender {
  return {
    async send(target, text) {
      let sent = 0;
      return deliverInChunks(text, {
        platform: "irc",
        limit: IRC_MESSAGE_LIMIT_BYTES,
        limitUnit: "bytes",
        chunk: (reply) => chunkIrcMessage(reply),
        post: async (chunk) => {
          if (!options.isOpen()) {
            return { kind: "refused", error: "the IRC connection is not open" };
          }
          options.onChunk?.(chunk);
          const text = chunk.replace(/\r?\n+$/, "").replace(/[\r\n]+/g, " ");
          if (text.trim() === "") {
            // A chunk that carried only a newline: an empty PRIVMSG would be
            // meaningless, so the separator alone is not transmitted.
            return { kind: "accepted", id: `irc-${sent}` };
          }
          options.write(`PRIVMSG ${target} :${text}`);
          sent += 1;
          return { kind: "accepted", id: `irc-${sent}` };
        },
        ...(options.wait ? { wait: options.wait } : {}),
      });
    },
  };
}
