import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressMessageKey,
  ingressReconnectDelayMs,
  type IngressAudit,
  type IngressDeliveryResult,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import { createSocketIngressTransport, SocketIngressClient } from "./messaging-ingress-socket.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";

export {
  DISCORD_MESSAGE_LIMIT,
  chunkDiscordMessage,
  createDiscordSender,
  type DiscordFetch,
  type DiscordSendResult,
  type DiscordSender,
  type DiscordSenderOptions,
} from "./messaging-discord-send.js";
import { DISCORD_MESSAGE_LIMIT } from "./messaging-discord-send.js";

/**
 * The inbound Discord channel over the Gateway websocket — the adapter half.
 *
 * Discord's incoming direction is a *push*: the platform delivers events to a
 * websocket the Host opens, so no inbound port is bound and no public callback
 * URL is needed — the acceptance precondition the Telegram long poll and Slack
 * Socket Mode keep (ADR 0326). There is no listener here.
 *
 * Everything a socket channel shares with its siblings is the shared layer's:
 * the connection lifecycle and the reconnect discipline
 * (`messaging-ingress-socket.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is Discord's own:
 *
 * - **connect** — `GET /gateway/bot` resolves the Gateway URL, the websocket is
 *   opened, and HELLO (op 10) is answered with IDENTIFY (op 2) or RESUME (op 6);
 * - **normalise** — [`normaliseDiscordMessage`]: one MESSAGE_CREATE payload,
 *   filtered against bot authors and the client's own user id and against the
 *   system message types, projected onto the shared shape, keyed on the channel
 *   and message id;
 * - **deliver** — `POST /channels/{id}/messages`, chunked by the shared chunker
 *   at Discord's 2000-character limit and posted sequentially so order is
 *   preserved (declared here where a sender is supplied);
 * - **limit** — [`DISCORD_MESSAGE_LIMIT`].
 *
 * Heartbeat, resume and the invalid-session rule are Discord's own protocol and
 * stay here; they are the reason `handleFrame` is this module's and not the
 * shared layer's.
 *
 * # Trust boundary and the credential
 *
 * The bot token is a bearer credential for the Gateway handshake and the send
 * API. It travels in the IDENTIFY frame and in the `Authorization` header — the
 * platform's own locations — and it is never placed in a URL, a log line, an
 * audit entry or an error this module reports. Everything arriving over the
 * socket is untrusted and is validated field by field before it reaches the
 * driver.
 *
 * # Testability without a network
 *
 * The two network seams — the `/gateway/bot` lookup and the websocket client —
 * are injected ([`DiscordGatewayLookup`], [`DiscordSocketFactory`]), and the send
 * path takes a [`DiscordFetch`]. A suite drives the client frame by frame with
 * fakes, so identify, heartbeat, resume, filtering and chunking are all
 * reproducible with no socket and no Discord account.
 */

/** The settings section the Discord channel's record lives in, inside `app`. */
export const MESSAGING_DISCORD_SECTION = "messagingDiscord";
/** The record's self-identifying format. */
export const MESSAGING_DISCORD_FORMAT = "pi-desktop-messaging-discord";
/** The record version this build reads. */
export const MESSAGING_DISCORD_FORMAT_VERSION = 1;
/** Where the bot token lives in the host's secret store. */
export const MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF = "secret:messaging-discord:bot-token";
/** The platform's own API base; the Gateway lookup is appended to it. */
export const DISCORD_DEFAULT_ENDPOINT = "https://discord.com/api/v10";

/**
 * The Gateway intents this client asks for:
 * GUILDS (1 << 0), GUILD_MESSAGES (1 << 9), DIRECT_MESSAGES (1 << 12) and
 * MESSAGE_CONTENT (1 << 15). The last one is privileged and must also be
 * enabled for the bot in the Discord developer portal; without it a message
 * arrives with empty content, which this module treats as a filtered message
 * rather than acting on an empty command.
 */
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** The most message keys the settings-backed replay guard remembers. */
export const DISCORD_HANDLED_CAPACITY = 2048;

/** The Gateway opcodes this client reads or sends. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings surface the durable replay guard rides. */
export type DiscordSettingsSurface = {
  read(): Promise<unknown>;
  write(patch: Record<string, unknown>): Promise<void>;
};

/**
 * The restart-durable replay guard. Discord keeps a message id stable, so a
 * replayed MESSAGE_CREATE after a RESUME is recognised; the key carries the
 * channel because an id is only unique within one.
 */
export interface DiscordInboundHandledStore {
  has(key: string): Promise<boolean>;
  record(key: string): Promise<void>;
}

/** One audit record. Structure and ids only — never message text or a token. */
export type DiscordInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "heartbeat-missed" }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed-frame"; reason: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "processed"; messageId: string }
  | { kind: "process-failed"; messageId: string; error: string }
  | { kind: "record-failed"; messageId: string; error: string }
  | { kind: "send-failed"; channelId: string; error: string };

export type DiscordInboundAudit = (entry: DiscordInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in Discord's published entry type: the
 * id field here is `messageId`, and a malformed frame is `malformed-frame`.
 * `heartbeat-missed` is emitted by this client alone and does not travel through
 * the shared vocabulary.
 */
function discordAudit(sink?: DiscordInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "malformed":
        return sink({ kind: "malformed-frame", reason: entry.reason });
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
      case "heartbeat-missed":
        return sink({ kind: "heartbeat-missed" });
      case "filtered":
        return sink({
          kind: "filtered",
          reason: entry.reason,
          ...(entry.channelId ? { channelId: entry.channelId } : {}),
        });
      default:
        // `identity-failed` belongs to Mattermost.
        return;
    }
  };
}

/** The answer to the Gateway lookup: the WSS URL, or the platform's refusal. */
export type DiscordGatewayResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** The `/gateway/bot` lookup, injected so a suite needs no network. */
export type DiscordGatewayLookup = (token: string) => Promise<DiscordGatewayResult>;

/** The minimal websocket surface this module uses. */
export type DiscordSocket = IngressSocket;

/** Opens a websocket to a URL; injected so a suite needs no socket. */
export type DiscordSocketFactory = (url: string) => DiscordSocket;

/** The timer surface, injectable so a heartbeat test needs no wall clock. */
export type DiscordTimers = {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type DiscordGatewayClientOptions = {
  /** The bot token; used in IDENTIFY/RESUME and nowhere else. */
  token: string;
  /** The `/gateway/bot` seam. */
  resolveGateway: DiscordGatewayLookup;
  /** The websocket client seam. */
  connect: DiscordSocketFactory;
  /** The restart-durable replay guard. */
  handled: DiscordInboundHandledStore;
  /** The neutral handler the driver's routing path provides. */
  onMessage: (message: InboundMessage) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: DiscordInboundAudit;
  /** The heartbeat timer; defaults to the runtime's `setInterval`. */
  timers?: DiscordTimers;
};

/**
 * Classify one MESSAGE_CREATE payload into the neutral message shape.
 *
 * Refused: a payload that is not an object; an author that is a bot or the
 * client's own user id; a non-default message type (a system message such as a
 * member join has no command in it); and a message with no channel, id, or
 * text. The channel id is the reply destination: in a thread it is the
 * thread's own channel id, so a reply goes back to the thread.
 */
export function classifyDiscordMessage(
  payload: unknown,
  botUserId: string | null,
): { accepted: true; message: InboundMessage } | { accepted: false; reason: string } {
  if (!isRecord(payload)) return { accepted: false, reason: "message is not an object" };
  const author = isRecord(payload.author) ? payload.author : null;
  if (!author) return { accepted: false, reason: "message has no author" };
  if (author.bot === true) return { accepted: false, reason: "message is from a bot" };
  const authorId = typeof author.id === "string" ? author.id.trim() : "";
  if (botUserId !== null && authorId === botUserId) {
    return { accepted: false, reason: "message is the client's own" };
  }
  // Type 0 is the plain user message; every other type is a system event.
  if (payload.type !== undefined && payload.type !== 0) {
    return { accepted: false, reason: "message is a system event" };
  }
  const chatId = typeof payload.channel_id === "string" ? payload.channel_id.trim() : "";
  if (!chatId) return { accepted: false, reason: "message names no channel" };
  const messageId = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!messageId) return { accepted: false, reason: "message names no id" };
  const text = typeof payload.content === "string" ? payload.content : "";
  if (!text.trim()) return { accepted: false, reason: "message carries no text" };
  return { accepted: true, message: { messageId, chatId, text } };
}

/** The replay guard's key: the conversation and the message id. */
export function discordHandledKey(chatId: string, messageId: string): string {
  return ingressMessageKey(chatId, messageId);
}

/**
 * Project one MESSAGE_CREATE payload onto the shared shape, keyed on the channel
 * and message id — an id is unique only within a channel, so the channel is part
 * of the replay key.
 */
export function normaliseDiscordMessage(
  payload: unknown,
  botUserId: string | null,
): IngressNormalisation {
  const classification = classifyDiscordMessage(payload, botUserId);
  if (!classification.accepted) {
    const channelId = isRecord(payload) && typeof payload.channel_id === "string"
      ? payload.channel_id
      : undefined;
    return { kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) };
  }
  const { message } = classification;
  return {
    kind: "message",
    message,
    key: discordHandledKey(message.chatId, message.messageId),
  };
}

/**
 * The Gateway client: handshake, heartbeat, resume, dispatch filtering, and the
 * shared dedupe gate.
 *
 * The connection lifecycle and the reconnect policy are the shared socket
 * layer's. This class is Discord's protocol: opcodes, the heartbeat that tears a
 * zombie connection down, and the session id and sequence that make the next
 * connection a RESUME rather than a fresh IDENTIFY.
 *
 * The client is reused across reconnects by the transport, so `sessionId` and
 * `sequence` survive a socket close. An `INVALID_SESSION` with `d: false` clears
 * both, so the following connect identifies afresh.
 */
export class DiscordGatewayClient extends SocketIngressClient {
  private readonly options: DiscordGatewayClientOptions;
  private readonly timers: DiscordTimers;
  private readonly gate: IngressGate;
  private sessionId: string | null = null;
  private sequence: number | null = null;
  private botUserId: string | null = null;
  private heartbeatHandle: unknown = null;
  private awaitingAck = false;

  constructor(options: DiscordGatewayClientOptions) {
    const audit = discordAudit(options.audit);
    super({ audit });
    this.options = options;
    this.gate = new IngressGate({ handled: options.handled, onMessage: options.onMessage, audit });
    this.timers = options.timers ?? {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  /** The bot's own user id, once READY has named it. */
  get userId(): string | null {
    return this.botUserId;
  }

  /** The sequence number the resume frame carries. */
  get lastSequence(): number | null {
    return this.sequence;
  }

  /** Whether the next connection will resume rather than identify. */
  get hasSession(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Open a connection: resolve the Gateway URL, open the socket, and wait for
   * HELLO to send IDENTIFY or RESUME. A refused lookup is audited and thrown so
   * the reconnect loop owns the retry; no socket is opened in that case.
   */
  async connect(): Promise<void> {
    const token = this.options.token.trim();
    if (!token) {
      const error = "the configured bot token is empty";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    const gateway = await this.options.resolveGateway(token);
    if (!gateway.ok) {
      this.audit({ kind: "auth-failed", error: gateway.error });
      throw new Error(`discord gateway lookup refused: ${gateway.error}`);
    }
    this.awaitingAck = false;
    this.attach(this.options.connect(gateway.url));
  }

  /** Stop the heartbeat with the connection that owned it. */
  protected onDisconnect(): void {
    this.stopHeartbeat();
  }

  /** Route one raw gateway frame by opcode. */
  async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed", reason: "frame is not JSON" });
      return;
    }
    if (!isRecord(parsed)) {
      this.audit({ kind: "malformed", reason: "frame is not an object" });
      return;
    }
    const op = typeof parsed.op === "number" ? parsed.op : null;
    if (op === null) {
      this.audit({ kind: "malformed", reason: "frame names no opcode" });
      return;
    }
    if (typeof parsed.s === "number") this.sequence = parsed.s;

    if (op === OP_HELLO) {
      const interval = isRecord(parsed.d) && typeof parsed.d.heartbeat_interval === "number"
        ? parsed.d.heartbeat_interval
        : 0;
      this.startHeartbeat(interval);
      this.sendSessionFrame();
      return;
    }
    if (op === OP_HEARTBEAT_ACK) {
      this.awaitingAck = false;
      return;
    }
    if (op === OP_HEARTBEAT) {
      this.sendHeartbeat();
      return;
    }
    if (op === OP_RECONNECT) {
      this.finishClose("the platform asked to reconnect");
      return;
    }
    if (op === OP_INVALID_SESSION) {
      // `d: true` means the session is resumable after a short wait; `false`
      // means it is gone and the next connection must identify.
      if (parsed.d !== true) {
        this.sessionId = null;
        this.sequence = null;
        this.botUserId = null;
      }
      this.finishClose("the session was invalidated");
      return;
    }
    if (op !== OP_DISPATCH) return;

    const type = typeof parsed.t === "string" ? parsed.t : "";
    if (type === "READY") {
      const data = isRecord(parsed.d) ? parsed.d : {};
      this.sessionId = typeof data.session_id === "string" ? data.session_id : this.sessionId;
      const user = isRecord(data.user) ? data.user : null;
      if (user && typeof user.id === "string") this.botUserId = user.id;
      this.markReady();
      return;
    }
    if (type === "RESUMED") {
      this.markReady();
      return;
    }
    if (type === "MESSAGE_CREATE") {
      await this.handleMessageCreate(parsed.d);
    }
  }

  /** Send IDENTIFY, or RESUME when a previous session is still resumable. */
  private sendSessionFrame(): void {
    if (this.sessionId !== null) {
      this.send({
        op: OP_RESUME,
        d: {
          token: this.options.token.trim(),
          session_id: this.sessionId,
          seq: this.sequence,
        },
      });
      return;
    }
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.options.token.trim(),
        intents: DISCORD_GATEWAY_INTENTS,
        properties: { os: process.platform, browser: "pi-desktop", device: "pi-desktop" },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.heartbeatHandle = this.timers.setInterval(() => {
      if (this.awaitingAck) {
        // The previous heartbeat was never acknowledged: the connection is a
        // zombie, so end it and let the reconnect loop resume.
        this.audit({ kind: "heartbeat-missed" });
        this.finishClose("the heartbeat was not acknowledged");
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.timers.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    this.awaitingAck = false;
  }

  private sendHeartbeat(): void {
    if (!this.hasConnection) return;
    this.awaitingAck = true;
    this.send({ op: OP_HEARTBEAT, d: this.sequence });
  }

  /**
   * One MESSAGE_CREATE: filter, then the shared gate — consult the durable
   * guard, handle, record. The record comes after handling so a handler failure
   * leaves the message unrecorded and a Discord replay is applied rather than
   * lost: at-least-once with dedupe, never at-most-once with loss.
   */
  private async handleMessageCreate(payload: unknown): Promise<void> {
    const normalisation = normaliseDiscordMessage(payload, this.botUserId);
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
}

/** How the production push transport reaches Discord. */
export type DiscordInboundTransportOptions = {
  /** Everything the client needs except `onMessage`, which the transport binds. */
  client: Omit<DiscordGatewayClientOptions, "onMessage">;
  /** The first reconnect delay; the loop doubles it per failure up to the cap. */
  reconnectDelayMs?: number;
  /** The most the loop waits between attempts. */
  maxReconnectDelayMs?: number;
  /** How the loop waits; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The reconnect delay after `attempt` consecutive failures: the shared jittered,
 * capped exponential ([`ingressReconnectDelayMs`]).
 */
export function discordReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return ingressReconnectDelayMs(attempt, baseMs, maxMs);
}

/** What the adapter needs beyond the client's own options. */
export type DiscordIngressAdapterOptions = Omit<DiscordGatewayClientOptions, "onMessage"> & {
  /** The bot's own user id, when it is already known. */
  ownUserId?: string;
  /** The reply path, when one is supplied; the shared chunker calls it per chunk. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The Discord ingress adapter: the platform-specific seams and nothing else.
 *
 * One client is built for the whole run and reused across reconnects, so its
 * session id and sequence survive a close and the next connection resumes. That
 * is also why a reconnect creates no second subscription: the client keeps one
 * `onMessage` handler and one socket at a time, and the driver above sees each
 * message exactly once (the gate's durable guard also filters a replay).
 */
export function createDiscordIngressAdapter(
  options: DiscordIngressAdapterOptions,
): SocketIngressAdapter {
  let client: DiscordGatewayClient | null = null;
  return {
    platform: "discord",
    kind: "socket",
    messageLimit: DISCORD_MESSAGE_LIMIT,
    normalise: (raw) => normaliseDiscordMessage(raw, client?.userId ?? options.ownUserId ?? null),
    ...(options.deliver ? { deliver: options.deliver } : {}),
    openClient: (onMessage) => {
      if (!client) {
        const { deliver: _deliver, ownUserId: _ownUserId, ...clientOptions } = options;
        client = new DiscordGatewayClient({ ...clientOptions, onMessage });
      }
      return client;
    },
  };
}

/** The production push transport, over the shared socket transport. */
export function createDiscordInboundPushTransport(
  options: DiscordInboundTransportOptions,
): MessagingInboundPushTransport {
  return createSocketIngressTransport(createDiscordIngressAdapter(options.client), {
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxReconnectDelayMs !== undefined
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
