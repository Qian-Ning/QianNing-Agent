import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";

export {
  DISCORD_MESSAGE_LIMIT,
  chunkDiscordMessage,
  createDiscordSender,
  type DiscordFetch,
  type DiscordSendResult,
  type DiscordSender,
  type DiscordSenderOptions,
} from "./messaging-discord-send.js";

/**
 * The inbound Discord channel over the Gateway websocket, and the outbound send
 * path its replies use.
 *
 * Discord's incoming direction is a *push*: the platform delivers events to a
 * websocket the client opens. The connection is one the Host *originates* to
 * Discord, so no inbound port is bound and no public callback URL is needed —
 * exactly the acceptance precondition the Telegram long poll and Slack Socket
 * Mode keep (ADR 0326). There is no listener here.
 *
 * # What this module is
 *
 * It is the client half of the inbound path and the platform's send call:
 *
 * 1. `GET /gateway/bot` resolves the Gateway URL, then the websocket is opened
 *    and IDENTIFY (op 2) is sent with the bot token, the MESSAGE_CONTENT intent
 *    and the message intents;
 * 2. HELLO (op 10) supplies the heartbeat interval; a heartbeat (op 1) carries
 *    the last sequence number, and an unacknowledged heartbeat (no op 11) tears
 *    the socket down so the reconnect loop can resume;
 * 3. a close or a platform RECONNECT (op 7) reconnects with RESUME (op 6) using
 *    the session id and sequence the previous connection reached, so messages
 *    sent while the socket was down are replayed by Discord rather than lost;
 * 4. MESSAGE_CREATE events are normalised into the neutral [`InboundMessage`]
 *    shape, filtered against the bot's own id and bot-authored messages, and
 *    deduplicated by a restart-durable guard keyed on the channel and message
 *    id;
 * 5. replies are posted with `POST /channels/{id}/messages`, chunked at
 *    Discord's 2000-character limit, sequentially so order is preserved, and
 *    rate limits (HTTP 429 with `retry_after`) are waited out rather than
 *    hammered.
 *
 * The command vocabulary, the link, the principal and the four Host operations
 * are the existing driver's (`messaging-inbound.ts`); this module produces a
 * neutral message and hands it to that one routing path through a
 * [`MessagingInboundPushTransport`]. It performs no mapping, no admission and
 * no permission policy of its own.
 *
 * # Trust boundary and the credential
 *
 * The bot token is a bearer credential for the Gateway handshake and the send
 * API. It travels in the IDENTIFY frame and in the `Authorization` header —
 * the platform's own locations — and it is never placed in a URL, a log line,
 * an audit entry or an error this module reports. Everything arriving over the
 * socket is untrusted and is validated field by field before it reaches the
 * driver.
 *
 * # Testability without a network
 *
 * The two network seams — the `/gateway/bot` lookup and the websocket client —
 * are injected ([`DiscordGatewayLookup`], [`DiscordSocketFactory`]), and the
 * send path takes a [`DiscordFetch`]. A suite drives the client frame by frame
 * with fakes, so identify, heartbeat, resume, filtering and chunking are all
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

/** The answer to the Gateway lookup: the WSS URL, or the platform's refusal. */
export type DiscordGatewayResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** The `/gateway/bot` lookup, injected so a suite needs no network. */
export type DiscordGatewayLookup = (token: string) => Promise<DiscordGatewayResult>;

/** The minimal websocket surface this module uses. */
export interface DiscordSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

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

/** The replay guard's key: the channel and the message id. */
export function discordHandledKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

/**
 * The Gateway client: handshake, heartbeat, resume, dispatch filtering, and the
 * durable guard.
 *
 * The client is reused across reconnects by the transport below, so `sessionId`
 * and `sequence` survive a socket close: the next `connect` sends RESUME rather
 * than IDENTIFY, which is what keeps a gateway outage from losing messages. An
 * `INVALID_SESSION` with `d: false` clears both, so the following connect
 * identifies afresh.
 */
export class DiscordGatewayClient {
  private readonly options: DiscordGatewayClientOptions;
  private readonly audit: DiscordInboundAudit;
  private readonly timers: DiscordTimers;
  private socket: DiscordSocket | null = null;
  private sessionId: string | null = null;
  private sequence: number | null = null;
  private botUserId: string | null = null;
  private ready = false;
  private closed = true;
  private heartbeatHandle: unknown = null;
  private awaitingAck = false;
  private closeWaiters: Array<() => void> = [];

  constructor(options: DiscordGatewayClientOptions) {
    this.options = options;
    this.audit = options.audit ?? (() => {});
    this.timers = options.timers ?? {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  /** Whether a READY or RESUMED frame has been seen on the current connection. */
  get isReady(): boolean {
    return this.ready;
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
    const socket = this.options.connect(gateway.url);
    this.closed = false;
    this.ready = false;
    this.awaitingAck = false;
    this.socket = socket;
    socket.onMessage((data) => {
      void this.handleFrame(data);
    });
    socket.onClose((code, reason) => {
      this.finishClose(reason ?? (code !== undefined ? `closed (${code})` : "closed"));
    });
    socket.onError((error) => {
      this.audit({ kind: "connect-failed", error: errorMessage(error) });
      // An `error` is normally followed by `close`; if not, the wait must end
      // anyway or the loop would sit in `waitForClose` until abort.
      this.finishClose(errorMessage(error));
    });
  }

  /** Resolves once the current socket closes, or `signal` aborts. */
  waitForClose(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.socket === null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.closeWaiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Close the socket but keep the session, so the next connect resumes. */
  close(): void {
    this.finishClose("closed by the caller");
  }

  private finishClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.stopHeartbeat();
    this.audit({ kind: "disconnect", reason });
    try {
      this.socket?.close();
    } catch {
      // A socket that throws on close is already gone.
    }
    this.socket = null;
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Route one raw gateway frame by opcode. */
  async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed-frame", reason: "frame is not JSON" });
      return;
    }
    if (!isRecord(parsed)) {
      this.audit({ kind: "malformed-frame", reason: "frame is not an object" });
      return;
    }
    const op = typeof parsed.op === "number" ? parsed.op : null;
    if (op === null) {
      this.audit({ kind: "malformed-frame", reason: "frame names no opcode" });
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
      this.ready = true;
      return;
    }
    if (type === "RESUMED") {
      this.ready = true;
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
    if (this.socket === null) return;
    this.awaitingAck = true;
    this.send({ op: OP_HEARTBEAT, d: this.sequence });
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // The socket is gone; the close handler drives the reconnect.
    }
  }

  /**
   * One MESSAGE_CREATE: filter, consult the durable guard, handle, then record.
   * The record comes after handling so a handler failure leaves the message
   * unrecorded and a Discord replay is applied rather than lost — at-least-once
   * with dedupe, never at-most-once with loss.
   */
  private async handleMessageCreate(payload: unknown): Promise<void> {
    const classification = classifyDiscordMessage(payload, this.botUserId);
    if (!classification.accepted) {
      const channelId = isRecord(payload) && typeof payload.channel_id === "string"
        ? payload.channel_id
        : undefined;
      this.audit({ kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) });
      return;
    }
    const { message } = classification;
    const key = discordHandledKey(message.chatId, message.messageId);
    let alreadyHandled: boolean;
    try {
      alreadyHandled = await this.options.handled.has(key);
    } catch {
      alreadyHandled = false;
    }
    if (alreadyHandled) {
      this.audit({ kind: "duplicate", messageId: message.messageId });
      return;
    }
    try {
      await this.options.onMessage(message);
    } catch (error) {
      this.audit({ kind: "process-failed", messageId: message.messageId, error: errorMessage(error) });
      return;
    }
    try {
      await this.options.handled.record(key);
    } catch (error) {
      this.audit({ kind: "record-failed", messageId: message.messageId, error: errorMessage(error) });
      return;
    }
    this.audit({ kind: "processed", messageId: message.messageId });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * The reconnect delay after `attempt` consecutive failures: exponential from
 * `baseMs`, capped, with equal jitter. The sequence is non-decreasing, so a
 * retry is never shorter than the one before it, which keeps a fleet from
 * hammering a down gateway in lockstep.
 */
export function discordReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = exponential / 2;
  return Math.round(half + half * Math.random());
}

/**
 * The production push transport.
 *
 * One client is built for the whole run and reused across reconnects, so its
 * session id and sequence survive a close and the next connection resumes. That
 * is also why a reconnect creates no second subscription: the client keeps one
 * `onMessage` handler and one socket at a time, and the driver above sees each
 * message exactly once (the durable guard also filters a replay).
 */
export function createDiscordInboundPushTransport(
  options: DiscordInboundTransportOptions,
): MessagingInboundPushTransport {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = Math.max(MIN_RECONNECT_DELAY_MS, options.reconnectDelayMs ?? MIN_RECONNECT_DELAY_MS);
  const max = Math.max(base, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  return {
    async start(onMessage, signal) {
      const client = new DiscordGatewayClient({ ...options.client, onMessage });
      let failures = 0;
      while (!signal?.aborted) {
        let established = false;
        try {
          await client.connect();
          established = true;
          await client.waitForClose(signal);
        } catch {
          // A refused lookup or a failed connect: fall through to the wait.
          // The client already audited the reason.
        } finally {
          client.close();
        }
        if (signal?.aborted) break;
        // A connection that reached the gateway resets the backoff, so a
        // healthy channel reconnects at the base delay.
        if (established) failures = 0;
        await wait(discordReconnectDelayMs(failures, base, max));
        if (!established) failures += 1;
      }
    },
  };
}
