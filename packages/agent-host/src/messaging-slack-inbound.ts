import type { InboundMessage, MessagingInboundPushTransport } from "./messaging-inbound.js";

/**
 * The inbound Slack channel over Socket Mode (ADR 0326, rollout R3).
 *
 * Slack's incoming direction is a *push*: the platform delivers events
 * to a WebSocket the client opens. Socket Mode is the shape that keeps the
 * acceptance precondition — "no inbound port is open on the Host machine" —
 * true, because the connection is one the Host *originates* to Slack, exactly
 * as the Telegram long poll is an outbound HTTPS request. There is no listener,
 * no bound port, and no accepting socket here, and there is no public Events
 * API callback.
 *
 * # What this module is
 *
 * It is the client half of the inbound path, and nothing else. It:
 *
 * 1. performs the Socket Mode handshake — `apps.connections.open` with the
 *    app-level token, then a WebSocket client connection to the returned URL;
 * 2. unwraps each `events_api` envelope's `event_callback` payload;
 * 3. applies strict filters (a bot id, any subtype other than the plain message
 *    case, and any channel type outside the allowed set are ignored) because
 *    Socket Mode input is externally reachable and untrusted;
 * 4. keeps a restart-durable replay guard keyed on the platform's own event id,
 *    so a redelivery Slack sends after a restart is recognised and not acted on
 *    twice;
 * 5. acknowledges each envelope **only after** the message has been handled and
 *    durably recorded — at-least-once with dedupe, never at-most-once with loss.
 *
 * The command vocabulary, the link, the principal and the four Host operations
 * are all the existing driver's (`messaging-inbound.ts`); this module produces a
 * neutral [`InboundMessage`] and hands it to that one routing path through a
 * [`MessagingInboundPushTransport`]. It performs no mapping, no admission, and
 * no permission policy of its own.
 *
 * # Trust boundary and the credential
 *
 * The app-level token is a bearer credential for `apps.connections.open`; it is
 * never placed in a URL, never logged, and never appears in an error this module
 * reports. The WebSocket URL the platform returns is used as given. Everything
 * arriving over the socket is untrusted and is validated field by field before
 * any of it reaches the driver.
 *
 * # Testability without a network
 *
 * The two seams that would otherwise need a live Slack — the
 * `apps.connections.open` call and the WebSocket client — are injected
 * ([`SlackOpenConnection`] and [`SlackSocketFactory`]). A suite drives the client
 * with a fake of each, so both a successful handshake and a rejected one are
 * reproducible, and no test opens a socket.
 */

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

/**
 * The settings-backed replay guard moved to its own module
 * (`messaging-slack-store.ts`) to keep this client module focused; the constant
 * it shares lives here.
 */

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
export interface SlackSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

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
  | { accepted: true; message: InboundMessage }
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

/** One `events_api` envelope, already checked down to the fields this module reads. */
type SlackEnvelope = {
  envelopeId: string;
  eventId: string;
  event: unknown;
};

/**
 * Unwrap one `events_api` envelope down to its `event_callback` payload.
 *
 * Returns `null` (with a reason) for anything this module cannot process: an
 * envelope with no string id (nothing to ack), a payload that is not an
 * `event_callback`, or a payload with no event. The event id Slacks provides is
 * carried out as the replay key; when it is absent the envelope id stands in,
 * so a redelivery is still recognised.
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
 * The Socket Mode client: handshake, envelope unwrap, strict filters, the
 * restart-durable replay guard, and the ack discipline.
 *
 * It is deliberately small and side-effect-limited so a suite can drive it
 * frame by frame through the two injected seams. It never opens a listener and
 * never touches Host state.
 */
export class SlackSocketModeClient {
  private readonly options: SlackSocketModeClientOptions;
  private readonly allowed: readonly string[];
  private readonly audit: SlackInboundAudit;
  private socket: SlackSocket | null = null;
  private ready = false;
  private closed = false;
  private closeWaiters: Array<() => void> = [];

  constructor(options: SlackSocketModeClientOptions) {
    this.options = options;
    this.allowed = options.allowedChannelTypes ?? SLACK_DEFAULT_ALLOWED_CHANNEL_TYPES;
    this.audit = options.audit ?? (() => {});
  }

  /** Whether a `hello` frame has been seen on the current connection. */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Perform the Socket Mode handshake: open a connection with the app-level
   * token, then open the WebSocket to the URL the platform returns.
   *
   * A refused `apps.connections.open` (a bad token, a network failure) is
   * audited and thrown, so the caller's reconnect loop owns the retry; no socket
   * is opened in that case. On success the socket is opened and every frame it
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
    const socket = this.options.connect(result.url);
    this.socket = socket;
    socket.onMessage((data) => {
      void this.handleFrame(data);
    });
    socket.onClose((code, reason) => {
      this.finishClose(reason ?? (code !== undefined ? `closed (${code})` : "closed"));
    });
    socket.onError((error) => {
      this.audit({ kind: "connect-failed", error: error instanceof Error ? error.message : String(error) });
      // An `error` is normally followed by a `close`, but if the platform emits
      // one without the other the reconnect loop would sit in `waitForClose`
      // until abort. End the wait here as well, so the loop is never stalled;
      // the following `close` (when there is one) is a no-op because
      // `finishClose` is idempotent.
      this.finishClose(error instanceof Error ? error.message : String(error));
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

  /** Close the socket and mark the client closed. */
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
      // A socket that throws on close is already gone; there is nothing to do.
    }
    this.socket = null;
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Route one raw socket frame by its Slack envelope type. */
  async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed-envelope", reason: "frame is not JSON" });
      return;
    }
    if (!isRecord(parsed)) {
      this.audit({ kind: "malformed-envelope", reason: "frame is not an object" });
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "hello") {
      this.ready = true;
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
    this.audit({ kind: "malformed-envelope", reason: `unknown envelope type "${type}"` });
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
      this.audit({ kind: "malformed-envelope", reason: unwrapped.reason });
      // Nothing to ack if there is no id; otherwise ack so the platform stops
      // redelivering a frame this path will never process.
      const id = typeof envelope.envelope_id === "string" ? envelope.envelope_id : "";
      if (id) this.ack(id);
      return;
    }
    const { envelopeId, eventId, event } = unwrapped.value;

    const classification = classifySlackMessageEvent(event, this.allowed);
    if (!classification.accepted) {
      const channelId = isRecord(event) && typeof event.channel === "string" ? event.channel : undefined;
      this.audit({ kind: "filtered", reason: classification.reason, ...(channelId ? { channelId } : {}) });
      // A filtered event is not this path's to act on; ack it so Slack does not
      // redeliver it forever. It is never recorded — a filtered event leaves no
      // trace in the durable guard.
      this.ack(envelopeId);
      return;
    }

    // The restart-durable replay guard: a redelivery (including one across a
    // restart) is acked without being handled again.
    let alreadyHandled: boolean;
    try {
      alreadyHandled = await this.options.handled.has(eventId);
    } catch {
      alreadyHandled = false;
    }
    if (alreadyHandled) {
      this.audit({ kind: "duplicate", eventId });
      this.ack(envelopeId);
      return;
    }

    // Handle first; a failure here leaves the envelope unacked so Slack
    // redelivers it rather than the command being lost.
    try {
      await this.options.onMessage(classification.message);
    } catch (error) {
      this.audit({
        kind: "process-failed",
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Record durably, and only then ack. If the record fails, the envelope stays
    // unacked: a crash now would let Slack redeliver, and the guard that would
    // have recognised the redelivery was never written, so the message is
    // re-applied rather than silently dropped.
    try {
      await this.options.handled.record(eventId);
    } catch (error) {
      this.audit({
        kind: "record-failed",
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.audit({ kind: "processed", eventId });
    this.ack(envelopeId);
  }

  private ack(envelopeId: string): void {
    try {
      this.socket?.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch {
      // The socket is gone; the platform will redeliver on the next connection.
    }
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

/** The least the loop waits before reconnecting, so a flapping socket cannot spin it. */
const MIN_RECONNECT_DELAY_MS = 1_000;

/**
 * The most the loop waits between attempts. Without a cap a permanently bad
 * token would back off without bound (minutes, then hours) and a token fixed
 * while the Host runs would not be picked up for that long; with the cap it
 * retries at most every 30s, so a repaired credential is live again quickly.
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * The reconnect delay after `attempt` consecutive failures (`attempt` 0 is the
 * first failure): exponential from `baseMs`, capped at `maxMs`, with equal
 * jitter — the value is drawn from [d/2, d] where `d` is the capped
 * exponential. The jitter keeps a fleet of Hosts from retrying a down platform
 * in lockstep; equal jitter is chosen over full jitter because it keeps the
 * sequence non-decreasing (the next exponential is twice the current, so its
 * floor is the current ceiling), which both avoids a retry that is shorter than
 * the last and makes the escalation testable without pinning the random source.
 */
export function slackReconnectDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const half = exponential / 2;
  return Math.round(half + half * Math.random());
}

/**
 * The production push transport: it opens a Socket Mode connection, serves its
 * frames through [`SlackSocketModeClient`], and reconnects until `signal`
 * aborts.
 *
 * The driver hands `start` the one handler its routing path uses
 * ([`MessagingInboundDriver::handleMessage`]); the transport binds that as the
 * client's `onMessage`, so a Slack message and a Telegram message go through the
 * same routing path and no second one exists. A refused handshake, a socket
 * error, and a platform `disconnect` all leave the loop to wait and reconnect,
 * so an unreachable platform can neither take the Host down nor spin the CPU.
 * The wait is exponential from the first delay up to a cap, with jitter, so a
 * permanently bad token settles at the cap instead of hammering the platform
 * once a second; a connection whose handshake was accepted resets the back-off,
 * so a healthy channel reconnects at the base delay.
 */
export function createSlackInboundPushTransport(
  options: SlackInboundTransportOptions,
): MessagingInboundPushTransport {
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = Math.max(MIN_RECONNECT_DELAY_MS, options.reconnectDelayMs ?? MIN_RECONNECT_DELAY_MS);
  const max = Math.max(base, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  return {
    async start(onMessage, signal) {
      let failures = 0;
      while (!signal?.aborted) {
        const client = new SlackSocketModeClient({ ...options.client, onMessage });
        let established = false;
        try {
          await client.connect();
          established = true;
          await client.waitForClose(signal);
        } catch {
          // A refused handshake or a failed connect: fall through to the wait
          // and try again. The client already audited the reason.
        } finally {
          client.close();
        }
        if (signal?.aborted) break;
        // A connection whose handshake was accepted is not the failure loop a
        // bad token is, so it resets the back-off to the base delay. A refused
        // handshake escalates the next delay.
        if (established) failures = 0;
        await wait(slackReconnectDelayMs(failures, base, max));
        if (!established) failures += 1;
      }
    },
  };
}

