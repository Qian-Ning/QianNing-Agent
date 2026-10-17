import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";

export {
  MATTERMOST_POST_LIMIT,
  chunkMattermostPost,
  createMattermostSender,
  type MattermostFetch,
  type MattermostSendResult,
  type MattermostSendTarget,
  type MattermostSender,
  type MattermostSenderOptions,
} from "./messaging-mattermost-send.js";

/**
 * The inbound Mattermost channel over its websocket, and the REST send path its
 * replies use.
 *
 * Mattermost's incoming direction is a *push*: the server delivers events to a
 * websocket at `/api/v4/websocket`, which the Host *originates*. No inbound
 * port is bound and no public callback URL is needed, so the acceptance
 * precondition the other channels keep (ADR 0326) stays true. There is no
 * listener here.
 *
 * # What this module is
 *
 * 1. `GET /api/v4/users/me` resolves the bot's own user id, then the websocket
 *    is opened and `authentication_challenge` is sent with the access token —
 *    Mattermost's own handshake, not a header;
 * 2. a `status` frame with `OK` confirms the token; a refusal is audited and the
 *    socket is closed so the reconnect loop owns the retry;
 * 3. `posted` events are unwrapped (the payload arrives as a JSON string or,
 *    on newer servers, an object), filtered against the bot's own user id and
 *    non-empty system post types, and normalised into the neutral
 *    [`InboundMessage`] shape;
 * 4. a restart-durable guard keyed on the post id deduplicates a redelivery;
 * 5. replies are posted with `POST /api/v4/posts`, chunked at Mattermost's
 *    16383-character limit, sequentially so order is preserved, with `root_id`
 *    carrying a thread so a reply lands in the thread it came from.
 *
 * The command vocabulary, the link, the principal and the four Host operations
 * are the existing driver's (`messaging-inbound.ts`); this module produces a
 * neutral message and hands it to that one routing path through a
 * [`MessagingInboundPushTransport`]. It performs no mapping, no admission and
 * no permission policy of its own.
 *
 * # Trust boundary and the credential
 *
 * The access token is a bearer credential for the REST call and the websocket
 * handshake. It travels in the `Authorization` header and in the
 * `authentication_challenge` frame — the platform's own locations — never in a
 * URL, a log line, an audit entry or an error this module reports. Everything
 * arriving over the socket is untrusted and is validated field by field.
 *
 * # Testability without a network
 *
 * The identity lookup and the websocket client are injected
 * ([`MattermostIdentityLookup`], [`MattermostSocketFactory`]), and the send path
 * takes a [`MattermostFetch`]. A suite drives the client frame by frame with
 * fakes, so the handshake, filtering, thread handling and chunking are all
 * reproducible with no server.
 */

/** The settings section the Mattermost channel's record lives in. */
export const MESSAGING_MATTERMOST_SECTION = "messagingMattermost";
/** The record's self-identifying format. */
export const MESSAGING_MATTERMOST_FORMAT = "pi-desktop-messaging-mattermost";
/** The record version this build reads. */
export const MESSAGING_MATTERMOST_FORMAT_VERSION = 1;
/** Where the access token lives in the host's secret store. */
export const MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF = "secret:messaging-mattermost:access-token";

/** The most post ids the settings-backed replay guard remembers. */
export const MATTERMOST_HANDLED_CAPACITY = 2048;

/** The websocket path, appended to the configured base URL. */
export const MATTERMOST_WEBSOCKET_PATH = "/api/v4/websocket";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings surface the durable replay guard rides. */
export type MattermostSettingsSurface = {
  read(): Promise<unknown>;
  write(patch: Record<string, unknown>): Promise<void>;
};

/** The restart-durable replay guard, keyed on the post id. */
export interface MattermostInboundHandledStore {
  has(postId: string): Promise<boolean>;
  record(postId: string): Promise<void>;
}

/** One audit record. Structure and ids only — never message text or a token. */
export type MattermostInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "identity-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed-event"; reason: string }
  | { kind: "duplicate"; postId: string }
  | { kind: "processed"; postId: string }
  | { kind: "process-failed"; postId: string; error: string }
  | { kind: "record-failed"; postId: string; error: string };

export type MattermostInboundAudit = (entry: MattermostInboundAuditEntry) => void;

/** The bot's own identity, resolved once per connection. */
export type MattermostIdentityResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/** `GET /users/me`, injected so a suite needs no server. */
export type MattermostIdentityLookup = (token: string) => Promise<MattermostIdentityResult>;

/** The minimal websocket surface this module uses. */
export interface MattermostSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** Opens a websocket to a URL; injected so a suite needs no socket. */
export type MattermostSocketFactory = (url: string) => MattermostSocket;

/**
 * The websocket address for a configured base URL, or the reason it is refused.
 *
 * The endpoint rule is the shared inbound one (HTTPS, or plaintext only for a
 * loopback/`.local`/private-LAN host under the relaxed policy), applied before
 * the path is appended. `http` becomes `ws` and `https` becomes `wss`; the
 * credential is never part of this URL — the handshake frame carries it.
 */
export function mattermostWebSocketUrl(
  endpoint: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; url: string } | { ok: false; error: string } {
  const checked = validateInboundEndpoint(endpoint, options);
  if (!checked.ok) return checked;
  const url = checked.url;
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url: `${base}${MATTERMOST_WEBSOCKET_PATH}` };
}

/**
 * Classify one `posted` event into the neutral message shape.
 *
 * Refused: a payload that is not an object; a post whose `user_id` is the
 * client's own (Mattermost broadcasts a bot's own posts back to it); a post
 * with a non-empty `type` (a system post such as a channel join); and a post
 * with no id, channel, or text. The channel id is the reply destination; the
 * `root_id`, when present, is the thread a reply belongs in and is carried by
 * the send path, not by this shape — which stays the same shape Slack
 * produces.
 */
export function classifyMattermostPost(
  payload: unknown,
  botUserId: string | null,
): { accepted: true; message: InboundMessage } | { accepted: false; reason: string } {
  if (!isRecord(payload)) return { accepted: false, reason: "post is not an object" };
  const userId = typeof payload.user_id === "string" ? payload.user_id.trim() : "";
  if (botUserId !== null && userId === botUserId) {
    return { accepted: false, reason: "post is the client's own" };
  }
  if (typeof payload.type === "string" && payload.type !== "") {
    return { accepted: false, reason: "post is a system event" };
  }
  const chatId = typeof payload.channel_id === "string" ? payload.channel_id.trim() : "";
  if (!chatId) return { accepted: false, reason: "post names no channel" };
  const messageId = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!messageId) return { accepted: false, reason: "post names no id" };
  const text = typeof payload.message === "string" ? payload.message : "";
  if (!text.trim()) return { accepted: false, reason: "post carries no text" };
  return { accepted: true, message: { messageId, chatId, text } };
}

export type MattermostSocketClientOptions = {
  token: string;
  /** The `GET /users/me` seam, run once per connection. */
  resolveIdentity: MattermostIdentityLookup;
  /** The websocket client seam. */
  connect: MattermostSocketFactory;
  /** The restart-durable replay guard. */
  handled: MattermostInboundHandledStore;
  onMessage: (message: InboundMessage) => Promise<void>;
  /** The websocket address, already validated by the wiring. */
  url: string;
  audit?: MattermostInboundAudit;
};

/**
 * The websocket client: handshake, `posted` events, strict filters, and the
 * durable guard.
 *
 * Mattermost has no resume: a fresh connection receives only what happens after
 * it authenticates, so a reconnect cannot duplicate a subscription. The
 * durable guard still covers a redelivery the server makes within a connection
 * and across a restart, keyed on the post id.
 */
export class MattermostSocketClient {
  private readonly options: MattermostSocketClientOptions;
  private readonly audit: MattermostInboundAudit;
  private socket: MattermostSocket | null = null;
  private botUserId: string | null = null;
  private ready = false;
  private closed = true;
  private closeWaiters: Array<() => void> = [];

  constructor(options: MattermostSocketClientOptions) {
    this.options = options;
    this.audit = options.audit ?? (() => {});
  }

  get isReady(): boolean {
    return this.ready;
  }

  async connect(): Promise<void> {
    const token = this.options.token.trim();
    if (!token) {
      const error = "the configured access token is empty";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    const identity = await this.options.resolveIdentity(token);
    if (!identity.ok) {
      this.audit({ kind: "identity-failed", error: identity.error });
      throw new Error(`mattermost identity lookup refused: ${identity.error}`);
    }
    this.botUserId = identity.userId;
    const socket = this.options.connect(this.options.url);
    this.closed = false;
    this.ready = false;
    this.socket = socket;
    socket.onMessage((data) => {
      void this.handleFrame(data);
    });
    socket.onClose((code, reason) => {
      this.finishClose(reason ?? (code !== undefined ? `closed (${code})` : "closed"));
    });
    socket.onError((error) => {
      this.audit({ kind: "connect-failed", error: errorMessage(error) });
      this.finishClose(errorMessage(error));
    });
    // Mattermost's own handshake: the token travels in the frame, not a header
    // and not the URL.
    socket.send(
      JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } }),
    );
  }

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

  close(): void {
    this.finishClose("closed by the caller");
  }

  private finishClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
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

  /** Route one raw socket frame: the auth answer, `hello`, or a `posted` event. */
  async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed-event", reason: "frame is not JSON" });
      return;
    }
    if (!isRecord(parsed)) {
      this.audit({ kind: "malformed-event", reason: "frame is not an object" });
      return;
    }
    // The handshake answer is a bare `{status, seq_reply}` frame.
    if (typeof parsed.status === "string" && typeof parsed.seq_reply === "number") {
      if (parsed.status !== "OK") {
        this.audit({ kind: "auth-failed", error: `the handshake was refused (${parsed.status})` });
        this.finishClose("the handshake was refused");
        return;
      }
      this.ready = true;
      return;
    }
    const event = typeof parsed.event === "string" ? parsed.event : "";
    if (event === "hello") {
      this.ready = true;
      return;
    }
    if (event === "posted") {
      await this.handlePosted(parsed);
    }
  }

  private async handlePosted(frame: Record<string, unknown>): Promise<void> {
    const data = isRecord(frame.data) ? frame.data : null;
    if (!data) {
      this.audit({ kind: "malformed-event", reason: "posted event has no data" });
      return;
    }
    const post = parsePost(data.post);
    if (!post.ok) {
      this.audit({ kind: "malformed-event", reason: post.reason });
      return;
    }
    const classification = classifyMattermostPost(post.value, this.botUserId);
    if (!classification.accepted) {
      const channelId = typeof post.value.channel_id === "string" ? post.value.channel_id : undefined;
      this.audit({ kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) });
      return;
    }
    const { message } = classification;
    let alreadyHandled: boolean;
    try {
      alreadyHandled = await this.options.handled.has(message.messageId);
    } catch {
      alreadyHandled = false;
    }
    if (alreadyHandled) {
      this.audit({ kind: "duplicate", postId: message.messageId });
      return;
    }
    try {
      await this.options.onMessage(message);
    } catch (error) {
      this.audit({ kind: "process-failed", postId: message.messageId, error: errorMessage(error) });
      return;
    }
    try {
      await this.options.handled.record(message.messageId);
    } catch (error) {
      this.audit({ kind: "record-failed", postId: message.messageId, error: errorMessage(error) });
      return;
    }
    this.audit({ kind: "processed", postId: message.messageId });
  }
}

/** A post arrives as a JSON string (documented) or an object (newer servers). */
function parsePost(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (isRecord(raw)) return { ok: true, value: raw };
  if (typeof raw !== "string") return { ok: false, reason: "post is neither a string nor an object" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, reason: "post string is not an object" };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: "post string is not JSON" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MattermostInboundTransportOptions = {
  client: Omit<MattermostSocketClientOptions, "onMessage">;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** The reconnect delay: exponential from `baseMs`, capped, with equal jitter. */
export function mattermostReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = exponential / 2;
  return Math.round(half + half * Math.random());
}

/**
 * The production push transport: it opens a websocket, authenticates, serves
 * `posted` events through [`MattermostSocketClient`], and reconnects until
 * `signal` aborts. A refused identity or handshake leaves the loop to wait and
 * retry, so an unreachable server can neither take the Host down nor spin it.
 */
export function createMattermostInboundPushTransport(
  options: MattermostInboundTransportOptions,
): MessagingInboundPushTransport {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = Math.max(MIN_RECONNECT_DELAY_MS, options.reconnectDelayMs ?? MIN_RECONNECT_DELAY_MS);
  const max = Math.max(base, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  return {
    async start(onMessage, signal) {
      let failures = 0;
      while (!signal?.aborted) {
        const client = new MattermostSocketClient({ ...options.client, onMessage });
        let established = false;
        try {
          await client.connect();
          established = true;
          await client.waitForClose(signal);
        } catch {
          // The client audited the reason; the wait below is the retry.
        } finally {
          client.close();
        }
        if (signal?.aborted) break;
        if (established) failures = 0;
        await wait(mattermostReconnectDelayMs(failures, base, max));
        if (!established) failures += 1;
      }
    },
  };
}
