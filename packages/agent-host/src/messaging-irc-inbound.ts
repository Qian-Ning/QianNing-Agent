/**
 * The inbound IRC channel over a raw TCP/TLS socket — the adapter half.
 *
 * IRC is the simplest protocol in this set and the one most often got wrong in
 * the same three ways: registration is fire-and-forget, so a taken nick or a bad
 * password looks like a healthy connection that never receives anything; PING is
 * unanswered, so the server drops the link every few minutes; and the 512-byte
 * line is treated as a character count, so a non-English reply is truncated
 * mid-character. This module is written against those three failures
 * explicitly.
 *
 * # What is shared and what is IRC's
 *
 * The connection lifecycle (attach, readiness, close waiters, a send that
 * tolerates a dead socket) and the reconnect discipline (jittered, capped
 * backoff) are the shared socket transport's
 * ([`./messaging-ingress-socket.js`]); the dedupe ordering, the audit
 * vocabulary and the chunker are the shared ingress layer's
 * ([`./messaging-ingress.js`]). This module supplies only:
 *
 * - **connect** — open the socket, send `PASS`/`NICK`/`USER`, and *await the
 *   registration result*: `001` welcomes, and `433`, `432`, `464`, `465`, `461`
 *   and `451` are refusals that are audited and thrown, so a rejected
 *   registration is reported rather than silently retried forever;
 * - **keepalive** — the server's `PING` is answered with a `PONG` carrying the
 *   same token. The shared socket layer cannot answer it: it does not know the
 *   protocol's keepalive, and an unanswered PING is exactly why an IRC link
 *   dies every few minutes;
 * - **join** — every configured channel is joined after `001`, one `JOIN` per
 *   channel. `353` (NAMES) and `366` (end of NAMES) are protocol bookkeeping,
 *   not messages, and are never routed;
 * - **normalise** — one `PRIVMSG` to a configured channel becomes one turn;
 *   our own nick (in any casing the server chose), `NOTICE`, and CTCP (anything
 *   wrapped in `\x01`, such as `ACTION`) are filtered with a reason;
 * - **deliver** — `PRIVMSG #channel :text`, one line per chunk, sequential
 *   (see [`./messaging-irc-send.js`] for the byte budget and its rationale);
 * - **limit** — 400 bytes of payload, declared as `messageLimitUnit: "bytes"`.
 *
 * # Deliberately not implemented
 *
 * No SASL (`AUTHENTICATE`/`CAP`), and no TLS client certificates. Both are
 * supported by the settings walkthrough's own text and by nothing else: a
 * server that requires SASL refuses registration with `421`/`904`, which this
 * module reports as a registration refusal instead of pretending to
 * authenticate. Plaintext is accepted only where the endpoint rule allows a LAN
 * hop — the same [`validateInboundEndpoint`] discipline every other channel
 * applies, with `ircs://` treated as HTTPS and `irc://` as HTTP, so a plaintext
 * server address is refused unless the relaxed policy names a loopback, `.local`
 * or private LAN host.
 *
 * # Credential handling
 *
 * The optional server password is a `secret:` reference in the settings section,
 * read by the composition root, and handed to this module only to be written as
 * a `PASS` line. It is never placed in an audit entry, an error message, a
 * route, or a reconnect delay — the refusal reasons are fixed strings that name
 * the numeric, not the parameter that carried the password.
 */

import {
  IngressGate,
  ingressMessageKey,
  type IngressAudit,
  type IngressDeliveryResult,
  type IngressNormalisation,
  type IngressMessage,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";
import {
  createSocketIngressTransport,
  SocketIngressClient,
  type IngressSocket,
} from "./messaging-ingress-socket.js";
import {
  createIrcSender,
  createIrcSocketFactory,
  IRC_DEFAULT_PLAINTEXT_PORT,
  IRC_DEFAULT_TLS_PORT,
  IRC_MESSAGE_LIMIT_BYTES,
  type IrcRawSocket,
  type IrcSocketFactory,
  type IrcSocketTarget,
} from "./messaging-irc-send.js";
import type {
  InboundMessage,
  MessagingInboundPushTransport,
} from "./messaging-inbound.js";
import {
  IrcLineSocket,
  isIrcNickValid,
  normaliseIrcChannels,
  normaliseIrcMessage,
  parseIrcLine,
  validateIrcEndpoint,
  type IrcEndpoint,
  type IrcInboundEvent,
  type IrcLine,
  type IrcNormaliseOptions,
} from "./messaging-irc-protocol.js";

export {
  IRC_DEFAULT_PLAINTEXT_PORT,
  IRC_DEFAULT_TLS_PORT,
  IRC_LINE_LIMIT_BYTES,
  IRC_MESSAGE_LIMIT_BYTES,
  chunkIrcMessage,
  createIrcSender,
  createIrcSocketFactory,
  ircPrivmsgLine,
  type IrcRawSocket,
  type IrcSender,
  type IrcSocketFactory,
  type IrcSocketTarget,
} from "./messaging-irc-send.js";

/** The settings section the IRC channel's record lives in, inside `app`. */
export {
  IrcLineSocket,
  MAX_INBOUND_BUFFER_BYTES,
  isIrcNickValid,
  normaliseIrcChannels,
  normaliseIrcMessage,
  parseIrcLine,
  validateIrcEndpoint,
  type IrcEndpoint,
  type IrcInboundEvent,
  type IrcLine,
  type IrcNormaliseOptions,
} from "./messaging-irc-protocol.js";

export const MESSAGING_IRC_SECTION = "messagingIrc";
/** The record's self-identifying format. */
export const MESSAGING_IRC_FORMAT = "pi-desktop-messaging-irc";
/** The record version this build reads. */
export const MESSAGING_IRC_FORMAT_VERSION = 1;
/** Where the optional server password lives in the host's secret store. */
export const MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF = "secret:messaging-irc:server-password";

/** The most message keys the settings-backed replay guard remembers. */
export const IRC_HANDLED_CAPACITY = 2048;

/** How long a registration may stay unanswered before the attempt fails. */
export const IRC_REGISTRATION_TIMEOUT_MS = 20_000;

/** One audit record. Structure and ids only — never message text or a password. */
export type IrcInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "malformed"; reason: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "processed"; messageId: string }
  | { kind: "process-failed"; messageId: string; error: string }
  | { kind: "record-failed"; messageId: string; error: string }
  | { kind: "send-failed"; channelId: string; error: string };

export type IrcInboundAudit = (entry: IrcInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in IRC's published entry type: message
 * ids are `messageId`, and there is no `identity-failed` step because IRC has
 * no identity lookup — the nick *is* the identity and registration reports it.
 */
function ircAudit(sink?: IrcInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "duplicate":
      case "processed":
        return sink({ kind: entry.kind, messageId: entry.eventId });
      case "process-failed":
      case "record-failed":
        return sink({ kind: entry.kind, messageId: entry.eventId, error: entry.error });
      case "auth-failed":
      case "connect-failed":
        return sink({ kind: entry.kind, error: entry.error });
      case "disconnect":
        return sink({ kind: "disconnect", reason: entry.reason });
      case "malformed":
        return sink({ kind: "malformed", reason: entry.reason });
      case "filtered":
        return sink({
          kind: "filtered",
          reason: entry.reason,
          ...(entry.channelId ? { channelId: entry.channelId } : {}),
        });
      default:
        // `heartbeat-missed` is Discord's; IRC's keepalive is the server's PING.
        return;
    }
  };
}


// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type IrcTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type IrcClientOptions = {
  /** The validated server address. */
  endpoint: IrcTargetOptions;
  /** The nick to register. */
  nick: string;
  /** Every channel to join after `001`. */
  channels: readonly string[];
  /** The optional server password, written once as `PASS` and nowhere else. */
  password?: string;
  /** The restart-durable replay guard. */
  handled: { has(key: string): Promise<boolean>; record(key: string): Promise<void> };
  /** The neutral handler the driver's routing path provides. */
  onMessage: (message: InboundMessage) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: IrcInboundAudit;
  /** The raw socket seam; defaults to the TLS/plaintext production factory. */
  connect?: IrcSocketFactory;
  /** How long an unanswered registration waits; defaults to 20s. */
  registrationTimeoutMs?: number;
  /** The timer surface, injectable so a suite needs no wall clock. */
  timers?: IrcTimers;
  /** Reports each reply chunk as it is written (see [`IrcSenderOptions`]). */
  onChunk?: (chunk: string) => void;
};

/** The server address, as the settings record carries it. */
export type IrcTargetOptions = IrcSocketTarget;

/** The numerics this client acts on, and the reason each one refuses. */
const REGISTRATION_REFUSALS: Record<string, string> = {
  "431": "no nickname was given",
  "432": "the nickname was refused as invalid",
  "433": "the nickname is already in use",
  "436": "the nickname collided with another client",
  "451": "the server requires registration first",
  "461": "registration was missing a parameter",
  "464": "the server password was rejected",
  "465": "this client is banned from the server",
};

/**
 * The IRC client: registration, keepalive, joins, and the shared dedupe gate.
 *
 * The connection lifecycle and the reconnect policy belong to the shared socket
 * layer. What is here is the protocol: `PASS`/`NICK`/`USER`, the numerics that
 * decide whether registration succeeded, `PING`/`PONG`, `JOIN`, and the
 * `PRIVMSG` projection.
 *
 * `connect()` resolves only once registration *succeeded* — `001` was received —
 * and rejects on a refusal numeric, on a socket error, on a close before `001`,
 * or on the registration timeout. That is what makes a taken nick or a bad
 * password an error the composition root can see, instead of a connection that
 * looks established and never receives a message.
 */
export class IrcClient extends SocketIngressClient {
  private readonly options: IrcClientOptions;
  private readonly timers: IrcTimers;
  private readonly gate: IngressGate;
  /** The nick the server confirmed; falls back to the configured one. */
  private confirmedNick: string;
  /** Number of messages this run has assigned an id to. */
  private sequence = 0;
  private registration: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private registrationTimer: unknown = null;
  /** The last registration refusal, so a caller can surface it without a log. */
  private refusal: string | null = null;

  constructor(options: IrcClientOptions) {
    const audit = ircAudit(options.audit);
    super({ audit });
    this.options = options;
    this.confirmedNick = options.nick.trim();
    this.gate = new IngressGate({ handled: options.handled, onMessage: options.onMessage, audit });
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** The nick this client is known as, once the server has confirmed it. */
  get nick(): string {
    return this.confirmedNick;
  }

  /** The reason the last registration was refused, or `null`. */
  get lastRefusal(): string | null {
    return this.refusal;
  }

  /** Every channel this client joins. */
  get channels(): readonly string[] {
    return this.options.channels;
  }

  /**
   * Open one connection and wait for registration to finish.
   *
   * The password, when present, is written as the first line and then dropped
   * from every report this method can produce: a refusal is reported by its
   * numeric and a fixed reason, never by echoing the parameter the server
   * quoted back.
   */
  async connect(): Promise<void> {
    const nick = this.options.nick.trim();
    if (!isIrcNickValid(nick)) {
      const error = "the configured nick cannot be registered";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    this.refusal = null;
    this.confirmedNick = nick;
    const pending = new Promise<void>((resolve, reject) => {
      this.registration = { resolve, reject };
    });
    const factory = this.options.connect ?? createIrcSocketFactory();
    this.attach(
      new IrcLineSocket(factory(this.options.endpoint), (reason) =>
        this.audit({ kind: "malformed", reason }),
      ),
    );
    const timeout = Math.max(0, this.options.registrationTimeoutMs ?? IRC_REGISTRATION_TIMEOUT_MS);
    this.registrationTimer = this.timers.setTimeout(() => {
      this.failRegistration("the server did not answer registration in time");
    }, timeout);

    const password = this.options.password?.trim() ?? "";
    if (password !== "") this.sendText(`PASS :${password}`);
    this.sendText(`NICK ${nick}`);
    this.sendText(`USER ${nick} 0 * :${nick}`);

    await pending;
  }

  /** Stop the registration timer with the connection that owned it. */
  protected onDisconnect(): void {
    this.clearRegistrationTimer();
    const pending = this.registration;
    this.registration = null;
    pending?.reject(new Error("the connection closed before registration completed"));
  }

  /** Route one raw line. */
  async handleFrame(raw: string): Promise<void> {
    const parsed = parseIrcLine(raw);
    if (!parsed) {
      this.audit({ kind: "malformed", reason: "the line names no command" });
      return;
    }
    const { command, params, nick } = parsed;

    if (command === "PING") {
      // The keepalive belongs to the protocol, so it belongs here: an
      // unanswered PING is why an IRC link silently dies every few minutes.
      // The PONG carries the server's token verbatim, which is how the server
      // matches the answer to the probe it sent.
      this.sendText(`PONG :${params.join(" ")}`);
      return;
    }
    if (command === "ERROR") {
      this.finishClose("the server sent ERROR");
      return;
    }
    if (/^\d{3}$/.test(command)) {
      this.handleNumeric(command, params);
      return;
    }
    if (command === "PRIVMSG") {
      await this.handlePrivmsg(nick, params);
      return;
    }
    // NOTICE, JOIN, PART, NICK, QUIT, MODE, 353/366 (handled above as numerics)
    // and every other protocol event are not messages.
  }

  /** Reply to one channel's message, one turn at most. */
  private async handlePrivmsg(nick: string, params: string[]): Promise<void> {
    const event: IrcInboundEvent = {
      channel: params[0] ?? "",
      nick,
      text: params[1] ?? "",
      messageId: this.nextMessageId(),
    };
    const normalisation = normaliseIrcMessage(event, {
      ownNick: this.confirmedNick,
      channels: this.options.channels,
    });
    if (normalisation.kind !== "message") {
      this.audit({
        kind: "filtered",
        reason: normalisation.reason,
        ...(normalisation.channelId ? { channelId: normalisation.channelId } : {}),
      });
      return;
    }
    await this.gate.ingest(normalisation.message, normalisation.key);
  }

  /**
   * The id for one received line.
   *
   * IRC has no message ids and no replay, so the only requirement is that two
   * different messages in one run never share a key, and that a restart cannot
   * reuse one the durable guard still remembers. A millisecond clock plus a
   * per-run sequence gives both without a second store.
   */
  private nextMessageId(): string {
    this.sequence += 1;
    return `irc-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
  }

  /** Deliver one reply over this connection, one chunk per line, in order. */
  async deliver(chatId: string, text: string): Promise<IngressDeliveryResult> {
    return createIrcSender({
      write: (line) => this.sendText(line),
      isOpen: () => this.hasConnection,
      ...(this.options.onChunk ? { onChunk: this.options.onChunk } : {}),
    }).send(chatId, text);
  }

  /** Act on one numeric reply. */
  private handleNumeric(command: string, params: string[]): void {
    if (command === "001") {
      const named = (params[0] ?? "").trim();
      if (named !== "") this.confirmedNick = named;
      this.markReady();
      this.clearRegistrationTimer();
      const pending = this.registration;
      this.registration = null;
      pending?.resolve();
      this.joinConfiguredChannels();
      return;
    }
    const refusal = REGISTRATION_REFUSALS[command];
    if (!refusal) return;
    // Only a refusal *before* registration is a registration failure; the same
    // numeric afterwards (a later 433 from a NICK change) is a protocol event.
    if (this.registration === null) return;
    this.failRegistration(`irc registration refused: ${refusal} (${command})`);
  }

  /** Join every configured channel, one JOIN per channel. */
  private joinConfiguredChannels(): void {
    for (const channel of this.options.channels) this.sendText(`JOIN ${channel}`);
  }

  /**
   * End the attempt with a refusal: audit it, reject `connect`, and close the
   * socket. Surfacing is the point — the reconnect loop will try again on the
   * shared backoff, but each attempt is a reported failure with a numeric rather
   * than a silent loop.
   */
  private failRegistration(error: string): void {
    this.refusal = error;
    this.clearRegistrationTimer();
    const pending = this.registration;
    this.registration = null;
    this.audit({ kind: "auth-failed", error });
    pending?.reject(new Error(error));
    this.finishClose(error);
  }

  private clearRegistrationTimer(): void {
    if (this.registrationTimer !== null) {
      this.timers.clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type IrcIngressAdapterOptions = {
  /** The validated server address. */
  endpoint: IrcSocketTarget;
  /** The nick to register. */
  nick: string;
  /** Every channel to join; `destination` is added when the caller supplies it. */
  channels: readonly string[];
  /** The optional server password, already resolved from the secret store. */
  password?: string;
  /** The restart-durable replay guard. */
  handled: { has(key: string): Promise<boolean>; record(key: string): Promise<void> };
  /** Where audit records go; absent means they are dropped. */
  audit?: IrcInboundAudit;
  /** The raw socket seam; defaults to TLS over the configured address. */
  connect?: IrcSocketFactory;
  /** How long an unanswered registration waits; defaults to 20s. */
  registrationTimeoutMs?: number;
  /** The timer surface, injectable so a suite needs no wall clock. */
  timers?: IrcTimers;
  /** Reports each reply chunk as it is written (see [`IrcSenderOptions`]). */
  onChunk?: (chunk: string) => void;
};

/**
 * The IRC ingress adapter: the platform's seams and nothing else.
 *
 * One client is built for the whole run and reused across reconnects, so the
 * server-confirmed nick survives a close and the next `connect` re-registers
 * under it. The adapter's `normalise` reads the client's nick, which is why a
 * server that changes the nick's casing on `001` still filters our own messages
 * correctly.
 */
export function createIrcIngressAdapter(
  options: IrcIngressAdapterOptions,
): SocketIngressAdapter {
  let client: IrcClient | null = null;
  const channels = [...options.channels];
  return {
    platform: "irc",
    kind: "socket",
    messageLimit: IRC_MESSAGE_LIMIT_BYTES,
    messageLimitUnit: "bytes",
    normalise: (raw) =>
      normaliseIrcMessage(raw, {
        ownNick: client?.nick ?? options.nick,
        channels,
      }),
    deliver: async (chatId, text) => {
      if (!client) return { ok: false, error: "the IRC client is not connected", sent: 0 };
      return client.deliver(chatId, text);
    },
    openClient: (onMessage) => {
      if (!client) client = new IrcClient({ ...options, channels, onMessage });
      return client;
    },
  };
}

/** How the production push transport reaches IRC. */
export type IrcInboundTransportOptions = {
  /** Everything the client needs except `onMessage`, which the transport binds. */
  client: Omit<IrcClientOptions, "onMessage">;
  /** The first reconnect delay; the loop doubles it per failure up to the cap. */
  reconnectDelayMs?: number;
  /** The most the loop waits between attempts. */
  maxReconnectDelayMs?: number;
  /** How the loop waits; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The production push transport, over the shared socket transport.
 *
 * No port is bound and no listener exists: the connection is one the Host
 * originates, like the Gateway and Socket Mode channels.
 */
export function createIrcInboundPushTransport(
  options: IrcInboundTransportOptions,
): MessagingInboundPushTransport {
  return createSocketIngressTransport(createIrcIngressAdapter(options.client), {
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxReconnectDelayMs !== undefined
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
