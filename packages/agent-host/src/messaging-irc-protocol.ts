/**
 * IRC wire format: line parsing, address validation, nick and channel rules,
 * and the normalisation that turns a `PRIVMSG` into one inbound message.
 *
 * This module holds the protocol grammar only. Everything about sockets,
 * reconnects, registration state and delivery lives in
 * `messaging-irc-inbound.ts`, so the parser can be read — and tested — without
 * a connection.
 */
import { ingressMessageKey, type IngressNormalisation } from "./messaging-ingress.js";
import { type IngressSocket } from "./messaging-ingress-socket.js";
import { validateInboundEndpoint, type InboundMessage } from "./messaging-inbound.js";
import {
  IRC_DEFAULT_PLAINTEXT_PORT,
  IRC_DEFAULT_TLS_PORT,
  type IrcRawSocket,
  type IrcSocketTarget,
} from "./messaging-irc-send.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Endpoint and nick/channel validation
// ---------------------------------------------------------------------------

/** One validated server address. */
export type IrcEndpoint = IrcSocketTarget;

/**
 * Validate an IRC server address through the shared endpoint rule.
 *
 * The user may write `ircs://host:6697`, `irc://host:6671`, or a bare
 * `host:port`/`host` (which means TLS). The scheme is translated to the
 * HTTP-shaped rule the shared validator implements — `ircs` → `https`, `irc` →
 * `http` — so TLS is required, and a plaintext address is accepted only for a
 * loopback, `.local` or private LAN host under the relaxed network policy. That
 * is the same discipline, and the same refusal strings, as every other channel;
 * there is no second security rule to keep in step.
 *
 * A path, query or userinfo is refused: an IRC endpoint is an address, and
 * userinfo would be a credential in a URL.
 */
export function validateIrcEndpoint(
  raw: unknown,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; endpoint: IrcEndpoint } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "the configured server is empty" };
  }
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `ircs://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "the configured server is not an address" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "ircs:" && scheme !== "irc:" && scheme !== "https:" && scheme !== "http:") {
    return {
      ok: false,
      error: "the server must be an ircs:// (TLS) address, or irc:// for a LAN host",
    };
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return { ok: false, error: "the server address must not carry a path" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "the server address must not carry a query" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "the server address must not contain userinfo" };
  }
  const tls = scheme === "ircs:" || scheme === "https:";
  const mapped = `${tls ? "https" : "http"}://${parsed.host}`;
  const checked = validateInboundEndpoint(mapped, options);
  if (!checked.ok) return checked;
  const host = checked.url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return { ok: false, error: "the server must name a host" };
  const port = checked.url.port
    ? Number(checked.url.port)
    : tls
      ? IRC_DEFAULT_TLS_PORT
      : IRC_DEFAULT_PLAINTEXT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "the server port must be between 1 and 65535" };
  }
  return { ok: true, endpoint: { host, port, tls } };
}

/**
 * Is this a nick the protocol can register?
 *
 * Refused: empty, whitespace, and the characters that would split the `NICK`
 * line or collide with channel syntax (`:`, `,`, `#`, `&`, `@`, `*`, `!`).
 */
export function isIrcNickValid(nick: unknown): nick is string {
  if (typeof nick !== "string") return false;
  const value = nick.trim();
  if (value.length === 0 || value.length > 32) return false;
  return !/[\s:,#&@*!+%]/.test(value);
}

/**
 * Normalise the configured channel list.
 *
 * `destination` (the linked conversation) is always joined, so a record that
 * names only the linked channel works without repeating it. A bare name gets a
 * `#` prefix; anything that still does not start with `#` or `&` is dropped as
 * not a channel. Order is preserved and duplicates are removed
 * case-insensitively, because IRC channel names are case-insensitive.
 */
export function normaliseIrcChannels(
  channels: unknown,
  destination?: unknown,
): string[] {
  const raw: string[] = [];
  if (typeof channels === "string") {
    raw.push(...channels.split(/[,\s]+/));
  } else if (Array.isArray(channels)) {
    for (const entry of channels) if (typeof entry === "string") raw.push(...entry.split(/[,\s]+/));
  }
  if (typeof destination === "string") raw.push(destination.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const prefixed = /^[#&]/.test(trimmed) ? trimmed : `#${trimmed}`;
    const key = prefixed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(prefixed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/** One parsed IRC line. `nick` is the prefix's nick, when the prefix is one. */
export type IrcLine = {
  prefix: string;
  nick: string;
  command: string;
  params: string[];
};

/**
 * Parse one IRC line (CRLF already removed).
 *
 * `:prefix COMMAND param… :trailing` — the trailing parameter is the last one
 * and may contain spaces. A line that names no command is refused, so nothing
 * half-understood ever reaches the routing path.
 */
export function parseIrcLine(line: string): IrcLine | null {
  let rest = line;
  let prefix = "";
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  if (rest === "") return null;
  const params: string[] = [];
  let command = "";
  while (rest.length > 0) {
    if (rest.startsWith(":")) {
      // The trailing parameter: everything after the colon, spaces included.
      params.push(rest.slice(1));
      break;
    }
    const space = rest.indexOf(" ");
    const token = space === -1 ? rest : rest.slice(0, space);
    rest = space === -1 ? "" : rest.slice(space + 1);
    if (command === "") command = token;
    else if (token !== "") params.push(token);
  }
  if (command === "") return null;
  const nick = prefix.includes("!") ? prefix.slice(0, prefix.indexOf("!")) : prefix;
  return { prefix, nick, command: command.toUpperCase(), params };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * One inbound event, in the shape this channel's classifier reads.
 *
 * The client builds it from a parsed `PRIVMSG`; the id is assigned on receipt
 * because IRC has no message ids of its own. A redelivery of the same *line*
 * therefore carries the same id only within one client instance — which is
 * exactly right, because an IRC server does not replay history: the durable
 * guard's job here is to stop the same line being applied twice, not to
 * recognise a platform redelivery that never happens.
 */
export type IrcInboundEvent = {
  /** The PRIVMSG target, as the server spelled it. */
  channel: string;
  /** The sender's nick, as the server spelled it. */
  nick: string;
  /** The message text, CTCP markers included. */
  text: string;
  /** The id this client assigned on receipt. */
  messageId: string;
};

export type IrcNormaliseOptions = {
  /** The nick this client registered, in the casing the server confirmed. */
  ownNick: string;
  /** Every channel this client joined. */
  channels: readonly string[];
};

/**
 * Project one inbound event onto the shared shape.
 *
 * Refused, each with the reason the audit record carries:
 *
 * - a message outside every configured channel — IRC delivers private messages
 *   on the same command, and acting on a DM would bypass the channel's link;
 * - our own nick, compared case-insensitively: IRC nicks are case-insensitive
 *   and a server echoes our own PRIVMSG back with *its* casing, so a
 *   case-sensitive check is the classic self-reply loop;
 * - CTCP — anything beginning with `\x01`, `ACTION` included. Delivering an
 *   action's body as plain text would turn `/me waves` into a command;
 * - a message with no text, and an event that is not a message at all.
 *
 * The chat id is the configured channel's spelling, not the server's, so a reply
 * always goes to the exact channel that was joined.
 */
export function normaliseIrcMessage(
  raw: unknown,
  options: IrcNormaliseOptions,
): IngressNormalisation {
  if (!isRecord(raw)) {
    return { kind: "filtered", reason: "the event is not an IRC message" };
  }
  const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
  const nick = typeof raw.nick === "string" ? raw.nick.trim() : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  const messageId = typeof raw.messageId === "string" ? raw.messageId.trim() : "";
  const channelId = channel || undefined;

  if (channel === "") {
    return {
      kind: "filtered",
      reason: "the message names no channel",
      ...(channelId ? { channelId } : {}),
    };
  }
  const configured = options.channels.find(
    (entry) => entry.toLowerCase() === channel.toLowerCase(),
  );
  if (!configured) {
    return {
      kind: "filtered",
      reason: "the message is not in a configured channel",
      channelId,
    };
  }
  if (nick !== "" && nick.toLowerCase() === options.ownNick.trim().toLowerCase()) {
    return { kind: "filtered", reason: "the message is the client's own", channelId };
  }
  if (text.startsWith("\u0001")) {
    return { kind: "filtered", reason: "CTCP is not a message", channelId };
  }
  if (text.trim() === "") {
    return { kind: "filtered", reason: "the message carries no text", channelId };
  }
  if (messageId === "") {
    return { kind: "filtered", reason: "the message names no id", channelId };
  }
  const message: InboundMessage = { messageId, chatId: configured, text };
  return { kind: "message", message, key: ingressMessageKey(configured, messageId) };
}

// ---------------------------------------------------------------------------
// The line socket
// ---------------------------------------------------------------------------

/**
 * A raw byte stream presented as one IRC line per frame.
 *
 * The shared socket lifecycle expects whole frames; IRC delivers bytes. This
 * adapter is the whole difference: buffer, split on CRLF, hand each line up.
 * An unterminated line that grows past [`MAX_INBOUND_BUFFER_BYTES`] is dropped
 * and audited rather than buffered without bound.
 */
export const MAX_INBOUND_BUFFER_BYTES = 64 * 1024;

export class IrcLineSocket implements IngressSocket {
  private buffer = "";
  private readonly raw: IrcRawSocket;
  private readonly onOverflow: (reason: string) => void;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code?: number, reason?: string) => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;

  constructor(raw: IrcRawSocket, onOverflow: (reason: string) => void) {
    this.raw = raw;
    this.onOverflow = onOverflow;
    raw.onData((chunk) => this.consume(chunk));
    raw.onClose((reason) => this.closeHandler?.(undefined, reason ?? "the connection closed"));
    raw.onError((error) => this.errorHandler?.(error));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.messageHandler?.(line);
    }
    if (this.buffer.length > MAX_INBOUND_BUFFER_BYTES) {
      this.buffer = "";
      this.onOverflow("an unterminated line exceeded the buffer");
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code?: number, reason?: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }

  send(data: string): void {
    this.raw.write(`${data}\r\n`);
  }

  close(): void {
    this.raw.end();
  }
}
