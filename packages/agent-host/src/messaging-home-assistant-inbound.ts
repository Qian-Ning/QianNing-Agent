/**
 * The Home Assistant channel — the adapter half.
 *
 * Home Assistant is not a chat product, and this module does not pretend it is.
 * What it actually offers, and what is therefore built here, is:
 *
 * - **outbound, which is real and useful** — `POST /api/services/<domain>/<service>`
 *   with a long-lived access token in `Authorization`. The linked service is
 *   where every reply goes (a `notify.*` service by convention), so the channel
 *   can deliver a message to a phone, a speaker, a script or a wall panel with
 *   nothing but a base URL and a token.
 * - **inbound, which exists only as the event bus** — Home Assistant has no
 *   user-facing chat surface that hands a text message to a third-party agent.
 *   Its own conversational surface (Assist) is Home Assistant *being* the
 *   assistant: the user talks to Home Assistant and Home Assistant answers.
 *   The `conversation/process` API is a request made *into* Home Assistant, so
 *   using it would make this build the user, not the agent. What Home Assistant
 *   does have is a genuinely push-shaped, authenticated stream:
 *   `subscribe_events` over `/api/websocket`, carrying events fired by the
 *   user's own automations and scripts.
 *
 * So inbound is real but authored: a message arrives when something in the
 * user's Home Assistant fires the subscribed event with message text in it —
 * an automation triggered by an Assist sentence, a button, a voice satellite, a
 * template, or any other trigger the user writes. Without such an automation
 * the channel is outbound-only, and the settings panel says so in those words
 * rather than implying a chat surface that does not exist.
 *
 * # What is shared and what is Home Assistant's
 *
 * The connection lifecycle (attach, readiness, close waiters, a `send` that
 * tolerates a dead socket) and the reconnect discipline (jittered, capped
 * backoff) are the shared socket transport's
 * ([`./messaging-ingress-socket.js`]); the dedupe ordering, the audit
 * vocabulary and the reply chunker are the shared ingress layer's
 * ([`./messaging-ingress.js`]). This module supplies only:
 *
 * - **connect** — open `ws(s)://host/api/websocket` and drive Home Assistant's
 *   own handshake: the server speaks first (`auth_required`), we answer
 *   `{type:"auth",access_token}`, the server answers `auth_ok` or
 *   `auth_invalid`, and only then is `subscribe_events` sent — once per
 *   connection. `connect` resolves only after the subscription was acknowledged,
 *   so a rejected token is a reported failure rather than a socket that looks
 *   open and never receives anything;
 * - **normalise** — one event of the subscribed type becomes one turn; a
 *   different event type, an empty body, a system event with no author, and an
 *   echo of this assistant's own outbound message are filtered with a reason;
 * - **deliver** — `POST /api/services/<domain>/<service>`, chunked by the shared
 *   chunker at [`HOME_ASSISTANT_MESSAGE_LIMIT`] and posted sequentially;
 * - **limit** — [`HOME_ASSISTANT_MESSAGE_LIMIT`], declared in characters.
 *
 * # The message limit, and why it is 4000
 *
 * Home Assistant's websocket frames and service calls have no documented size
 * cap, so there is no protocol number to copy. The limit exists anyway because
 * a reply is usually delivered by a notification or a speech service, and those
 * have real ceilings: a mobile push payload and a TTS utterance both become
 * unusable long before a JSON frame does. 4000 characters is comfortably inside
 * every notify target this build knows of, and a reply longer than that is
 * split into ordered parts rather than handed over as one payload that a
 * downstream service truncates or drops.
 *
 * # Endpoint and credential
 *
 * The base URL comes from settings and goes through the same
 * [`validateInboundEndpoint`] discipline every other channel applies: HTTPS
 * required, `http` only for a loopback, `.local` or private-LAN host under the
 * relaxed policy. The service call refuses redirects (`redirect: "manual"`, and
 * a 3xx is a refusal), so a token cannot be bounced to another host.
 *
 * The long-lived access token is a `secret:` reference in the settings section
 * (`secret:messaging-home-assistant:access-token`). It is written in exactly two
 * places — the `auth` frame and the `Authorization` header — and never in an
 * audit entry, an error message, a URL, or a reconnect delay. Every failure
 * detail here is a fixed string that names a status or a class.
 *
 * # Testability without a network
 *
 * The websocket client and the HTTP client are both injected
 * ([`HomeAssistantSocketFactory`], [`HomeAssistantFetch`]), and the durable
 * replay guard is an interface. A suite drives the handshake, the subscription,
 * the projection and the send path against an in-process fake Home Assistant.
 */

import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";
import {
  deliverInChunks,
  IngressGate,
  ingressMessageKey,
  type IngressAudit,
  type IngressDeliveryResult,
  type IngressNormalisation,
  type IngressPostOutcome,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import {
  createSocketIngressTransport,
  SocketIngressClient,
  type IngressSocket,
} from "./messaging-ingress-socket.js";

/** The settings section the Home Assistant channel's record lives in. */
export const MESSAGING_HOME_ASSISTANT_SECTION = "messagingHomeAssistant";
/** The record's self-identifying format. */
export const MESSAGING_HOME_ASSISTANT_FORMAT = "pi-desktop-messaging-home-assistant";
/** The record version this build reads. */
export const MESSAGING_HOME_ASSISTANT_FORMAT_VERSION = 1;
/** Where the long-lived access token lives in the host's secret store. */
export const MESSAGING_HOME_ASSISTANT_ACCESS_TOKEN_SECRET_REF =
  "secret:messaging-home-assistant:access-token";

/** The most message ids the settings-backed replay guard remembers. */
export const HOME_ASSISTANT_HANDLED_CAPACITY = 2048;

/** The websocket path, appended to the configured base URL. */
export const HOME_ASSISTANT_WEBSOCKET_PATH = "/api/websocket";

/**
 * The event type an automation fires to send this agent a message.
 *
 * Fixed rather than configurable: it is the one name the settings walkthrough
 * and the automation example both quote, so a user can copy one line into
 * Home Assistant and have the channel work. A second name would be a second
 * thing to get wrong.
 */
export const HOME_ASSISTANT_EVENT_TYPE = "qianning_message";

/**
 * The most characters a reply is split at. See the module comment: Home
 * Assistant has no documented frame limit, so this is the ceiling of the
 * delivery targets (notification and speech services) rather than a protocol
 * number.
 */
export const HOME_ASSISTANT_MESSAGE_LIMIT = 4000;

/** How long the auth + subscribe handshake may stay unanswered. */
export const HOME_ASSISTANT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** How long one service call may take. */
export const HOME_ASSISTANT_REQUEST_TIMEOUT_MS = 15_000;

/** The `context.origin` values that mean "this assistant sent it". */
const OWN_ECHO_SOURCES = ["qianning", "qianning-assistant"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One audit record. Structure and ids only — never message text or a token. */
export type HomeAssistantInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "malformed"; reason: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "processed"; messageId: string }
  | { kind: "process-failed"; messageId: string; error: string }
  | { kind: "record-failed"; messageId: string; error: string }
  | { kind: "send-failed"; error: string };

export type HomeAssistantInboundAudit = (entry: HomeAssistantInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in Home Assistant's published entry
 * type: message ids are `messageId`, and `heartbeat-missed` is Discord's — this
 * channel's keepalive is Home Assistant's own websocket ping, which the socket
 * library answers without the client seeing it.
 */
function homeAssistantAudit(sink?: HomeAssistantInboundAudit): IngressAudit {
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
      case "identity-failed":
        return sink({ kind: "auth-failed", error: entry.error });
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
        return;
    }
  };
}

// ---------------------------------------------------------------------------
// The endpoint, the websocket address and the service path
// ---------------------------------------------------------------------------

/** A configured base URL with its trailing slashes removed, or a refusal. */
export function homeAssistantApiBase(
  endpoint: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; base: string } | { ok: false; error: string } {
  const checked = validateInboundEndpoint(endpoint, options);
  if (!checked.ok) return checked;
  const base = `${checked.url.protocol}//${checked.url.host}${checked.url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, base };
}

/**
 * The websocket address for a configured base URL, or the reason it is refused.
 *
 * The endpoint rule is applied before the path is appended — `http` becomes
 * `ws` and `https` becomes `wss` — so a plaintext Home Assistant is accepted
 * only on a loopback/`.local`/private-LAN host under the relaxed policy, the
 * same rule the other channels keep. The token is never part of this URL: the
 * `auth` frame carries it.
 */
export function homeAssistantWebSocketUrl(
  endpoint: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; url: string } | { ok: false; error: string } {
  const checked = validateInboundEndpoint(endpoint, options);
  if (!checked.ok) return checked;
  const url = checked.url;
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url: `${base}${HOME_ASSISTANT_WEBSOCKET_PATH}` };
}

/**
 * Split `domain.service` into its two halves, or refuse it.
 *
 * Home Assistant service names are lowercase letters, digits and underscores on
 * both sides of the dot, so a name that does not match cannot be a service and
 * is refused before it becomes a path. Refusing here is what keeps a
 * user-typed value from reaching the request URL as anything but a service.
 */
export function parseHomeAssistantService(
  service: string,
): { ok: true; domain: string; name: string; path: string } | { ok: false; error: string } {
  const value = service.trim().toLowerCase();
  const match = /^([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(value);
  if (!match) {
    return { ok: false, error: "the configured service must be written as domain.service" };
  }
  const domain = match[1]!;
  const name = match[2]!;
  return { ok: true, domain, name, path: `/api/services/${domain}/${name}` };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export type HomeAssistantNormaliseOptions = {
  /**
   * The conversation a reply is sent to when the event does not name one: the
   * linked service. Home Assistant events carry no conversation, so this is the
   * normal case, not the fallback.
   */
  defaultConversation: string;
  /** The event type subscribed to; defaults to [`HOME_ASSISTANT_EVENT_TYPE`]. */
  eventType?: string;
};

/**
 * Classify one Home Assistant event into the neutral message shape.
 *
 * Refused, with a reason: a payload that is not an object; an event of another
 * type (the subscription is filtered by type at the server, but a fake or a
 * future server may send more); an echo of this assistant's own outbound
 * message, which Home Assistant can re-broadcast when a user's automation
 * fires the subscribed type from a notification callback; an empty body; and an
 * event with no id of any kind to dedupe on.
 *
 * The text is `data.text`. `data.message` is accepted as well, because an
 * automation author naturally writes `message` when the target is a notify
 * service — one alias, documented, rather than a second event type.
 */
export function normaliseHomeAssistantEvent(
  raw: unknown,
  options: HomeAssistantNormaliseOptions,
): IngressNormalisation {
  const eventType = options.eventType ?? HOME_ASSISTANT_EVENT_TYPE;
  if (!isRecord(raw)) return { kind: "filtered", reason: "the event is not an object" };

  const type = trimmedString(raw.event_type);
  if (type !== eventType) {
    return { kind: "filtered", reason: `the event is not a ${eventType} event` };
  }
  const data = isRecord(raw.data) ? raw.data : null;
  if (!data) return { kind: "filtered", reason: "the event carries no data object" };

  if (data.direction === "outbound" || OWN_ECHO_SOURCES.includes(trimmedString(data.source))) {
    return { kind: "filtered", reason: "the event is this assistant's own outbound message" };
  }

  const text = trimmedString(data.text) || trimmedString(data.message);
  if (!text) return { kind: "filtered", reason: "the event carries no message text" };

  const conversation =
    trimmedString(data.conversation_id) ||
    trimmedString(data.conversation) ||
    options.defaultConversation.trim();
  if (!conversation) {
    return { kind: "filtered", reason: "the event names no conversation to answer in" };
  }

  const context = isRecord(raw.context) ? raw.context : null;
  const messageId =
    trimmedString(data.message_id) ||
    trimmedString(context?.id) ||
    trimmedString(raw.time_fired) ||
    trimmedString(raw.event_type);
  if (!messageId) {
    return { kind: "filtered", reason: "the event carries no id to dedupe on", channelId: conversation };
  }

  const message: InboundMessage = {
    messageId,
    chatId: conversation,
    text,
  };
  return { kind: "message", message, key: ingressMessageKey(conversation, messageId) };
}

// ---------------------------------------------------------------------------
// The send path
// ---------------------------------------------------------------------------

/** The HTTP seam; injected so a suite needs no server. */
export type HomeAssistantFetch = (url: string, init: RequestInit) => Promise<Response>;

export type HomeAssistantSenderOptions = {
  /** The validated base URL, e.g. `https://ha.example.org`. */
  base: string;
  /** The service, in `domain.service` form. */
  service: string;
  /** The long-lived access token; written only in the `Authorization` header. */
  token: string;
  /** The HTTP seam; defaults to the platform `fetch`. */
  fetchImpl?: HomeAssistantFetch;
  /** How long one call may take. */
  requestTimeoutMs?: number;
  /** Reports a failed send; a record names the status, never the body. */
  audit?: HomeAssistantInboundAudit;
};

export interface HomeAssistantSender {
  send(text: string): Promise<IngressDeliveryResult>;
}

/** A `Retry-After` header in either of its two documented forms. */
function retryAfterMs(header: string | null): number {
  if (!header) return 1_000;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return 1_000;
}

/**
 * Classify one service call's answer into the shared post vocabulary.
 *
 * Exported because the mapping is the part worth pinning: a 401 is a refused
 * credential (refusal, not retry), a 429 is the platform's own back-off
 * (retry after its `Retry-After`), a 5xx is unavailability (retry on the shared
 * backoff), and a 3xx is refused outright — a redirect would carry the bearer
 * token to a host the user never configured.
 */
export function classifyHomeAssistantServiceResponse(
  status: number,
  headers: Headers,
  sent: number,
): IngressPostOutcome {
  if (status >= 200 && status < 300) return { kind: "accepted", id: `ha-${sent + 1}` };
  if (status >= 300 && status < 400) {
    return { kind: "refused", error: `the service call answered a redirect (HTTP ${status})` };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "refused",
      error: `the service call was refused (HTTP ${status}); check the access token`,
    };
  }
  if (status === 404) {
    return { kind: "refused", error: "the service call answered HTTP 404; check the service name" };
  }
  if (status === 429) {
    return { kind: "rate-limited", retryAfterMs: retryAfterMs(headers.get("retry-after")) };
  }
  if (status >= 500) return { kind: "unavailable" };
  return { kind: "refused", error: `the service call answered HTTP ${status}` };
}

/**
 * The production send path: one service call per chunk, sequential, through the
 * shared chunker and the shared retry schedule.
 *
 * `{ message }` is the body because it is the one field every `notify.*`
 * service accepts, and a script that takes a `message` field accepts it too.
 * The token travels in `Authorization` and nowhere else; the failure details
 * the shared layer reports are status-only strings.
 */
export function createHomeAssistantSender(
  options: HomeAssistantSenderOptions,
): HomeAssistantSender {
  const parsed = parseHomeAssistantService(options.service);
  const timeout = options.requestTimeoutMs ?? HOME_ASSISTANT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? (fetch as HomeAssistantFetch);
  let sent = 0;
  return {
    async send(text: string): Promise<IngressDeliveryResult> {
      if (!parsed.ok) {
        options.audit?.({ kind: "send-failed", error: parsed.error });
        return { ok: false, error: parsed.error, sent: 0 };
      }
      sent = 0;
      const result = await deliverInChunks(text, {
        platform: "home assistant",
        limit: HOME_ASSISTANT_MESSAGE_LIMIT,
        post: async (chunk) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetchImpl(`${options.base}${parsed.path}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ message: chunk }),
              redirect: "manual",
              signal: controller.signal,
            });
            const outcome = classifyHomeAssistantServiceResponse(
              response.status,
              response.headers,
              sent,
            );
            if (outcome.kind === "accepted") sent += 1;
            return outcome;
          } finally {
            clearTimeout(timer);
          }
        },
      });
      if (!result.ok) options.audit?.({ kind: "send-failed", error: result.error });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type HomeAssistantTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** The minimal websocket surface this module uses. */
export type HomeAssistantSocket = IngressSocket;

/** Opens a websocket to a URL; injected so a suite needs no socket. */
export type HomeAssistantSocketFactory = (url: string) => HomeAssistantSocket;

export type HomeAssistantClientOptions = {
  /** The websocket address, already validated. */
  url: string;
  /** The long-lived access token; written in the `auth` frame and nowhere else. */
  token: string;
  /** The conversation a reply is sent to when the event names none. */
  defaultConversation: string;
  /** The restart-durable replay guard. */
  handled: { has(key: string): Promise<boolean>; record(key: string): Promise<void> };
  /** The neutral handler the driver's routing path provides. */
  onMessage: (message: InboundMessage) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: HomeAssistantInboundAudit;
  /** The websocket seam the composition root supplies. */
  connect: HomeAssistantSocketFactory;
  /** How long an unanswered handshake waits; defaults to 15s. */
  handshakeTimeoutMs?: number;
  /** The timer surface, injectable so a suite needs no wall clock. */
  timers?: HomeAssistantTimers;
};

/** Whether a Home Assistant `error.code` is a plain code worth reporting. */
function safeErrorCode(value: unknown): string {
  const code = trimmedString(value);
  return /^[a-z0-9_]{1,64}$/i.test(code) ? code : "unknown";
}

/**
 * The Home Assistant client: the auth handshake, the one subscription per
 * connection, and the shared dedupe gate.
 *
 * The connection lifecycle and the reconnect policy belong to the shared socket
 * layer. What is here is the protocol: `auth_required` → `auth` → `auth_ok` →
 * `subscribe_events`, and the `event` frames that follow.
 *
 * `connect()` resolves only once the subscription was acknowledged. That is what
 * makes a rejected token a failure the composition root can see, instead of a
 * connection that looks established and never receives a message — the same
 * failure the IRC channel's registration wait exists to prevent.
 */
export class HomeAssistantClient extends SocketIngressClient {
  private readonly options: HomeAssistantClientOptions;
  private readonly timers: HomeAssistantTimers;
  private readonly gate: IngressGate;
  private handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private handshakeTimer: unknown = null;
  /** Whether the subscription frame was sent on the current connection. */
  private subscribed = false;
  /** The reason the last handshake was refused, so a caller can surface it. */
  private refusal: string | null = null;

  constructor(options: HomeAssistantClientOptions) {
    const audit = homeAssistantAudit(options.audit);
    super({ audit });
    this.options = options;
    this.gate = new IngressGate({ handled: options.handled, onMessage: options.onMessage, audit });
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** The reason the last handshake was refused, or `null`. */
  get lastRefusal(): string | null {
    return this.refusal;
  }

  /**
   * Open one connection and wait for the subscription to be acknowledged.
   *
   * The token is written as the `auth` frame and then dropped from every report
   * this method can produce: a refusal is a fixed string, never the frame or
   * the message Home Assistant quoted back.
   */
  async connect(): Promise<void> {
    const token = this.options.token.trim();
    if (!token) {
      const error = "the configured access token is empty";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    this.refusal = null;
    this.subscribed = false;
    const pending = new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
    });
    this.attach(this.options.connect(this.options.url));
    const timeout = Math.max(
      0,
      this.options.handshakeTimeoutMs ?? HOME_ASSISTANT_HANDSHAKE_TIMEOUT_MS,
    );
    this.handshakeTimer = this.timers.setTimeout(() => {
      this.failHandshake("Home Assistant did not answer the handshake in time");
    }, timeout);
    await pending;
  }

  /** Stop the handshake timer with the connection that owned it. */
  protected onDisconnect(): void {
    this.clearHandshakeTimer();
    const pending = this.handshake;
    this.handshake = null;
    pending?.reject(new Error("the connection closed before the subscription was acknowledged"));
  }

  /** Route one raw frame: the handshake, the subscription result, or an event. */
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
    const type = trimmedString(parsed.type);

    if (type === "auth_required") {
      // Home Assistant speaks first; the token travels in this frame, which is
      // the platform's own handshake — never a header and never the URL.
      this.send({ type: "auth", access_token: this.options.token.trim() });
      return;
    }
    if (type === "auth_ok") {
      this.subscribe();
      return;
    }
    if (type === "auth_invalid") {
      // The server's own message is deliberately not repeated: it is a value
      // from the far end, and this module's rule is that no far-end string
      // becomes our error text.
      this.failHandshake("Home Assistant rejected the access token");
      return;
    }
    if (type === "result" && parsed.id === 1) {
      if (parsed.success !== true) {
        const error = isRecord(parsed.error) ? parsed.error : null;
        this.failHandshake(
          `Home Assistant refused the event subscription (${safeErrorCode(error?.code)})`,
        );
        return;
      }
      this.clearHandshakeTimer();
      this.markReady();
      const pending = this.handshake;
      this.handshake = null;
      pending?.resolve();
      return;
    }
    if (type === "event" && parsed.id === 1) {
      await this.handleEvent(parsed.event);
    }
  }

  /** Send the subscription, exactly once per connection. */
  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.send({ id: 1, type: "subscribe_events", event_type: HOME_ASSISTANT_EVENT_TYPE });
  }

  private async handleEvent(raw: unknown): Promise<void> {
    const normalisation = normaliseHomeAssistantEvent(raw, {
      defaultConversation: this.options.defaultConversation,
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
   * End the attempt with a refusal: audit it, reject `connect`, and close the
   * socket. Surfacing is the point — the reconnect loop will try again on the
   * shared backoff, but each attempt is a reported failure rather than a silent
   * loop.
   */
  private failHandshake(error: string): void {
    this.refusal = error;
    this.clearHandshakeTimer();
    const pending = this.handshake;
    this.handshake = null;
    this.audit({ kind: "auth-failed", error });
    pending?.reject(new Error(error));
    this.finishClose(error);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.timers.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type HomeAssistantIngressAdapterOptions = {
  /** The validated base URL, e.g. `https://ha.example.org`. */
  base: string;
  /** The websocket address derived from the same base. */
  url: string;
  /** The long-lived access token, already resolved from the secret store. */
  token: string;
  /** The linked service, in `domain.service` form; also the default conversation. */
  service: string;
  /** The restart-durable replay guard. */
  handled: { has(key: string): Promise<boolean>; record(key: string): Promise<void> };
  /** Where audit records go; absent means they are dropped. */
  audit?: HomeAssistantInboundAudit;
  /** The websocket seam the composition root supplies. */
  connect: HomeAssistantSocketFactory;
  /** The HTTP seam; defaults to the platform `fetch`. */
  fetchImpl?: HomeAssistantFetch;
  /** How long an unanswered handshake waits. */
  handshakeTimeoutMs?: number;
  /** The timer surface, injectable so a suite needs no wall clock. */
  timers?: HomeAssistantTimers;
};

/**
 * The Home Assistant ingress adapter: the platform's seams and nothing else.
 *
 * One client is built for the whole run and reused across reconnects, so the
 * durable guard and the message handler survive a close; each `connect` is a
 * fresh socket with a fresh auth handshake and exactly one subscription, which
 * is what keeps a reconnect from duplicating the stream.
 */
export function createHomeAssistantIngressAdapter(
  options: HomeAssistantIngressAdapterOptions,
): SocketIngressAdapter {
  let client: HomeAssistantClient | null = null;
  const sender = createHomeAssistantSender({
    base: options.base,
    service: options.service,
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  return {
    platform: "home-assistant",
    kind: "socket",
    messageLimit: HOME_ASSISTANT_MESSAGE_LIMIT,
    normalise: (raw) =>
      normaliseHomeAssistantEvent(raw, { defaultConversation: options.service }),
    // Every reply leaves through the one linked service. An event may name its
    // own conversation for routing and dedupe, but Home Assistant has no
    // per-conversation reply address, so the linked service is the only target.
    deliver: (_chatId, text) => sender.send(text),
    openClient: (onMessage) => {
      if (!client) {
        client = new HomeAssistantClient({
          url: options.url,
          token: options.token,
          defaultConversation: options.service,
          handled: options.handled,
          onMessage,
          connect: options.connect,
          ...(options.audit ? { audit: options.audit } : {}),
          ...(options.handshakeTimeoutMs !== undefined
            ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
            : {}),
          ...(options.timers ? { timers: options.timers } : {}),
        });
      }
      return client;
    },
  };
}

/** How the production push transport reaches Home Assistant. */
export type HomeAssistantInboundTransportOptions = {
  /** Everything the adapter needs except `onMessage`, which the transport binds. */
  client: HomeAssistantIngressAdapterOptions;
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
 * originates, and Home Assistant pushes event frames down it. That is what
 * makes this channel admissible on a home network behind NAT, the same
 * precondition Slack Socket Mode, Discord's Gateway and Mattermost's websocket
 * keep.
 */
export function createHomeAssistantInboundPushTransport(
  options: HomeAssistantInboundTransportOptions,
): MessagingInboundPushTransport {
  return createSocketIngressTransport(createHomeAssistantIngressAdapter(options.client), {
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxReconnectDelayMs !== undefined
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
