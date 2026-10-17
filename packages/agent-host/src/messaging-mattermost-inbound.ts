import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressReconnectDelayMs,
  type IngressAudit,
  type IngressDeliveryResult,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import { createSocketIngressTransport, SocketIngressClient } from "./messaging-ingress-socket.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";

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
import { MATTERMOST_POST_LIMIT } from "./messaging-mattermost-send.js";

/**
 * The inbound Mattermost channel over its websocket — the adapter half.
 *
 * Mattermost's incoming direction is a *push*: the server delivers events to a
 * websocket at `/api/v4/websocket`, which the Host *originates*. No inbound port
 * is bound and no public callback URL is needed, so the acceptance precondition
 * the other channels keep (ADR 0326) stays true. There is no listener here.
 *
 * Everything a socket channel shares with its siblings is the shared layer's:
 * the connection lifecycle and the reconnect discipline
 * (`messaging-ingress-socket.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is Mattermost's own:
 *
 * - **connect** — `GET /api/v4/users/me` resolves the bot's own user id, the
 *   websocket is opened, and `authentication_challenge` is sent with the access
 *   token (Mattermost's own handshake, not a header);
 * - **normalise** — [`normaliseMattermostPost`]: one `posted` event's post
 *   (a JSON string on older servers, an object on newer ones), filtered against
 *   the bot's own user id and non-empty system post types, keyed on the post id;
 * - **deliver** — `POST /api/v4/posts`, chunked by the shared chunker at
 *   Mattermost's 16383-character limit and posted sequentially, with `root_id`
 *   carrying the thread (declared here where a sender is supplied);
 * - **limit** — [`MATTERMOST_POST_LIMIT`].
 *
 * The handshake answer (`status`/`seq_reply`) and `hello` are Mattermost's own
 * frames and stay in `handleFrame`.
 *
 * # Trust boundary and the credential
 *
 * The access token is a bearer credential for the REST call and the websocket
 * handshake. It travels in the platform's own locations — never in a URL, a log
 * line, an audit entry or an error this module reports. Everything arriving over
 * the socket is untrusted and is validated field by field.
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

/**
 * The shared audit vocabulary expressed in Mattermost's published entry type:
 * the id field here is `postId`, and a malformed frame is `malformed-event`.
 */
function mattermostAudit(sink?: MattermostInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "malformed":
        return sink({ kind: "malformed-event", reason: entry.reason });
      case "duplicate":
      case "processed":
        return sink({ kind: entry.kind, postId: entry.eventId });
      case "process-failed":
      case "record-failed":
        return sink({ kind: entry.kind, postId: entry.eventId, error: entry.error });
      case "auth-failed":
      case "identity-failed":
      case "connect-failed":
        return sink({ kind: entry.kind, error: entry.error });
      case "disconnect":
        return sink({ kind: "disconnect", reason: entry.reason });
      case "filtered":
        return sink({
          kind: "filtered",
          reason: entry.reason,
          ...(entry.channelId ? { channelId: entry.channelId } : {}),
        });
      default:
        // `heartbeat-missed` belongs to Discord.
        return;
    }
  };
}

/** The bot's own identity, resolved once per connection. */
export type MattermostIdentityResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/** `GET /users/me`, injected so a suite needs no server. */
export type MattermostIdentityLookup = (token: string) => Promise<MattermostIdentityResult>;

/** The minimal websocket surface this module uses. */
export type MattermostSocket = IngressSocket;

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

/**
 * Project one post onto the shared shape, keyed on the post id. Mattermost keeps
 * a post id stable server-wide, so the id alone is the replay key.
 */
export function normaliseMattermostPost(
  payload: unknown,
  botUserId: string | null,
): IngressNormalisation {
  const classification = classifyMattermostPost(payload, botUserId);
  if (!classification.accepted) {
    const channelId = isRecord(payload) && typeof payload.channel_id === "string"
      ? payload.channel_id
      : undefined;
    return { kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) };
  }
  return { kind: "message", message: classification.message, key: classification.message.messageId };
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
 * The websocket client: handshake, `posted` events, the strict filter, and the
 * shared dedupe gate.
 *
 * Mattermost has no resume: a fresh connection receives only what happens after
 * it authenticates, so a reconnect cannot duplicate a subscription. The durable
 * guard still covers a redelivery the server makes within a connection and
 * across a restart, keyed on the post id.
 */
export class MattermostSocketClient extends SocketIngressClient {
  private readonly options: MattermostSocketClientOptions;
  private readonly gate: IngressGate;
  private botUserId: string | null = null;

  constructor(options: MattermostSocketClientOptions) {
    const audit = mattermostAudit(options.audit);
    super({ audit });
    this.options = options;
    this.gate = new IngressGate({ handled: options.handled, onMessage: options.onMessage, audit });
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
    this.attach(this.options.connect(this.options.url));
    // Mattermost's own handshake: the token travels in the frame, not a header
    // and not the URL.
    this.send({ seq: 1, action: "authentication_challenge", data: { token } });
  }

  /** Route one raw socket frame: the auth answer, `hello`, or a `posted` event. */
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
    // The handshake answer is a bare `{status, seq_reply}` frame.
    if (typeof parsed.status === "string" && typeof parsed.seq_reply === "number") {
      if (parsed.status !== "OK") {
        this.audit({ kind: "auth-failed", error: `the handshake was refused (${parsed.status})` });
        this.finishClose("the handshake was refused");
        return;
      }
      this.markReady();
      return;
    }
    const event = typeof parsed.event === "string" ? parsed.event : "";
    if (event === "hello") {
      this.markReady();
      return;
    }
    if (event === "posted") {
      await this.handlePosted(parsed);
    }
  }

  private async handlePosted(frame: Record<string, unknown>): Promise<void> {
    const data = isRecord(frame.data) ? frame.data : null;
    if (!data) {
      this.audit({ kind: "malformed", reason: "posted event has no data" });
      return;
    }
    const post = parsePost(data.post);
    if (!post.ok) {
      this.audit({ kind: "malformed", reason: post.reason });
      return;
    }
    const normalisation = normaliseMattermostPost(post.value, this.botUserId);
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

export type MattermostInboundTransportOptions = {
  client: Omit<MattermostSocketClientOptions, "onMessage">;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

/**
 * The reconnect delay after `attempt` consecutive failures: the shared jittered,
 * capped exponential ([`ingressReconnectDelayMs`]).
 */
export function mattermostReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return ingressReconnectDelayMs(attempt, baseMs, maxMs);
}

/** What the adapter needs beyond the client's own options. */
export type MattermostIngressAdapterOptions = Omit<MattermostSocketClientOptions, "onMessage"> & {
  /** The bot's own user id, when it is already known. */
  ownUserId?: string;
  /** The reply path, when one is supplied; the shared chunker calls it per chunk. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The Mattermost ingress adapter: the platform-specific seams and nothing else.
 * A fresh client per connection attempt, because Mattermost has no resume and
 * nothing about a closed connection is worth keeping.
 */
export function createMattermostIngressAdapter(
  options: MattermostIngressAdapterOptions,
): SocketIngressAdapter {
  let botUserId: string | null = options.ownUserId ?? null;
  return {
    platform: "mattermost",
    kind: "socket",
    messageLimit: MATTERMOST_POST_LIMIT,
    normalise: (raw) => normaliseMattermostPost(raw, botUserId),
    ...(options.deliver ? { deliver: options.deliver } : {}),
    openClient: (onMessage) => {
      const { deliver: _deliver, ownUserId: _ownUserId, ...clientOptions } = options;
      return new MattermostSocketClient({
        ...clientOptions,
        // The identity is resolved by the client's own handshake; the adapter's
        // filter reads it through this seam so both agree on "the bot's own".
        resolveIdentity: async (token) => {
          const result = await clientOptions.resolveIdentity(token);
          if (result.ok) botUserId = result.userId;
          return result;
        },
        onMessage,
      });
    },
  };
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
  return createSocketIngressTransport(createMattermostIngressAdapter(options.client), {
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxReconnectDelayMs !== undefined
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
