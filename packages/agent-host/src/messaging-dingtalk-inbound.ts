import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressReconnectDelayMs,
  type IngressAudit,
  type IngressDeliveryResult,
  type IngressHandledStore,
  type IngressMessage,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import { SocketIngressClient, createSocketIngressTransport } from "./messaging-ingress-socket.js";
import type { IngressSocket, IngressSocketFactory } from "./messaging-ingress-socket.js";

/**
 * The inbound DingTalk channel over Stream Mode — the adapter half.
 *
 * DingTalk's callback model wants a public URL, which a desktop app behind a
 * router does not have. Stream Mode inverts it: the client calls
 * `POST /v1.0/gateway/connections/open` with the app's client id and secret,
 * receives an endpoint and a one-shot ticket, and opens a websocket to it. The
 * platform pushes events down that socket, so no port is bound and no tunnel is
 * needed — the same acceptance precondition Mattermost and Slack's socket mode
 * keep (ADR 0326).
 *
 * This module supplies only what is DingTalk's own:
 *
 * - **connect** — the gateway handshake, then a `ping` frame every 30s, because
 *   a silent socket is closed by the server;
 * - **normalise** — [`normaliseDingtalkMessage`]: a `CALLBACK` frame's `data`
 *   (a JSON *string*, not an object) projected onto one inbound message;
 * - **deliver** — a bot answer goes to the `sessionWebhook` that arrived with
 *   the message, not to a conversation endpoint, so the last webhook per
 *   conversation is kept until a newer one replaces it.
 */

/** The settings section the DingTalk channel's record lives in. */
export const MESSAGING_DINGTALK_SECTION = "messagingDingtalk";
/** The record's self-identifying format. */
export const MESSAGING_DINGTALK_FORMAT = "pi-desktop-messaging-dingtalk";
/** The record version this build reads. */
export const MESSAGING_DINGTALK_FORMAT_VERSION = 1;
/** The most message ids the settings-backed replay guard remembers. */
export const DINGTALK_HANDLED_CAPACITY = 2048;
/** Where the app's client id (AppKey) lives in the host's secret store. */
export const MESSAGING_DINGTALK_CLIENT_ID_SECRET_REF = "secret:messaging-dingtalk:client-id";
/** Where the app's client secret (AppSecret) lives in the host's secret store. */
export const MESSAGING_DINGTALK_CLIENT_SECRET_SECRET_REF = "secret:messaging-dingtalk:client-secret";

/** DingTalk closes a stream that has been silent; the client keeps it warm. */
export const DINGTALK_HEARTBEAT_MS = 30_000;

/** The documented ceiling for one bot text message. */
export const DINGTALK_TEXT_LIMIT = 20_000;

export type DingtalkStreamCredentials = {
  clientId: string;
  clientSecret: string;
};

/** What the gateway answered: where to connect, and the ticket that admits us. */
export type DingtalkGatewayTicket = {
  endpoint: string;
  ticket: string;
};

export type DingtalkOpenGateway = (
  credentials: DingtalkStreamCredentials,
) => Promise<DingtalkGatewayTicket>;

export type DingtalkFetch = typeof fetch;

/**
 * Open a Stream Mode connection through DingTalk's gateway.
 *
 * The subscription list is what decides which topics arrive at all; a bot that
 * wants messages must name `/v1.0/im/bot/messages/get` explicitly.
 */
export function createDingtalkGatewayOpener(
  fetchImpl: DingtalkFetch = fetch,
  baseUrl = "https://api.dingtalk.com",
): DingtalkOpenGateway {
  return async (credentials) => {
    const response = await fetchImpl(`${baseUrl}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        subscriptions: [
          { type: "SYSTEM", topic: "*" },
          { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
        ],
        ua: "pi-desktop/1.0",
      }),
    });
    if (!response.ok) {
      throw new Error(`dingtalk gateway refused the handshake (${response.status})`);
    }
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) throw new Error("dingtalk gateway answered something other than an object");
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
    if (!endpoint || !ticket) throw new Error("dingtalk gateway did not return an endpoint and ticket");
    return { endpoint, ticket };
  };
}

export type DingtalkStreamClientOptions = {
  credentials: DingtalkStreamCredentials;
  openGateway: DingtalkOpenGateway;
  connect: IngressSocketFactory;
  onMessage: (message: IngressMessage) => Promise<void>;
  /** The restart-durable replay guard, shared with every other channel. */
  handled: IngressHandledStore;
  audit?: IngressAudit;
  /** `0` disables the heartbeat; a suite uses that instead of fake timers. */
  heartbeatMs?: number;
  fetch?: DingtalkFetch;
};

export class DingtalkStreamClient extends SocketIngressClient {
  private readonly options: DingtalkStreamClientOptions;
  private readonly gate: IngressGate;
  private readonly sessionWebhooks = new Map<string, string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(options: DingtalkStreamClientOptions) {
    const audit = options.audit;
    super({ ...(audit ? { audit } : {}) });
    this.options = options;
    this.gate = new IngressGate({
      handled: options.handled,
      onMessage: options.onMessage,
      ...(audit ? { audit } : {}),
    });
  }

  async connect(): Promise<void> {
    const { clientId, clientSecret } = this.options.credentials;
    if (!clientId.trim() || !clientSecret.trim()) {
      const error = "the configured app credentials are empty";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    const ticket = await this.options.openGateway({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
    const separator = ticket.endpoint.includes("?") ? "&" : "?";
    this.attach(this.options.connect(`${ticket.endpoint}${separator}ticket=${encodeURIComponent(ticket.ticket)}`));
    // Stream Mode has no welcome frame: an open socket is a live stream.
    this.markReady();
    this.startHeartbeat();
  }

  /** The session webhook that answers the most recent message in a conversation. */
  sessionWebhookFor(chatId: string): string | null {
    return this.sessionWebhooks.get(chatId) ?? null;
  }

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
    const headers = isRecord(parsed.headers) ? parsed.headers : {};
    const topic = typeof headers.topic === "string" ? headers.topic : "";
    const messageId = typeof headers.messageId === "string" ? headers.messageId : "";
    const type = typeof parsed.type === "string" ? parsed.type : "";

    // The answer to our own ping: nothing to do, and it is not a callback.
    if (topic === "ping") return;

    if (type !== "CALLBACK") {
      this.audit({ kind: "filtered", reason: `frame type ${type || "unknown"} is not a callback` });
      return;
    }

    const data = parseCallbackData(parsed.data);
    if (!data.ok) {
      this.ack(messageId, 400);
      this.audit({ kind: "malformed", reason: data.reason });
      return;
    }
    const webhook = typeof data.value.sessionWebhook === "string" ? data.value.sessionWebhook : "";
    const chatId = typeof data.value.conversationId === "string" ? data.value.conversationId : "";
    if (webhook && chatId) this.sessionWebhooks.set(chatId, webhook);

    const normalisation = normaliseDingtalkMessage(data.value);
    if (normalisation.kind !== "message") {
      this.ack(messageId, 200);
      this.audit({ kind: "filtered", reason: normalisation.reason, ...(chatId ? { channelId: chatId } : {}) });
      return;
    }
    await this.gate.ingest(normalisation.message, normalisation.key, () => this.ack(messageId, 200));
  }

  /** Answer one callback frame; DingTalk redelivers what it never saw acknowledged. */
  private ack(messageId: string, code: number): void {
    if (!messageId) return;
    this.send({
      code,
      headers: { messageId, contentType: "application/json" },
      message: code === 200 ? "OK" : "Bad Request",
      data: "{}",
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ms = this.options.heartbeatMs ?? DINGTALK_HEARTBEAT_MS;
    if (ms <= 0) return;
    this.heartbeat = setInterval(() => {
      this.seq += 1;
      this.send({
        type: "SYSTEM",
        headers: { topic: "ping", messageId: `ping-${this.seq}` },
        data: "{}",
      });
    }, ms);
    // A timer must never hold the Host's event loop open on its own.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Detach the heartbeat when the shared layer closes the socket. */
  protected override finishClose(reason: string): void {
    this.stopHeartbeat();
    super.finishClose(reason);
  }
}

/**
 * Project one bot message onto the shared inbound shape.
 *
 * Filters, in the order they are cheapest to explain: an empty body, a message
 * this bot sent itself (DingTalk echoes it back through the same topic), and a
 * body whose type is not text. `richText` is read for its text runs because a
 * phone user's message often arrives that way.
 */
export function normaliseDingtalkMessage(value: Record<string, unknown>): IngressNormalisation {
  const msgId = typeof value.msgId === "string" ? value.msgId.trim() : "";
  const chatId = typeof value.conversationId === "string" ? value.conversationId.trim() : "";
  if (!msgId) return { kind: "filtered", reason: "message has no msgId" };
  if (!chatId) return { kind: "filtered", reason: "message has no conversationId" };

  const self = typeof value.robotCode === "string" ? value.robotCode.trim() : "";
  const sender = typeof value.senderStaffId === "string" ? value.senderStaffId.trim() : "";
  if (self && sender && self === sender) {
    return { kind: "filtered", reason: "message was sent by this bot", channelId: chatId };
  }

  const text = dingtalkText(value);
  if (!text) return { kind: "filtered", reason: "message has no text", channelId: chatId };
  return { kind: "message", message: { messageId: msgId, chatId, text }, key: msgId };
}

function dingtalkText(value: Record<string, unknown>): string {
  const kind = typeof value.msgtype === "string" ? value.msgtype : "";
  if (kind === "text" && isRecord(value.text)) {
    const content = value.text.content;
    return typeof content === "string" ? content.trim() : "";
  }
  if (kind === "richText" && isRecord(value.content)) {
    const runs = value.content.richText;
    if (!Array.isArray(runs)) return "";
    const parts: string[] = [];
    for (const run of runs) {
      if (isRecord(run) && typeof run.text === "string") parts.push(run.text);
    }
    return parts.join("").trim();
  }
  return "";
}

function parseCallbackData(
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (isRecord(raw)) return { ok: true, value: raw };
  if (typeof raw !== "string") return { ok: false, reason: "callback data is neither a string nor an object" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, reason: "callback data is not an object" };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: "callback data is not JSON" };
  }
}

export type DingtalkIngressAdapterOptions = {
  credentials: DingtalkStreamCredentials;
  openGateway: DingtalkOpenGateway;
  connect: IngressSocketFactory;
  handled: IngressHandledStore;
  audit?: IngressAudit;
  heartbeatMs?: number;
  fetch?: DingtalkFetch;
  /** Overrides the webhook lookup; production reads the client's last one. */
  deliver?: (chatId: string, text: string) => Promise<IngressDeliveryResult>;
};

/**
 * The DingTalk ingress adapter: the platform-specific seams and nothing else.
 * One client per connection attempt, because Stream Mode tickets are one-shot
 * and a reconnect must ask the gateway for a new one.
 */
export function createDingtalkIngressAdapter(
  options: DingtalkIngressAdapterOptions,
): SocketIngressAdapter {
  let live: DingtalkStreamClient | null = null;
  const fetchImpl = options.fetch ?? fetch;
  const deliver =
    options.deliver ??
    (async (chatId: string, text: string): Promise<IngressDeliveryResult> => {
      const webhook = live?.sessionWebhookFor(chatId) ?? null;
      if (!webhook) return { ok: false, error: "this conversation has no session webhook yet", sent: 0 };
      const response = await fetchImpl(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
      if (!response.ok) {
        return { ok: false, error: `dingtalk refused the reply (${response.status})`, sent: 0 };
      }
      return { ok: true, sent: 1, ids: [] };
    });

  return {
    platform: "dingtalk",
    kind: "socket",
    messageLimit: DINGTALK_TEXT_LIMIT,
    normalise: (raw) => normaliseDingtalkMessage(isRecord(raw) ? raw : {}),
    deliver,
    openClient: (onMessage) => {
      const client = new DingtalkStreamClient({
        credentials: options.credentials,
        openGateway: options.openGateway,
        connect: options.connect,
        onMessage,
        handled: options.handled,
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      live = client;
      return client;
    },
  };
}

export type DingtalkInboundTransportOptions = Omit<DingtalkIngressAdapterOptions, "deliver"> & {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

/**
 * The production push transport: it holds a Stream Mode connection open, serves
 * bot messages through [`DingtalkStreamClient`], and reconnects until `signal`
 * aborts. A refused handshake leaves the loop to wait and retry, so an app id
 * that is still being approved cannot take the Host down or spin it.
 */
export function createDingtalkInboundPushTransport(
  options: DingtalkInboundTransportOptions,
): MessagingInboundPushTransport {
  const { reconnectDelayMs, maxReconnectDelayMs, wait, ...adapterOptions } = options;
  return createSocketIngressTransport(createDingtalkIngressAdapter(adapterOptions), {
    ...(reconnectDelayMs !== undefined ? { reconnectDelayMs } : {}),
    ...(maxReconnectDelayMs !== undefined ? { maxReconnectDelayMs } : {}),
    ...(wait ? { wait } : {}),
  });
}

/** The reconnect delay after `attempt` consecutive failures. */
export function dingtalkReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return ingressReconnectDelayMs(attempt, baseMs, maxMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-exported so the wiring layer names the same inbound type as its siblings. */
export type DingtalkInboundMessage = InboundMessage;
export type DingtalkSocket = IngressSocket;
