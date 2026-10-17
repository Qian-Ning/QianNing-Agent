/**
 * The inbound Slack channel over Socket Mode — the adapter half only.
 *
 * Slack's incoming direction is a *push*: the platform delivers envelopes down a
 * websocket the Host opens. The connection is one the Host *originates*, so no
 * inbound port is bound, no listener is accepted, and no public Events API
 * callback is required (ADR 0326) — the acceptance precondition "no inbound port
 * is open on the Host machine" stays true.
 *
 * Everything a socket channel shares with its siblings lives in the shared
 * ingress layer: the connection lifecycle and the reconnect discipline
 * (`messaging-ingress-socket.ts`), and the replay-guard ordering, the audit sink
 * and the reply chunker (`messaging-ingress.ts`). This module supplies only what
 * is Slack's own:
 *
 * - **connect** — `apps.connections.open` with the app-level token, then the
 *   websocket to the URL it returns;
 * - **normalise** — [`normaliseSlackEvent`]: one `message` event, filtered to a
 *   plain human message in an allowed conversation type, projected onto the
 *   shared shape with the platform's event id as the replay key;
 * - **acknowledge** — an `events_api` envelope is acked only after the durable
 *   record, so a redelivery Slack sends after a restart is recognised and never
 *   acted on twice;
 * - **limit** — Slack's message size limit, declared for the shared chunker.
 *   Slack replies leave through host-core's sender, so this module declares the
 *   limit without growing a second send path.
 *
 * The command vocabulary, the link, the principal and the four Host operations
 * are the existing driver's (`messaging-inbound.ts`); this module produces a
 * neutral message and hands it to that one routing path through a
 * [`MessagingInboundPushTransport`]. It performs no mapping, no admission, and
 * no permission policy of its own.
 *
 * # Trust boundary and the credential
 *
 * The app-level token is a bearer credential for `apps.connections.open`; it is
 * never placed in a URL, never logged, and never appears in an error this module
 * reports. The websocket URL the platform returns is used as given. Everything
 * arriving over the socket is untrusted and is validated field by field before
 * any of it reaches the driver.
 *
 * # Testability without a network
 *
 * The two seams that would otherwise need a live Slack — `apps.connections.open`
 * and the websocket client — are injected ([`SlackOpenConnection`] and
 * [`SlackSocketFactory`]). A suite drives the client with a fake of each, so
 * both a successful handshake and a rejected one are reproducible, and no test
 * opens a socket.
 */

import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";
import {
  IngressGate,
  ingressReconnectDelayMs,
  type IngressAudit,
  type IngressMessage,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import { createSocketIngressTransport, SocketIngressClient } from "./messaging-ingress-socket.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";

/** The settings section the Slack channel's record lives in, inside `app`. */
export const MESSAGING_SLACK_SECTION = "messagingSlack";
/** The record's self-identifying format, beside the outbound channel's own. */
export const MESSAGING_SLACK_FORMAT = "pi-desktop-messaging-slack";
/** The record version this build reads. */
export const MESSAGING_SLACK_FORMAT_VERSION = 1;
/** Where the app-level token lives in the host's secret store. */
export const MESSAGING_SLACK_APP_TOKEN_SECRET_REF = "secret:messaging-slack:app-token";
/** The platform method that opens a Socket Mode connection. */
export const SLACK_CONNECTIONS_OPEN_METHOD = "apps.connections.open";

/** Slack's message size limit, in characters, for the shared reply chunker. */
export const SLACK_MESSAGE_LIMIT = 40_000;

/**
 * The channel types a message event may come from. Anything else — an app-home
 * event, an unknown or absent type — is refused, because the linked chat is a
 * real conversation and a message from anywhere else is not one this path may
 * act on.
 */
export const SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES: readonly string[] = ["channel", "group", "im", "mpim"];

/** The most event ids the settings-backed replay guard remembers before evicting the oldest. */
export const SLACK_HANDLED_CAPACITY = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings surface the settings-backed replay guard rides. */
export type SlackSettingsSurface = {
  read(): Promise<unknown>;
  write(patch: Record<string, unknown>): Promise<void>;
};

/**
 * The restart-durable replay guard. Keyed on the platform's own event id, which
 * Slack keeps stable across a redelivery. `has` answers whether an event has
 * already been acted on; `record` durably remembers one, and must not resolve
 * until the record would survive a restart — the ack waits on it.
 */
export interface SlackInboundHandledStore {
  has(eventId: string): Promise<boolean>;
  record(eventId: string): Promise<void>;
}

/** One audit record. Structure and ids only — never message text or a token. */
export type SlackInboundAuditEntry =
  | { kind: "auth-failed"; error: string }
  | { kind: "connect-failed"; error: string }
  | { kind: "disconnect"; reason: string }
  | { kind: "filtered"; reason: string; channelId?: string }
  | { kind: "malformed-envelope"; reason: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string }
  | { kind: "process-failed"; eventId: string; error: string }
  | { kind: "record-failed"; eventId: string; error: string };

export type SlackInboundAudit = (entry: SlackInboundAuditEntry) => void;

/**
 * The shared audit vocabulary expressed in Slack's published entry type.
 *
 * Which facts are recorded, and what a record may carry, is the shared layer's
 * decision; only the vocabulary is Slack's — `malformed` is this channel's
 * `malformed-envelope` and the id field is `eventId`.
 */
function slackAudit(sink?: SlackInboundAudit): IngressAudit {
  if (!sink) return () => {};
  return (entry) => {
    switch (entry.kind) {
      case "malformed":
        return sink({ kind: "malformed-envelope", reason: entry.reason });
      case "duplicate":
      case "processed":
        return sink({ kind: entry.kind, eventId: entry.eventId });
      case "process-failed":
      case "record-failed":
        return sink({ kind: entry.kind, eventId: entry.eventId, error: entry.error });
      case "auth-failed":
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
        // `identity-failed` and `heartbeat-missed` belong to other channels.
        return;
    }
  };
}

/** The answer to `apps.connections.open`: either the WSS URL, or the platform's refusal. */
export type SlackConnectionResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** The `apps.connections.open` call, injected so a suite needs no live Slack. */
export type SlackOpenConnection = (appToken: string) => Promise<SlackConnectionResult>;

/**
 * The minimal WebSocket client surface this module uses, so the client can be
 * driven by a fake. A production implementation wraps `ws`; the shape is
 * deliberately small — send a frame, close, and three event subscriptions.
 */
export type SlackSocket = IngressSocket;

/** Opens a WebSocket client connection to a URL; injected so a suite needs no socket. */
export type SlackSocketFactory = (url: string) => SlackSocket;

export type SlackSocketModeClientOptions = {
  /** The app-level token (`xapp-…`), used only for `apps.connections.open`. */
  appToken: string;
  /** The `apps.connections.open` seam. */
  openConnection: SlackOpenConnection;
  /** The WebSocket client-connection seam. */
  connect: SlackSocketFactory;
  /** The restart-durable replay guard; the ack waits on a `record` here. */
  handled: SlackInboundHandledStore;
  /** The neutral handler the driver's routing path provides. */
  onMessage: (message: InboundMessage) => Promise<void>;
  /** The channel types a message may come from; defaults to the real conversation types. */
  allowedChannelTypes?: readonly string[];
  /** Where audit records go; absent means they are dropped. */
  audit?: SlackInboundAudit;
};

/**
 * The outcome of classifying one `message` event against the strict filters.
 * A refusal carries a reason the caller audits; only `accepted` yields a message.
 */
type EventClassification =
  | { accepted: true; message: IngressMessage }
  | { accepted: false; reason: string };

/**
 * Apply the strict filters to one Slack `message` event and, if it survives,
 * project it onto the neutral message shape.
 *
 * Refused: anything that is not a `message` event; a message carrying a
 * `bot_id`; a message carrying any `subtype` (the plain message case has none,
 * so a `bot_message`, a `message_changed`, a `channel_join` and every other
 * subtype are all refused here); a message whose `channel_type` is absent or
 * outside the allowed set; and a message with no usable channel or timestamp.
 * The function never throws for untrusted input — a malformed field is a typed
 * refusal, not an exception.
 */
export function classifySlackMessageEvent(
  event: unknown,
  allowedChannelTypes: readonly string[],
): EventClassification {
  if (!isRecord(event)) return { accepted: false, reason: "event is not an object" };
  if (event.type !== "message") return { accepted: false, reason: "event type is not message" };
  // A plain message carries no subtype; every other shape is refused.
  if (event.subtype !== undefined && event.subtype !== null) {
    return { accepted: false, reason: "message carries a subtype" };
  }
  // A bot id means another app (or this one) produced it, never a person.
  if (event.bot_id !== undefined && event.bot_id !== null) {
    return { accepted: false, reason: "message carries a bot id" };
  }
  const channelType = typeof event.channel_type === "string" ? event.channel_type : "";
  if (!allowedChannelTypes.includes(channelType)) {
    return { accepted: false, reason: "channel type is not allowed" };
  }
  const chatId = typeof event.channel === "string" ? event.channel.trim() : "";
  if (!chatId) return { accepted: false, reason: "message names no channel" };
  const messageId = typeof event.ts === "string" ? event.ts.trim() : "";
  if (!messageId) return { accepted: false, reason: "message names no timestamp" };
  const text = typeof event.text === "string" ? event.text : "";
  return { accepted: true, message: { messageId, chatId, text } };
}

/**
 * Project one Slack `message` event onto the shared shape.
 *
 * Slack keeps the event id stable across a redelivery, so the replay key is the
 * event id rather than the message id: a redelivered envelope is recognised even
 * before its timestamp is re-read.
 */
export function normaliseSlackEvent(
  event: unknown,
  allowedChannelTypes: readonly string[],
  eventId: string,
): IngressNormalisation {
  const classification = classifySlackMessageEvent(event, allowedChannelTypes);
  if (!classification.accepted) {
    const channelId = isRecord(event) && typeof event.channel === "string" ? event.channel : undefined;
    return { kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) };
  }
  return {
    kind: "message",
    message: classification.message,
    // The replay key is the platform's event id; a bare event (one the adapter
    // is handed without its envelope) falls back to the message's own timestamp,
    // which Slack also keeps stable across a redelivery.
    key: eventId.trim() || classification.message.messageId,
  };
}

/** One `events_api` envelope, already checked down to the fields this module reads. */
type SlackEnvelope = {
  envelopeId: string;
  eventId: string;
  event: unknown;
};

/**
 * Unwrap one `events_api` envelope down to its `event_callback` payload.
 *
 * Returns the reason for anything this module cannot process: an envelope with
 * no string id (nothing to ack), a payload that is not an `event_callback`, or a
 * payload with no event. The event id Slack provides is carried out as the
 * replay key; when it is absent the envelope id stands in, so a redelivery is
 * still recognised.
 */
function unwrapEnvelope(
  envelope: Record<string, unknown>,
): { ok: true; value: SlackEnvelope } | { ok: false; reason: string } {
  const envelopeId = typeof envelope.envelope_id === "string" ? envelope.envelope_id : "";
  if (!envelopeId) return { ok: false, reason: "envelope has no id" };
  const payload = envelope.payload;
  if (!isRecord(payload)) return { ok: false, reason: "envelope has no payload" };
  if (payload.type !== "event_callback") return { ok: false, reason: "payload is not an event_callback" };
  const event = payload.event;
  if (!isRecord(event)) return { ok: false, reason: "event_callback has no event" };
  const rawEventId = typeof payload.event_id === "string" ? payload.event_id.trim() : "";
  return { ok: true, value: { envelopeId, eventId: rawEventId || envelopeId, event } };
}

/**
 * The Socket Mode client: handshake, envelope unwrap, the strict filter, the
 * shared dedupe gate, and the ack discipline.
 *
 * The connection lifecycle (attach, readiness, close waiters) and the reconnect
 * policy are the shared socket layer's. This class is Slack's framing: which
 * envelope type means hello, which means reconnect, and which carries a message.
 */
export class SlackSocketModeClient extends SocketIngressClient {
  private readonly options: SlackSocketModeClientOptions;
  private readonly allowed: readonly string[];
  private readonly gate: IngressGate;

  constructor(options: SlackSocketModeClientOptions) {
    const audit = slackAudit(options.audit);
    super({ audit });
    this.options = options;
    this.allowed = options.allowedChannelTypes ?? SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES;
    this.gate = new IngressGate({ handled: options.handled, onMessage: options.onMessage, audit });
  }

  /**
   * Perform the Socket Mode handshake: open a connection with the app-level
   * token, then open the WebSocket to the URL the platform returns.
   *
   * A refused `apps.connections.open` (a bad token, a network failure) is
   * audited and thrown, so the caller's reconnect loop owns the retry; no socket
   * is opened in that case. On success the socket is adopted and every frame it
   * delivers is routed to [`handleFrame`].
   */
  async connect(): Promise<void> {
    const token = this.options.appToken.trim();
    if (!token) {
      const error = "the configured app-level token is empty";
      this.audit({ kind: "auth-failed", error });
      throw new Error(error);
    }
    const result = await this.options.openConnection(token);
    if (!result.ok) {
      this.audit({ kind: "auth-failed", error: result.error });
      throw new Error(`socket mode handshake refused: ${result.error}`);
    }
    this.attach(this.options.connect(result.url));
  }

  /** Route one raw socket frame by its Slack envelope type. */
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
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "hello") {
      this.markReady();
      return;
    }
    if (type === "disconnect") {
      const reason = typeof parsed.reason === "string" ? parsed.reason : "the platform asked to reconnect";
      this.finishClose(reason);
      return;
    }
    if (type === "events_api") {
      await this.handleEnvelope(parsed);
      return;
    }
    this.audit({ kind: "malformed", reason: `unknown envelope type "${type}"` });
  }

  /**
   * Handle one `events_api` envelope. The ack is sent exactly once and only
   * after the message has been handled *and* durably recorded — so an envelope
   * whose handling fails, or whose record fails, is left unacknowledged for the
   * platform to redeliver (at-least-once), and a duplicate that the durable
   * guard already knows is acked without being handled again.
   */
  private async handleEnvelope(envelope: Record<string, unknown>): Promise<void> {
    const unwrapped = unwrapEnvelope(envelope);
    if (!unwrapped.ok) {
      this.audit({ kind: "malformed", reason: unwrapped.reason });
      // Nothing to ack if there is no id; otherwise ack so the platform stops
      // redelivering a frame this path will never process.
      const id = typeof envelope.envelope_id === "string" ? envelope.envelope_id : "";
      if (id) this.ack(id);
      return;
    }
    const { envelopeId, eventId, event } = unwrapped.value;

    const normalisation = normaliseSlackEvent(event, this.allowed, eventId);
    if (normalisation.kind !== "message") {
      this.audit({
        kind: "filtered",
        reason: normalisation.reason,
        ...(normalisation.channelId ? { channelId: normalisation.channelId } : {}),
      });
      // A filtered event is not this path's to act on; ack it so Slack does not
      // redeliver it forever. It is never recorded — a filtered event leaves no
      // trace in the durable guard.
      this.ack(envelopeId);
      return;
    }

    // The gate consults the durable guard, handles, records, then acks — in that
    // order, so a redelivery across a restart is recognised and a failure leaves
    // the envelope for Slack to redeliver.
    await this.gate.ingest(normalisation.message, normalisation.key, () => this.ack(envelopeId));
  }

  private ack(envelopeId: string): void {
    this.send({ envelope_id: envelopeId });
  }
}

/** How the production push transport reaches the platform. */
export type SlackInboundTransportOptions = {
  /** Everything the client needs except `onMessage`, which the transport binds. */
  client: Omit<SlackSocketModeClientOptions, "onMessage">;
  /** The first reconnect delay; the loop doubles it per failure up to the cap. */
  reconnectDelayMs?: number;
  /** The most the loop waits between attempts, however many have failed. */
  maxReconnectDelayMs?: number;
  /** How the loop waits; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * The reconnect delay after `attempt` consecutive failures: the shared jittered,
 * capped exponential ([`ingressReconnectDelayMs`]). Kept as this channel's named
 * export because its escalation is part of the channel's contract.
 */
export function slackReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return ingressReconnectDelayMs(attempt, baseMs, maxMs);
}

/**
 * The Slack ingress adapter: the platform-specific seams and nothing else.
 *
 * `openClient` builds one client per connection attempt; the shared transport
 * owns the reconnect loop, the back-off and the one-subscription-per-attempt
 * rule. This object is what the conformance suite runs against, and what the
 * next socket channel is compared with.
 */
export function createSlackIngressAdapter(
  options: Omit<SlackSocketModeClientOptions, "onMessage">,
): SocketIngressAdapter {
  const allowed = options.allowedChannelTypes ?? SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES;
  return {
    platform: "slack",
    kind: "socket",
    messageLimit: SLACK_MESSAGE_LIMIT,
    normalise: (raw) => normaliseSlackEvent(raw, allowed, ""),
    openClient: (onMessage) => new SlackSocketModeClient({ ...options, onMessage }),
  };
}

/**
 * The production push transport: a Socket Mode connection served through
 * [`SlackSocketModeClient`], reconnected until `signal` aborts.
 *
 * The driver hands `start` the one handler its routing path uses; the transport
 * binds that as the client's `onMessage`, so a Slack message and a Telegram
 * message go through the same routing path and no second one exists. A refused
 * handshake, a socket error and a platform `disconnect` all leave the loop to
 * wait and reconnect, so an unreachable platform can neither take the Host down
 * nor spin it.
 */
export function createSlackInboundPushTransport(
  options: SlackInboundTransportOptions,
): MessagingInboundPushTransport {
  return createSocketIngressTransport(createSlackIngressAdapter(options.client), {
    ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
    ...(options.maxReconnectDelayMs !== undefined
      ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
      : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
