/**
 * The inbound webhook receiver: one HTTP surface for every callback-shaped
 * channel.
 *
 * Ten of the messaging channels this product will carry share a shape the
 * current nine do not: the platform POSTs an event to a public HTTPS endpoint
 * this Host runs. Google Chat, LINE, Microsoft Teams, Feishu, DingTalk, WeCom
 * (group and app), WhatsApp Cloud API, Twilio SMS and generic webhooks all work
 * that way, and each one needs the same five things done correctly:
 *
 * 1. authenticate the request against the bytes that arrived, before parsing;
 * 2. refuse a timestamp outside a window, and a delivery id already seen;
 * 3. answer fast, then process — a platform that waits on the turn retries, and
 *    a retry storm is the usual way a webhook integration duplicates commands;
 * 4. cap the body before buffering it, so one large POST cannot exhaust memory;
 * 5. dedupe against the same store the rest of the ingress layer uses.
 *
 * This module owns those five, once, and a channel supplies only its verifier
 * ([`IngressVerifier`](./messaging-ingress-verify.js)) and its adapter. The
 * moment one of them is written per platform, at least one of the five is
 * written wrongly — so they are written here.
 *
 * # This is a mechanism, not a channel
 *
 * No platform is added by this module. There is no catalogue entry and no
 * settings section for a named product; the suite proves the mechanism with a
 * generic platform, and each of the ten becomes a verifier plus a projection.
 *
 * # Loopback by default, and what that means
 *
 * The listener binds `127.0.0.1` unless the caller passes a non-loopback
 * address **and** sets `allowNonLoopback`. A receiver exposed to the network by
 * accident is worse than one that needs configuring, so the wider bind is an
 * explicit opt-in that a settings switch can own.
 *
 * A loopback listener cannot be reached from the internet. Every one of the ten
 * platforms needs a public HTTPS endpoint, and this module does not provide
 * one: the honest deployment is either a reverse proxy on a public host that
 * forwards to this port, or a tunnel that exposes it. Neither is implemented
 * here, and the settings copy and the runtime spec say so in the same words.
 *
 * # What the receiver does not do
 *
 * It does not start itself. A composition root decides whether a receiver
 * listens, from the settings section this module's reader returns; an install
 * that configures nothing binds no port, so the product's "no inbound listener"
 * default is unchanged.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  IngressClaimLog,
  ingressAudit,
  ingressErrorMessage,
  type IngressAudit,
  type IngressHandledStore,
  type IngressMessage,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import {
  type IngressVerification,
  type IngressVerifier,
  type IngressVerifierHeaders,
} from "./messaging-ingress-verify.js";
import { WebhookIngressTransport } from "./messaging-ingress-webhook.js";

/** The path prefix each platform's endpoint lives under: `/webhooks/<platform>`. */
export const INGRESS_WEBHOOK_PATH_PREFIX = "/webhooks";

/** The address the receiver binds unless a caller deliberately chooses another. */
export const INGRESS_WEBHOOK_DEFAULT_HOST = "127.0.0.1";

/** The port the receiver binds when the settings section names none. */
export const INGRESS_WEBHOOK_DEFAULT_PORT = 8787;

/** The most body bytes accepted unless the settings section names a cap. */
export const INGRESS_WEBHOOK_DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * How old a signed timestamp may be, and how far in the future, before the
 * request is refused. 300 seconds is the window most callback platforms
 * document; it bounds the replay of a captured request that carried a valid
 * signature.
 */
export const INGRESS_WEBHOOK_DEFAULT_REPLAY_WINDOW_MS = 300_000;

/** The most delivery ids the in-run claim log remembers. */
export const INGRESS_WEBHOOK_DEFAULT_CLAIM_CAPACITY = 4_096;

/** The settings section the receiver's own configuration lives under. */
export const INGRESS_WEBHOOK_RECEIVER_SECTION = "messagingWebhookReceiver";

/** The secret ref a receiver reads its shared signing secret from by default. */
export const INGRESS_WEBHOOK_SECRET_REF = "secret:messaging-webhooks:signing-secret";

/** One channel served by the receiver. */
export type IngressWebhookPlatform = {
  /** How this platform authenticates a request, in its own scheme. */
  verifier: IngressVerifier;
  /** How one raw event projects onto the shared inbound shape. */
  adapter: WebhookIngressAdapter;
  /** Where an accepted message goes; the routing path provides this. */
  onMessage: (message: IngressMessage) => Promise<void>;
};

export type IngressWebhookReceiverOptions = {
  /**
   * The channels served, keyed by the path segment they live under. The name
   * is the platform's own (`google-chat`, `line`, `teams`, …) and appears in
   * this Host's audit records only; it is never echoed in a response.
   */
  platforms: Readonly<Record<string, IngressWebhookPlatform>>;
  /**
   * The restart-durable store the delivery ids and the messages are deduped
   * against. It is the same [`IngressHandledStore`] the gate uses — the
   * receiver adds a namespaced key per delivery, not a second store.
   */
  handled: IngressHandledStore;
  /** The port to listen on; `0` asks the OS for one. Defaults to 8787. */
  port?: number;
  /** The address to bind; defaults to `127.0.0.1`. */
  host?: string;
  /**
   * Whether a non-loopback bind address is permitted. Defaults to false, and a
   * non-loopback address without it is refused rather than silently narrowed:
   * a caller that asked for `0.0.0.0` and got `127.0.0.1` would ship a receiver
   * its platform cannot reach and never learn why.
   */
  allowNonLoopback?: boolean;
  /** The largest body accepted, in bytes; larger requests are refused unread. */
  maxBodyBytes?: number;
  /** How far a signed timestamp may be from now, in either direction. */
  replayWindowMs?: number;
  /** The most delivery ids the in-run claim log remembers. */
  claimCapacity?: number;
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
  /** The clock, for the replay window; defaults to `Date.now`. */
  now?: () => number;
};

/** What `start` resolved: the address actually bound, not the one asked for. */
export type IngressWebhookAddress = { host: string; port: number };

/** One platform, with the transport the receiver drives for it. */
type RegisteredPlatform = {
  name: string;
  verifier: IngressVerifier;
  transport: WebhookIngressTransport;
};

/** The four numbers the receiver's own settings section carries, clamped. */
export type IngressWebhookReceiverSettings = {
  enabled: boolean;
  port: number;
  bindAddress: string;
  allowNonLoopback: boolean;
  secretRef: string;
  replayWindowMs: number;
  maxBodyBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number inside `[min, max]`, or `fallback` when absent or unusable. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Read the receiver's own settings section, or `null` when it is absent or off.
 *
 * Absent and `enabled: false` both mean "do not listen": an install that has
 * configured no receiver binds no port, which keeps the Host's default "no
 * inbound listener" behaviour intact. Every value is clamped to a range the
 * receiver can honour, so a hand-edited settings row cannot ask for a port of
 * `-1` or a replay window of a year.
 */
export function readIngressWebhookReceiverSettings(
  settings: unknown,
  sectionKey: string = INGRESS_WEBHOOK_RECEIVER_SECTION,
): IngressWebhookReceiverSettings | null {
  if (!isRecord(settings)) return null;
  const section = settings[sectionKey];
  if (!isRecord(section) || section.enabled !== true) return null;
  const bindAddress =
    typeof section.bindAddress === "string" && section.bindAddress.trim()
      ? section.bindAddress.trim()
      : INGRESS_WEBHOOK_DEFAULT_HOST;
  const secretRef =
    typeof section.secretRef === "string" && section.secretRef.trim()
      ? section.secretRef.trim()
      : INGRESS_WEBHOOK_SECRET_REF;
  return {
    enabled: true,
    port: clampNumber(section.port, 1, 65_535, INGRESS_WEBHOOK_DEFAULT_PORT),
    bindAddress,
    allowNonLoopback: section.allowNonLoopback === true,
    secretRef,
    replayWindowMs: clampNumber(
      section.replayWindowSeconds,
      1,
      3_600,
      INGRESS_WEBHOOK_DEFAULT_REPLAY_WINDOW_MS / 1000,
    ) * 1000,
    maxBodyBytes: clampNumber(
      section.maxBodyBytes,
      1_024,
      8 * 1024 * 1024,
      INGRESS_WEBHOOK_DEFAULT_MAX_BODY_BYTES,
    ),
  };
}

/**
 * Whether an address is one only this machine can reach.
 *
 * Deliberately the exact spellings, not a prefix and not a DNS lookup: a name
 * like `127.0.0.1.example.com` resolves wherever its owner says, so treating it
 * as loopback would be the accident this default exists to prevent.
 */
export function isLoopbackBindAddress(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

/** Higher-priority header wins; a repeated header is not a signature. */
function lowercaseHeaders(headers: IncomingHttpHeaders): IngressVerifierHeaders {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value ?? undefined;
  }
  return out;
}

type BodyRead = { ok: true; body: Buffer } | { ok: false; reason: "too-large" | "aborted" };

/**
 * Read a request body, capped.
 *
 * The declared `content-length` is checked first: a request that announces more
 * than the cap is refused without a byte of its body being read, which is the
 * case that matters — an attacker chooses the length it announces. A chunked
 * request has no declared length, so the running total is checked as chunks
 * arrive; the moment it crosses the cap the read stops and the collected bytes
 * are dropped, so the most memory one request can occupy is the cap plus one
 * chunk.
 */
function readBody(req: IncomingMessage, max: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const declared = req.headers["content-length"];
    if (typeof declared === "string") {
      const size = Number(declared);
      if (Number.isFinite(size) && size > max) {
        resolve({ ok: false, reason: "too-large" });
        return;
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        // Stop pulling bytes off the socket. The caller answers 413 and closes.
        req.pause();
        finish({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false, reason: "aborted" }));
    req.on("aborted", () => finish({ ok: false, reason: "aborted" }));
  });
}

/**
 * The receiver: an HTTP server over node's own `http`, no dependency.
 *
 * `start` binds and resolves the address; `stop` stops accepting and closes the
 * connections it holds. A delivery already accepted keeps processing after
 * `stop`, because its turn has been promised a 200 and dropping it would lose
 * the command.
 */
export class IngressWebhookReceiver {
  private readonly platforms: ReadonlyMap<string, RegisteredPlatform>;
  private readonly handled: IngressHandledStore;
  private readonly audit: IngressAudit;
  private readonly claims: IngressClaimLog;
  private readonly now: () => number;
  private readonly port: number;
  private readonly host: string;
  private readonly allowNonLoopback: boolean;
  private readonly maxBodyBytes: number;
  private readonly replayWindowMs: number;
  private server: Server | null = null;
  private bound: IngressWebhookAddress | null = null;

  constructor(options: IngressWebhookReceiverOptions) {
    const entries = Object.entries(options.platforms);
    if (entries.length === 0) {
      throw new Error("a webhook receiver needs at least one platform");
    }
    const registered = new Map<string, RegisteredPlatform>();
    const audit = ingressAudit(options.audit);
    for (const [name, platform] of entries) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        throw new Error(`"${name}" is not a usable webhook platform path segment`);
      }
      registered.set(name, {
        name,
        verifier: platform.verifier,
        transport: new WebhookIngressTransport(platform.adapter, {
          handled: options.handled,
          onMessage: platform.onMessage,
          audit,
        }),
      });
    }
    this.platforms = registered;
    this.handled = options.handled;
    this.audit = audit;
    this.claims = new IngressClaimLog(
      Math.max(1, Math.floor(options.claimCapacity ?? INGRESS_WEBHOOK_DEFAULT_CLAIM_CAPACITY)),
    );
    this.now = options.now ?? (() => Date.now());
    this.port = options.port ?? INGRESS_WEBHOOK_DEFAULT_PORT;
    this.host = options.host ?? INGRESS_WEBHOOK_DEFAULT_HOST;
    this.allowNonLoopback = options.allowNonLoopback === true;
    this.maxBodyBytes = Math.max(1, Math.floor(options.maxBodyBytes ?? INGRESS_WEBHOOK_DEFAULT_MAX_BODY_BYTES));
    this.replayWindowMs = Math.max(1, Math.floor(options.replayWindowMs ?? INGRESS_WEBHOOK_DEFAULT_REPLAY_WINDOW_MS));
  }

  /** The address bound, or `null` before `start` and after `stop`. */
  address(): IngressWebhookAddress | null {
    return this.bound;
  }

  /**
   * Bind and listen.
   *
   * A non-loopback address without `allowNonLoopback` is a construction error
   * the caller must see, so it throws instead of narrowing the bind.
   */
  async start(): Promise<IngressWebhookAddress> {
    if (this.server) throw new Error("the webhook receiver is already listening");
    if (!isLoopbackBindAddress(this.host) && !this.allowNonLoopback) {
      throw new Error(
        `refusing to bind ${this.host}: the webhook receiver binds loopback unless allowNonLoopback is set`,
      );
    }
    const server = createServer((req, res) => {
      void this.route(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    }).catch((error: unknown) => {
      server.close();
      throw error;
    });
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the webhook receiver bound an address it cannot describe");
    }
    this.bound = { host: address.address, port: address.port };
    return this.bound;
  }

  /** Stop accepting; close the connections held. In-flight turns keep running. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.bound = null;
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    await closed;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch {
      // A failure here is this Host's, not the caller's; the platform is told
      // only that the request could not be served, and retries.
      if (!res.headersSent) this.respond(res, 500, { error: "unavailable" });
      else res.destroy();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.respond(res, 405, { error: "method not allowed" });
      return;
    }
    const platform = this.matchPlatform(req.url);
    if (!platform) {
      // One answer for every unknown path: the platform list is not a thing to
      // publish, and the path itself is not echoed back.
      this.audit({ kind: "rejected", reason: "unknown-path" });
      this.respond(res, 404, { error: "not found" });
      return;
    }

    const read = await readBody(req, this.maxBodyBytes);
    if (!read.ok) {
      if (read.reason === "aborted") {
        // The caller went away; there is nobody to answer.
        this.respond(res, 400, { error: "the request ended early" });
        return;
      }
      this.audit({ kind: "rejected", reason: "body-too-large" });
      this.respond(res, 413, { error: "payload too large" });
      // The body was never read, so the connection cannot be reused.
      res.once("finish", () => req.destroy());
      return;
    }

    let verification: IngressVerification;
    try {
      verification = await platform.verifier.verify(read.body, lowercaseHeaders(req.headers));
    } catch (error) {
      this.audit({ kind: "auth-failed", error: ingressErrorMessage(error) });
      this.respond(res, 401, { error: "unauthorized" });
      return;
    }
    if (!verification.ok) {
      this.audit({ kind: "auth-failed", error: verification.reason });
      this.respond(res, 401, { error: "unauthorized" });
      return;
    }

    if (Math.abs(this.now() - verification.timestampMs) > this.replayWindowMs) {
      // A valid signature over a stale timestamp is a replayed capture, not a
      // tampered one: refused here, never handed to a handler.
      this.audit({ kind: "rejected", reason: "stale-timestamp" });
      this.respond(res, 401, { error: "unauthorized" });
      return;
    }

    const deliveryKey = this.deliveryKey(platform.name, verification.deliveryId);
    if (this.claims.has(deliveryKey)) {
      this.audit({ kind: "duplicate", eventId: deliveryKey });
      this.respond(res, 200, { ok: true });
      return;
    }
    // Claim synchronously, before the first await: two copies of one delivery
    // arriving together are both in this process, and only a synchronous claim
    // closes that window.
    this.claims.record(deliveryKey);

    let seen = false;
    try {
      seen = await this.handled.has(deliveryKey);
    } catch {
      // A guard that cannot be read is treated as "not seen", which is the only
      // failure direction that cannot lose a command.
      seen = false;
    }
    if (seen) {
      this.audit({ kind: "duplicate", eventId: deliveryKey });
      this.respond(res, 200, { ok: true });
      return;
    }
    try {
      await this.handled.record(deliveryKey);
    } catch (error) {
      // The delivery was accepted and is about to be processed; failing the
      // record leaves a gap a restart could replay, so it is reported rather
      // than allowed to turn an accepted delivery into a 500 the platform will
      // retry into a duplicate turn.
      this.audit({ kind: "record-failed", eventId: deliveryKey, error: ingressErrorMessage(error) });
    }

    // Answer now, then process. `handle` is deliberately not awaited: the
    // platform's retry policy reads this status, and a turn takes far longer
    // than a webhook deadline. The gate inside the transport still records the
    // message durably before it considers the delivery done.
    this.respond(res, 200, { ok: true });
    this.process(platform, read.body, deliveryKey);
  }

  private process(platform: RegisteredPlatform, rawBody: Buffer, deliveryKey: string): void {
    // The string is derived from exactly the bytes that were verified above.
    const body = rawBody.toString("utf8");
    void platform.transport.handle({ body }).catch((error: unknown) => {
      this.audit({
        kind: "process-failed",
        eventId: deliveryKey,
        error: ingressErrorMessage(error),
      });
    });
  }

  /**
   * The exact path form: `<prefix>/<platform>`, nothing else.
   *
   * A trailing slash, a deeper path and a query string all fail to match, so
   * `/webhooks/line/../admin` is an unknown path rather than a route.
   */
  private matchPlatform(url: string | undefined): RegisteredPlatform | null {
    const path = (url ?? "").split("?")[0] ?? "";
    const prefix = `${INGRESS_WEBHOOK_PATH_PREFIX}/`;
    if (!path.startsWith(prefix)) return null;
    const name = path.slice(prefix.length);
    if (!name || name.includes("/")) return null;
    return this.platforms.get(name) ?? null;
  }

  /**
   * The dedupe key for one delivery, in the store the gate already uses.
   *
   * The namespace keeps a delivery id from colliding with the message key the
   * gate writes (`chatId\0messageId`), so one store carries both orderings
   * without either misreading the other's entries.
   */
  private deliveryKey(platform: string, deliveryId: string): string {
    return `webhook\u0000${platform}\u0000${deliveryId}`;
  }

  /** Answer with JSON, and never with anything the request supplied. */
  private respond(res: ServerResponse, status: number, body?: Record<string, unknown>): void {
    if (res.headersSent) return;
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
