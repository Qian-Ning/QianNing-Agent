/**
 * The local API channel: one loopback HTTP endpoint that lets another program
 * on this machine talk to the agent the way a chat platform does.
 *
 * # What it is
 *
 * `POST /v1/message` takes `{ "message": "…", "conversationId": "…"? }` and
 * answers `{ "reply": "…" }` once the agent's turn has finished. `GET /health`
 * answers `{ "ok": true }`. There is no other route: a REST surface nobody
 * asked for is a surface nobody reviews.
 *
 * This is **not** a webhook and not a public endpoint. It is a local API: the
 * listener belongs to this app, on this machine, for a program the person runs
 * beside it. Nothing here is designed to be reachable from a network, and the
 * copy in the panel says "local API", never "callback", "public URL" or
 * "expose".
 *
 * # Loopback only, and why the opt-in is not enough
 *
 * The default bind address is `127.0.0.1`. The record may name another
 * address, but a non-loopback bind needs both `allowNonLoopback: true` **and**
 * a transport that can carry the token safely. This module speaks plain HTTP
 * only, so a non-loopback address is refused outright even with the opt-in:
 * putting the bearer token on an unencrypted interface is the exact mistake the
 * token exists to prevent. The two refusals are distinct messages, so a person
 * who set the opt-in learns that the remaining obstacle is TLS, not another
 * switch.
 *
 * # The token is the identity
 *
 * A token is mandatory. Absent, empty or wrong is `401` and the agent is never
 * reached — "it came from loopback" is not authentication, because every
 * process on the machine can reach loopback. The token is compared in constant
 * time over SHA-256 digests: hashing first makes the comparison
 * length-independent as well as byte-independent, so neither a wrong length nor
 * a wrong first byte is measurable from the response time.
 *
 * There is deliberately **no caller allowlist**. The token is one credential
 * for one program (or one operator's scripts); a second list of who may call
 * would be a second, overlapping identity mechanism, and the two would disagree
 * the moment either was edited. The panel says this instead of offering a list.
 *
 * # Bounded requests
 *
 * - **Body**: a declared `content-length` over the cap is refused before a byte
 *   is read; a chunked body is counted as it arrives and refused the moment the
 *   running total crosses the cap. The most memory one request can hold is the
 *   cap plus one chunk. A body must also arrive within
 *   [`API_SERVER_BODY_READ_TIMEOUT_MS`]: the cap bounds size, that bound stops a
 *   trickle from holding the socket.
 * - **Time**: one request may occupy the agent for at most
 *   [`ApiServerSettings.requestTimeoutMs`]. Past that the caller gets `504`; the
 *   reply that arrives later is dropped.
 * - **Concurrency**: at most [`ApiServerSettings.maxConcurrent`] requests are
 *   in flight. The next one gets `429` with `retry-after: 1` instead of being
 *   queued without a bound.
 *
 * # A port clash is a visible failure
 *
 * `start()` rejects with the address that could not be bound and the operating
 * system's own reason (`EADDRINUSE`). Nothing is left half-bound: the server
 * object is closed before the rejection propagates, and `address()` stays
 * `null`. The wiring reports the reason to the gateway registry, which is what
 * the panel shows. Silently moving to another port would make a program that
 * was told port 7842 fail in a way nobody can see.
 *
 * # Lifecycle
 *
 * This class binds nothing in its constructor. `start()` is the only place a
 * port is taken, and the supervisor calls it only from a record that exists,
 * is this build's format, and is enabled. `stop()` closes the listener and the
 * connections it holds; an in-flight turn is not cancelled, it simply has
 * nowhere to answer.
 *
 * # Streaming
 *
 * There is none, deliberately. The reply is written once, when the turn ends:
 * the agent surface this channel is handed resolves with text, and inventing a
 * second event-stream protocol for one local caller would be a larger surface
 * than the endpoint itself. A caller that needs progress can poll its own
 * session through the same token on a later version; this build does not
 * pretend to stream.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

// The loopback rule is the shared inbound receiver's, deliberately: one
// definition of "only this machine can reach it" for every listener in this
// package, rather than two that can drift.
import { isLoopbackBindAddress } from "./messaging-ingress-receiver.js";

/** The settings section this channel's record lives in, inside `app`. */
export const MESSAGING_API_SERVER_SECTION = "messagingApiServer";
/** The record's self-identifying format. */
export const MESSAGING_API_SERVER_FORMAT = "pi-desktop-messaging-api-server";
/** The record version this build reads. */
export const MESSAGING_API_SERVER_FORMAT_VERSION = 1;
/** Where the caller's bearer token lives in the host's secret store. */
export const MESSAGING_API_SERVER_TOKEN_SECRET_REF = "secret:messaging-api-server:token";

/** The message endpoint. One route, one verb. */
export const API_SERVER_MESSAGE_PATH = "/v1/message";
/** The liveness probe. It reaches no agent and reveals nothing but liveness. */
export const API_SERVER_HEALTH_PATH = "/health";

/**
 * The address the listener binds unless the record names another.
 *
 * Whether an address is loopback is [`isLoopbackBindAddress`], the shared
 * inbound receiver's rule: the exact three spellings, never a prefix.
 */
export const API_SERVER_DEFAULT_HOST = "127.0.0.1";
/** The port the listener binds when the record names none. */
export const API_SERVER_DEFAULT_PORT = 7842;
/** The most body bytes accepted unless the record names a cap. */
export const API_SERVER_DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** How long one request may occupy the agent, unless the record says otherwise. */
export const API_SERVER_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** How many requests may be in flight at once, unless the record says otherwise. */
export const API_SERVER_DEFAULT_MAX_CONCURRENT = 4;
/** The most characters one `message` may carry; the body cap is the real bound. */
export const API_SERVER_MAX_MESSAGE_CHARS = 32_000;
/**
 * How long the whole body may take to arrive.
 *
 * The body cap bounds size, not time: a caller that sends its `content-length`
 * and then one byte a second would otherwise hold a socket (and, once admitted,
 * a concurrency slot) for as long as it liked. This is the arrival bound, and
 * it is deliberately shorter than the turn timeout — a body is local network
 * traffic, not an agent thinking.
 */
export const API_SERVER_BODY_READ_TIMEOUT_MS = 15_000;

/** The record as the endpoint uses it, clamped to values it can honour. */
export type ApiServerSettings = {
  enabled: true;
  /** The TCP port; `0` asks the operating system for one (tests use this). */
  port: number;
  bindAddress: string;
  /** Whether a non-loopback address was explicitly opted into by the record. */
  allowNonLoopback: boolean;
  /** The `secret:` ref the token is read from; never the token. */
  tokenSecretRef: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxConcurrent: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite integer inside `[min, max]`, or `fallback` when absent or unusable. */
function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Read the `messagingApiServer` section, or `null` when it is absent, disabled
 * or another build's.
 *
 * Absent and `enabled: false` both mean "bind nothing": an install that never
 * configured this channel takes no port. Every number is clamped so a
 * hand-edited row cannot ask for port `-1`, a body cap of a gigabyte, or zero
 * concurrency (which would refuse everything forever).
 *
 * The port range starts at `0` because the test suite binds an ephemeral port;
 * a stored record is written by the panel with a real port, and a `0` there
 * would move on every restart, which the panel copy warns about.
 */
export function readApiServerSettings(
  settings: unknown,
  sectionKey: string = MESSAGING_API_SERVER_SECTION,
): ApiServerSettings | null {
  if (!isRecord(settings)) return null;
  const section = settings[sectionKey];
  if (!isRecord(section)) return null;
  if (section.format !== MESSAGING_API_SERVER_FORMAT) return null;
  if (section.version !== MESSAGING_API_SERVER_FORMAT_VERSION) return null;
  if (section.enabled !== true) return null;

  const bindAddress =
    typeof section.bindAddress === "string" && section.bindAddress.trim() !== ""
      ? section.bindAddress.trim()
      : API_SERVER_DEFAULT_HOST;
  const tokenSecretRef =
    typeof section.tokenSecretRef === "string" && section.tokenSecretRef.trim() !== ""
      ? section.tokenSecretRef.trim()
      : MESSAGING_API_SERVER_TOKEN_SECRET_REF;

  return {
    enabled: true,
    port: clampInteger(section.port, 0, 65_535, API_SERVER_DEFAULT_PORT),
    bindAddress,
    allowNonLoopback: section.allowNonLoopback === true,
    tokenSecretRef,
    maxBodyBytes: clampInteger(
      section.maxBodyBytes,
      1_024,
      1024 * 1024,
      API_SERVER_DEFAULT_MAX_BODY_BYTES,
    ),
    requestTimeoutMs: clampInteger(
      section.requestTimeoutMs,
      1_000,
      900_000,
      API_SERVER_DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxConcurrent: clampInteger(section.maxConcurrent, 1, 32, API_SERVER_DEFAULT_MAX_CONCURRENT),
  };
}

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first: `timingSafeEqual` throws on different lengths,
 * and a length check is itself an oracle. Two SHA-256 digests are always the
 * same length, so the comparison runs the same work whatever was presented.
 * An empty expected token is refused before hashing — there is no configuration
 * in which "no token" should compare equal to anything.
 */
export function apiServerTokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented === "") return false;
  const wanted = expected.trim();
  if (wanted === "") return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(wanted, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** The bearer token a request presented, from either accepted header. */
export function apiServerPresentedToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof header === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const key = headers["x-api-key"];
  const raw = Array.isArray(key) ? key[0] : key;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * The reply seam: one message in, one answer out.
 *
 * `conversationId` is the caller's chosen conversation (a session id), or
 * `null` when it omitted one — in that case the implementation uses the
 * session the channel is bound to. The implementation owns everything about
 * how a turn is run; this module owns only the HTTP contract around it.
 */
export type ApiServerReply = (request: {
  message: string;
  conversationId: string | null;
}) => Promise<string>;

/** One audit record. Structure and ids only — never message text, never a token. */
export type ApiServerAuditEntry =
  | { kind: "started"; host: string; port: number }
  | { kind: "stopped" }
  | { kind: "bind-failed"; host: string; port: number; error: string }
  | { kind: "rejected"; reason: string }
  | { kind: "reply-failed"; error: string }
  | { kind: "answered"; conversationId: string | null; messageLength: number; replyLength: number };

export type ApiServerAudit = (entry: ApiServerAuditEntry) => void;

/** What the endpoint is doing, for the wiring and the panel. */
export type ApiServerStatus =
  | { state: "idle" }
  | { state: "listening"; host: string; port: number }
  | { state: "failed"; reason: string };

export type ApiServerEndpointOptions = {
  settings: ApiServerSettings;
  /** The stored token, read by the caller from the secret store. */
  token: string;
  reply: ApiServerReply;
  audit?: ApiServerAudit;
};

type BodyRead =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "too-large" | "aborted" | "timeout" };

/**
 * Read a request body, capped.
 *
 * The declared length is checked first, so a request that announces more than
 * the cap is refused without its body being read. A chunked request has no
 * declared length, so the running total is checked as chunks arrive.
 */
function readBody(req: IncomingMessage, max: number, timeoutMs: number): Promise<BodyRead> {
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
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        req.pause();
        finish({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false, reason: "aborted" }));
    req.on("aborted", () => finish({ ok: false, reason: "aborted" }));
    // The arrival deadline: a body that trickles in is refused rather than
    // allowed to hold the socket for as long as its sender likes.
    timer = setTimeout(() => {
      if (settled) return;
      finish({ ok: false, reason: "timeout" });
      req.destroy();
    }, Math.max(1, timeoutMs));
    timer.unref?.();
  });
}

/** Answer with JSON, and never with anything the request supplied. */
function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * The listener. One instance per started record; constructed, started and
 * stopped by the wiring, never by itself.
 */
export class ApiServerEndpoint {
  private readonly settings: ApiServerSettings;
  private readonly token: string;
  private readonly reply: ApiServerReply;
  private readonly audit: ApiServerAudit;
  private server: Server | null = null;
  private bound: { host: string; port: number } | null = null;
  private failure: string | null = null;
  private inFlight = 0;

  constructor(options: ApiServerEndpointOptions) {
    this.settings = options.settings;
    this.token = options.token;
    this.reply = options.reply;
    this.audit = options.audit ?? (() => {});
  }

  /** The address bound, or `null` before `start` and after `stop`. */
  address(): { host: string; port: number } | null {
    return this.bound;
  }

  status(): ApiServerStatus {
    if (this.failure !== null) return { state: "failed", reason: this.failure };
    const bound = this.bound;
    return bound ? { state: "listening", host: bound.host, port: bound.port } : { state: "idle" };
  }

  /**
   * Bind and listen.
   *
   * A non-loopback address is refused twice over: first for lacking the
   * explicit opt-in, then — even with it — because this listener speaks plain
   * HTTP. Both refusals carry the address, and both leave `address()` null.
   */
  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("the local API endpoint is already listening");
    if (this.token.trim() === "") {
      // Fail closed before a port exists: an endpoint with no token would be an
      // unauthenticated way into the agent for every process on the machine.
      throw new Error("refusing to start: no token is stored for the local API endpoint");
    }
    const host = this.settings.bindAddress;
    if (!isLoopbackBindAddress(host)) {
      if (!this.settings.allowNonLoopback) {
        throw new Error(
          `refusing to bind ${host}: the local API endpoint binds loopback unless a non-loopback address is explicitly allowed`,
        );
      }
      throw new Error(
        `refusing to bind ${host}: this endpoint is plain HTTP, and a non-loopback plain-HTTP bind would put the token on the wire`,
      );
    }

    const server = createServer((req, res) => {
      void this.route(req, res);
    });
    try {
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
        server.listen(this.settings.port, host);
      });
    } catch (error) {
      server.close();
      const reason = error instanceof Error ? error.message : String(error);
      this.failure = reason;
      this.audit({ kind: "bind-failed", host, port: this.settings.port, error: reason });
      throw error;
    }

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      const reason = "the listener bound an address it cannot describe";
      this.failure = reason;
      throw new Error(reason);
    }
    this.server = server;
    this.bound = { host: address.address, port: address.port };
    this.failure = null;
    this.audit({ kind: "started", host: this.bound.host, port: this.bound.port });
    return this.bound;
  }

  /**
   * Stop accepting, and close the connections held.
   *
   * An in-flight reply is not cancelled: the turn already started, and the
   * response is simply dropped when the socket is gone.
   */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.bound = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    await closed;
    this.audit({ kind: "stopped" });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch (error) {
      this.audit({
        kind: "reply-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) respond(res, 500, { error: "the request could not be served" });
      else res.destroy();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";

    // The probe answers before authentication on purpose: it says the process
    // is alive and holds no other fact. It never reaches the agent.
    if (path === API_SERVER_HEALTH_PATH) {
      if (req.method !== "GET") {
        respond(res, 405, { error: "method not allowed" });
        return;
      }
      respond(res, 200, { ok: true });
      return;
    }

    if (path !== API_SERVER_MESSAGE_PATH) {
      this.audit({ kind: "rejected", reason: "unknown-path" });
      respond(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      this.audit({ kind: "rejected", reason: "method" });
      respond(res, 405, { error: "method not allowed" });
      return;
    }

    // Authentication before the body is read at all: an unauthenticated caller
    // is refused without this process buffering anything it sent.
    if (!apiServerTokenMatches(apiServerPresentedToken(req.headers), this.token)) {
      this.audit({ kind: "rejected", reason: "unauthorized" });
      respond(res, 401, { error: "unauthorized" });
      return;
    }

    const read = await readBody(req, this.settings.maxBodyBytes, API_SERVER_BODY_READ_TIMEOUT_MS);
    if (!read.ok) {
      if (read.reason === "aborted") {
        respond(res, 400, { error: "the request ended early" });
        return;
      }
      if (read.reason === "timeout") {
        this.audit({ kind: "rejected", reason: "body-timeout" });
        respond(res, 408, { error: "the body did not arrive in time" });
        return;
      }
      this.audit({ kind: "rejected", reason: "body-too-large" });
      respond(res, 413, { error: "payload too large" });
      res.once("finish", () => req.destroy());
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body.toString("utf8"));
    } catch {
      this.audit({ kind: "rejected", reason: "malformed" });
      respond(res, 400, { error: "the body is not JSON" });
      return;
    }
    if (!isRecord(parsed)) {
      this.audit({ kind: "rejected", reason: "malformed" });
      respond(res, 400, { error: "the body must be a JSON object" });
      return;
    }
    const message = typeof parsed.message === "string" ? parsed.message : "";
    if (message.trim() === "") {
      this.audit({ kind: "rejected", reason: "empty-message" });
      respond(res, 400, { error: "message is required" });
      return;
    }
    if (message.length > API_SERVER_MAX_MESSAGE_CHARS) {
      this.audit({ kind: "rejected", reason: "message-too-long" });
      respond(res, 413, { error: "the message is too long" });
      return;
    }
    if (parsed.conversationId !== undefined && typeof parsed.conversationId !== "string") {
      this.audit({ kind: "rejected", reason: "malformed" });
      respond(res, 400, { error: "conversationId must be a string" });
      return;
    }
    const conversationId =
      typeof parsed.conversationId === "string" && parsed.conversationId.trim() !== ""
        ? parsed.conversationId.trim()
        : null;

    if (this.inFlight >= this.settings.maxConcurrent) {
      this.audit({ kind: "rejected", reason: "too-many-requests" });
      res.setHeader("retry-after", "1");
      respond(res, 429, { error: "too many requests" });
      return;
    }

    this.inFlight += 1;
    let timer: NodeJS.Timeout | null = null;
    try {
      const answer = await Promise.race([
        this.reply({ message, conversationId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the agent did not answer within the request timeout")),
            this.settings.requestTimeoutMs,
          );
          // A pending timer must not keep the process alive after a stop.
          timer.unref?.();
        }),
      ]);
      this.audit({
        kind: "answered",
        conversationId,
        messageLength: message.length,
        replyLength: answer.length,
      });
      respond(res, 200, { reply: answer });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.audit({ kind: "reply-failed", error: detail });
      const timedOut = detail === "the agent did not answer within the request timeout";
      respond(res, timedOut ? 504 : 500, {
        error: timedOut ? "the agent did not answer in time" : "the agent did not answer",
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.inFlight -= 1;
    }
  }
}

/** The endpoint for one record, without starting it. */
export function createApiServerEndpoint(options: ApiServerEndpointOptions): ApiServerEndpoint {
  return new ApiServerEndpoint(options);
}
