/**
 * The `RACP-HTTP` binding (spec §11.2): one operation per HTTP request, events
 * over `text/event-stream`.
 *
 * The HTTP profile exists because a browser and a phone cannot hold a
 * WebSocket open the way the desktop can. It is a binding, not a second
 * protocol: every request becomes the same JSON-RPC frame the WebSocket binding
 * sends, and every response is the same frame coming back, so the operation
 * table, the role checks and the event fan-out are shared rather than restated.
 *
 * The state that WebSocket gets from the socket has to live somewhere here,
 * because subscriptions are per-connection: `events/subscribe` registers against
 * the connection that asked, and the events arrive later on that connection's
 * transport. So an HTTP client gets one synthetic connection, keyed by the
 * credential that authenticated it, and every request it makes is a frame
 * injected into that connection. SSE streams are the connection's outbound
 * channel.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import {
  RACP_HTTP_HOST_EVENTS_PATH,
  RACP_HTTP_ROUTES,
  RACP_INITIALIZED_NOTIFICATION,
  RACP_PROTOCOL_VERSION,
  formatRacpCursor,
  parseRacpCursor,
  type RacpEventEnvelope,
  type RacpOperation,
} from "@pi-desktop/shared";

import { isLoopbackAddress, type DeviceTokenAuthenticator } from "./auth.js";
import type { RacpConnection, RacpServer, ServerConnectionTransport } from "./server.js";

export type HttpBindingOptions = {
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  /** Loopback unless TLS is supplied (ADR 0333 §4 forbids a plaintext LAN bind). */
  host?: string;
  /**
   * PEM material for an HTTPS listener. Supplying it is what makes a
   * non-loopback bind legal: the protocol has no plaintext LAN mode.
   */
  tls?: { cert: string; key: string };
  /**
   * Whether peers outside loopback may reach a TLS listener. Off by default so
   * a LAN bind is an explicit decision even when a certificate is present.
   */
  allowLan?: boolean;
  /** `0` asks the OS for a free port, which is what the desktop wants by default. */
  port: number;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** A client with no request and no open stream for this long is released. */
  idleTimeoutMs?: number;
  /** Upper bound on one operation; turns return immediately, so this is generous. */
  requestTimeoutMs?: number;
  /** Failed authentications from one peer before it is locked out. */
  maxFailedAttempts?: number;
  /** Window the failures are counted in; a quiet peer starts fresh. */
  failureWindowMs?: number;
  /** How long a locked-out peer waits. */
  lockoutMs?: number;
};

export type HttpBinding = {
  address: { host: string; port: number; protocol: "http" | "https" };
  close(): Promise<void>;
};

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcFrame = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_MS = 120_000;

/** A JSON-RPC response carries an id and no method; anything else is outbound. */
function isResponse(frame: RpcFrame): boolean {
  return frame.id !== undefined && frame.method === undefined;
}

/**
 * One HTTP client's connection state.
 *
 * The transport is synthetic: `send` is what the server writes back, and
 * `inject` is how a request enters. Responses go to the waiting request;
 * notifications go to every open SSE stream for this client.
 */
class HttpClientSession {
  readonly connection: RacpConnection;
  private readonly waiters = new Map<string, Waiter>();
  private readonly streams = new Set<ServerResponse>();
  private inbound: ((frame: string, byteLength: number) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private counter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      auth: Parameters<RacpServer["accept"]>[0];
      server: RacpServer;
      log: HttpBindingOptions["log"];
      idleTimeoutMs: number;
      requestTimeoutMs: number;
      onRelease: (session: HttpClientSession) => void;
    },
  ) {
    const transport: ServerConnectionTransport = {
      send: (frame) => this.handleOutbound(frame),
      close: () => this.release(),
      onMessage: (handler) => {
        this.inbound = handler;
      },
      onClose: (handler) => {
        // The server registers this to learn about a closed connection; it is
        // not a signal that the connection has already closed.
        this.closeHandler = handler;
      },
    };
    const connection = options.server.accept(options.auth, transport);
    if (!connection) throw new Error("the Host refused the connection");
    this.connection = connection;
    this.touch();
    // The Host closes a connection that has not initialized within its own
    // deadline, and an HTTP client has no handshake of its own, so this binding
    // initializes on its behalf the moment the session exists.
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await this.call("connection/initialize", {
        protocolVersion: RACP_PROTOCOL_VERSION,
        client: { name: "racp-http", version: "1.0.0" },
        bindings: ["RACP-HTTP"],
        // The binding owns reconnect: it sends `Last-Event-ID` itself, which is
        // how `eventReplay` is honoured without a socket to resume.
        capabilities: { eventReplay: true, history: true, approvals: true, inputRequests: true },
      });
      this.inbound?.(
        JSON.stringify({ jsonrpc: "2.0", method: RACP_INITIALIZED_NOTIFICATION, params: {} }),
        0,
      );
    } catch (error) {
      this.options.log("warn", "racp http initialize failed", { error: String(error) });
      this.release();
    }
  }

  /** Runs one operation and resolves with its result. */
  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("the client session is closed"));
    this.touch();
    const id = `http_${(this.counter += 1)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(Object.assign(new Error(`${method} did not answer in time`), { errorCode: "AGENT_TIMEOUT" }));
      }, this.options.requestTimeoutMs);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
      if (!this.inbound) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(new Error("the connection is not ready"));
        return;
      }
      this.inbound(JSON.stringify({ jsonrpc: "2.0", id, method, params }), 0);
    });
  }

  private handleOutbound(frame: string): void {
    let message: RpcFrame;
    try {
      message = JSON.parse(frame) as RpcFrame;
    } catch {
      this.options.log("warn", "racp http: unparseable outbound frame");
      return;
    }
    if (isResponse(message)) {
      const waiter = this.waiters.get(String(message.id));
      if (!waiter) return;
      this.waiters.delete(String(message.id));
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(
          Object.assign(new Error(message.error.message ?? "operation failed"), {
            errorCode: (message.error.data as { code?: string } | undefined)?.code,
          }),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    for (const stream of this.streams) this.writeEvent(stream, message);
  }

  private writeEvent(stream: ServerResponse, message: RpcFrame): void {
    const envelope = message.params as Partial<RacpEventEnvelope> | undefined;
    const id =
      typeof envelope?.epoch === "string" && typeof envelope?.sequence === "number"
        ? `id: ${formatRacpCursor({ epoch: envelope.epoch, sequence: envelope.sequence })}\n`
        : "";
    try {
      stream.write(`${id}event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } catch {
      this.detachStream(stream);
    }
  }

  attachStream(stream: ServerResponse): void {
    this.touch();
    this.streams.add(stream);
    stream.once("close", () => this.detachStream(stream));
  }

  detachStream(stream: ServerResponse): void {
    this.streams.delete(stream);
    this.touch();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.streams.size > 0 || this.waiters.size > 0) return this.touch();
      this.options.log("info", "racp http session idle, released");
      this.release();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  release(): void {
    if (this.closed) return;
    // `release` can run from inside `accept` (a refused transport is closed
    // before `accept` returns), so the connection may not exist yet.
    if (!this.connection) {
      this.closed = true;
      this.options.onRelease(this);
      return;
    }
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("the client session closed"));
    }
    this.waiters.clear();
    for (const stream of this.streams) {
      try {
        stream.end();
      } catch {
        // Already gone.
      }
    }
    this.streams.clear();
    this.connection.close(1000, "http session released");
    this.closeHandler?.();
    this.options.onRelease(this);
  }
}

/** Matches `/v1/sessions/{sessionId}:attach`-style routes and returns the params. */
function matchRoute(
  method: string,
  pathname: string,
): { operation: RacpOperation; params: Record<string, unknown> } | null {
  for (const [operation, route] of Object.entries(RACP_HTTP_ROUTES) as Array<
    [RacpOperation, { method: "GET" | "POST"; path: string }]
  >) {
    if (route.method !== method) continue;
    const pattern = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => `(?<${name}>[^/]+)`);
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (!match) continue;
    // `groups` is undefined when the pattern has no named captures, which is
    // every collection route (`/v1/sessions`), so it cannot gate the match.
    return { operation, params: { ...(match.groups ?? {}) } };
  }
  return null;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text) as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(Object.assign(new Error("the request body is not JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

/**
 * Bind the RACP server to a loopback HTTP listener (spec §11.2).
 *
 * Every route requires a bearer credential. There is no cookie profile here:
 * that belongs to the browser session work, and adding it now would mean
 * shipping the CSRF and Origin rules that go with it in the same step.
 */
export async function bindRacpHttp(options: HttpBindingOptions): Promise<HttpBinding> {
  const host = options.host ?? "127.0.0.1";
  const tls = options.tls ?? null;
  if (!isLoopbackAddress(host) && !tls) {
    throw Object.assign(new Error("a non-loopback RACP-HTTP bind requires TLS"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_MS;
  const sessions = new Map<string, HttpClientSession>();

  /**
   * ADR 0333 lists failed-attempt lockout as a companion to the first listening
   * release, not a follow-up. A loopback listener is reachable by every process
   * on the machine, so guessing a device token has to cost something even
   * before TLS exists.
   */
  const throttles = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();
  const maxFailedAttempts = options.maxFailedAttempts ?? 5;
  const failureWindowMs = options.failureWindowMs ?? 60_000;
  const lockoutMs = options.lockoutMs ?? 60_000;
  const now = () => Date.now();

  const lockedFor = (peer: string): number => {
    const state = throttles.get(peer);
    if (!state || state.lockedUntil === 0) return 0;
    const remaining = state.lockedUntil - now();
    if (remaining <= 0) {
      throttles.delete(peer);
      return 0;
    }
    return remaining;
  };

  const noteFailure = (peer: string): void => {
    const timestamp = now();
    const state = throttles.get(peer);
    if (!state || timestamp - state.windowStart > failureWindowMs) {
      throttles.set(peer, { failures: 1, windowStart: timestamp, lockedUntil: 0 });
      return;
    }
    state.failures += 1;
    if (state.failures >= maxFailedAttempts) {
      state.lockedUntil = timestamp + lockoutMs;
      options.log("warn", "racp http lockout", { peer, failures: state.failures, lockoutMs });
    }
  };

  const noteSuccess = (peer: string): void => {
    throttles.delete(peer);
  };

  /** One session per credential: subscriptions are connection-scoped. */
  const sessionFor = (key: string, auth: Parameters<RacpServer["accept"]>[0]): HttpClientSession => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const created = new HttpClientSession({
      auth,
      server: options.server,
      log: options.log,
      idleTimeoutMs,
      requestTimeoutMs,
      onRelease: (session) => {
        if (sessions.get(key) === session) sessions.delete(key);
      },
    });
    sessions.set(key, created);
    return created;
  };

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(text);
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (!isLoopbackAddress(request.socket.remoteAddress) && !(tls && options.allowLan)) {
        options.log("warn", "racp http refused: non-loopback peer", { peer: request.socket.remoteAddress });
        return send(response, 403, { error: "FORBIDDEN" });
      }
      const peer = request.socket.remoteAddress ?? "unknown";
      const locked = lockedFor(peer);
      if (locked > 0) {
        response.setHeader("retry-after", String(Math.ceil(locked / 1000)));
        return send(response, 429, { error: "RATE_LIMITED", retryAfterMs: locked });
      }

      if ([...url.searchParams.keys()].some((key) => /token|auth|key/i.test(key))) {
        options.log("warn", "racp http refused: credential in url");
        return send(response, 400, { error: "INVALID_ARGUMENT", message: "credentials must not travel in a URL" });
      }

      const auth = await options.authenticator.authenticate({
        authorization: request.headers.authorization,
        urlHasToken: false,
        connectionId: "pending",
      });
      if (!auth) {
        noteFailure(peer);
        return send(response, 401, { error: "UNAUTHORIZED" });
      }
      noteSuccess(peer);

      // The device id is the credential's stable identity; the token itself never
      // becomes a key, so a re-pair produces a new session rather than reusing one.
      const key = `${auth.kind}:${auth.principal.subject}`;

      const hostEvents = url.pathname === RACP_HTTP_HOST_EVENTS_PATH && method === "GET";
      const route = hostEvents ? null : matchRoute(method, url.pathname);
      if (!hostEvents && !route) {
        return send(response, 404, { error: "METHOD_NOT_FOUND", path: url.pathname });
      }

      let session: HttpClientSession;
      try {
        session = sessionFor(key, auth);
      } catch (error) {
        options.log("warn", "racp http session refused", { error: String(error) });
        return send(response, 429, { error: "RATE_LIMITED" });
      }

      const lastEventId = request.headers["last-event-id"];
      const after = typeof lastEventId === "string" ? parseRacpCursor(lastEventId) : null;
      const streamParams: Record<string, unknown> | null = hostEvents
        ? { scope: "host", ...(after ? { after } : {}) }
        : route?.operation === "events/subscribe"
          ? { scope: "session", sessionId: route.params.sessionId, ...(after ? { after } : {}) }
          : null;
      if (streamParams) {
        const params = streamParams;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(": racp-http\n\n");
        session.attachStream(response);
        try {
          const result = (await session.call("events/subscribe", params)) as { subscriptionId?: string };
          response.write(
            `event: ready\ndata: ${JSON.stringify({ subscriptionId: result?.subscriptionId, after: after ?? null })}\n\n`,
          );
        } catch (error) {
          response.write(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`);
          session.detachStream(response);
          response.end();
        }
        return;
      }

      let body: Record<string, unknown> = {};
      if (method === "POST") {
        try {
          body = await readJsonBody(request);
        } catch (error) {
          const status = (error as { status?: number }).status ?? 400;
          return send(response, status, { error: "INVALID_ARGUMENT", message: (error as Error).message });
        }
      }
      if (!route) {
        // The host-events stream returned above; nothing else is routable.
        return send(response, 404, { error: "METHOD_NOT_FOUND", path: url.pathname });
      }
      const operation = route.operation;
      const params = { ...route.params, ...body };
      try {
        const result = await session.call(operation, params);
        return send(response, 200, { result });
      } catch (error) {
        const code = (error as { errorCode?: string }).errorCode ?? "INTERNAL";
        const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "UNAUTHORIZED" ? 401 : 400;
        return send(response, status, { error: code, message: (error as Error).message });
      }
    })();
  };

  const server: Server = tls
    ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler)
    : createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : options.port;
  options.log("info", "racp http listening", { host, port: boundPort, protocol: tls ? "https" : "http" });

  return {
    address: { host, port: boundPort, protocol: tls ? "https" : "http" },
    async close() {
      for (const session of [...sessions.values()]) session.release();
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
