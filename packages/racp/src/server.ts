import { randomUUID } from "node:crypto";

import { AgentHost, RacpError, type Principal } from "@pi-desktop/agent-host";
import {
  RACP_DEFAULT_LIMITS,
  RACP_DEFAULT_POLICY,
  RACP_EVENT_NOTIFICATION,
  RACP_INITIALIZED_NOTIFICATION,
  RACP_OPERATIONS,
  RACP_PROTOCOL_VERSION,
  RACP_SUBSCRIPTION_CLOSED_NOTIFICATION,
  RacpInitializeParamsSchema,
  protocolVersionsCompatible,
  rolesAllowOperation,
  type RacpEventEnvelope,
  type RacpInitializeResult,
  type RacpLimits,
  type RacpOperation,
  type RacpPolicy,
  type RacpServerCapabilities,
  type RacpToolExecuteParams,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";

import type { ConnectionAuth, DeviceTokenAuthenticator } from "./auth.js";
import type { RacpHostOperations } from "./host-operations.js";
import {
  encodeFrame,
  errorObjectFrom,
  isNotification,
  isRequest,
  isResponse,
  parseFrame,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./jsonrpc.js";
import { createOperations, type OperationContext, type OperationHandler } from "./operations.js";
import {
  RACP_RELAY_DEFAULT_TIMEOUT_MS,
  ToolRelayRegistry,
  type RacpRelayedToolOutcome,
} from "./tool-relay.js";

/** One accepted transport connection, as the server drives it. */
export interface ServerConnectionTransport {
  send(frame: string): void;
  close(code: number, reason: string): void;
  onMessage(handler: (frame: string, byteLength: number) => void): void;
  onClose(handler: () => void): void;
}

export type RacpServerOptions = {
  agentHost: AgentHost;
  operations: RacpHostOperations;
  authenticator: DeviceTokenAuthenticator;
  /** Stable Host identity (D448). */
  hostId: string;
  serverName?: string;
  serverVersion: string;
  limits?: Partial<RacpLimits>;
  policy?: Partial<RacpPolicy>;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** Deadline for `connection/initialize` after the socket opened (spec §12). */
  initializeTimeoutMs?: number;
  /**
   * Told which session's relayed-tool catalog changed when a desktop
   * advertises (`tools/advertise`) or disconnects (spec §9.4). The embedding
   * Host uses it to keep the Agent runtime's tool list in step; the server
   * itself never reaches into a runtime.
   */
  onRelayedToolsChanged?: (sessionId: string) => void;
};

type Subscription = { id: string; sessionId?: string };

/**
 * Session-addressed operations whose handler does not go through the Agent
 * Host module: they name the session on the wire. ADR 0325's ownership rule
 * must reach each of them, so `dispatch` admits them once before the handler
 * runs. Operations the Agent Host already admits (`session/attach`,
 * `session/history`, `turn/start`, `turn/stop`, `events/subscribe` with a
 * session scope, `respondApproval`, `respondInput`, …) are deliberately absent:
 * their check runs inside the module and must not run twice.
 */
const SESSION_ADDRESSED_OPERATIONS: ReadonlySet<string> = new Set([
  "session/configure",
  "session/fork",
  "session/rename",
  "session/delete",
  "session/compact",
  "workspace/list",
  "workspace/read",
  "workspace/diff",
  "terminal/open",
  // The relay names the session its tools are advertised for (spec §9.4), so the
  // ownership rule reaches it on the same path as the other addressed operations.
  "tools/advertise",
]);

/** Terminal-addressed operations: the session is the one the terminal belongs to. */
const TERMINAL_ADDRESSED_OPERATIONS: ReadonlySet<string> = new Set([
  "terminal/input",
  "terminal/resize",
  "terminal/close",
]);

type ServerRequestWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: RacpError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Per-connection state; the server keeps one per accepted socket. */
export class RacpConnection {
  readonly id = `conn_${randomUUID()}`;
  principal: Principal;
  initialized = false;
  readonly subscriptions = new Map<string, Subscription>();
  readonly terminals = new Set<string>();
  private readonly pendingServerRequests = new Map<string, ServerRequestWaiter>();
  private serverRequestCounter = 0;
  private closed = false;

  constructor(
    readonly auth: ConnectionAuth,
    readonly transport: ServerConnectionTransport,
    private readonly server: RacpServer,
  ) {
    this.principal = { ...auth.principal, connectionId: this.id };
  }

  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(encodeFrame(message));
    } catch (error) {
      this.server.log("warn", "racp send failed", { connectionId: this.id, error: String(error) });
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** A server-initiated request (spec §4.3); resolves with the client's result. */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    this.serverRequestCounter += 1;
    const id = `srv_${this.serverRequestCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingServerRequests.delete(id);
        reject(new RacpError("TOOL_FAILED", `client did not answer ${method} in time`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingServerRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  handleResponse(id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | undefined): void {
    const waiter = this.pendingServerRequests.get(String(id));
    if (!waiter) return;
    this.pendingServerRequests.delete(String(id));
    clearTimeout(waiter.timer);
    if (error) waiter.reject(new RacpError(error.data?.code ?? "TOOL_FAILED", error.message));
    else waiter.resolve(result);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pendingServerRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RacpError("AGENT_UNAVAILABLE", "connection closed"));
    }
    this.pendingServerRequests.clear();
    try {
      this.transport.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The `RACP-WS` server core: connection admission, initialization, request
 * dispatch with role checks from the operation catalog, event fan-out from
 * the Agent Host hub, and connection teardown that releases every
 * subscription and terminal the connection held. Transport framing is
 * injected so the same core runs over `ws` in `pi-host` and over an
 * in-memory pair in tests.
 */
export class RacpServer {
  readonly limits: RacpLimits;
  readonly policy: RacpPolicy;
  readonly capabilities: RacpServerCapabilities;
  private readonly connections = new Map<string, RacpConnection>();
  private readonly handlers: Map<RacpOperation, OperationHandler>;
  /** The reverse tool relay's server half (spec §9.4). */
  private readonly toolRelay: ToolRelayRegistry;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: RacpServerOptions) {
    this.limits = { ...RACP_DEFAULT_LIMITS, ...options.limits };
    this.policy = { ...RACP_DEFAULT_POLICY, ...options.policy };
    this.now = options.now ?? (() => Date.now());
    this.toolRelay = new ToolRelayRegistry(options.onRelayedToolsChanged);
    this.capabilities = {
      eventReplay: true,
      snapshot: true,
      approvals: true,
      inputRequests: true,
      attachments: false,
      serverRequests: true,
      turnQueue: true,
      hostEvents: true,
      history: true,
      remoteHostProfile: true,
      toolRelay: true,
      terminal: Boolean(options.operations.terminal),
      notifications: false,
      bindings: ["RACP-WS"],
    };
    this.handlers = createOperations();
  }

  get log(): RacpServerOptions["log"] {
    return this.options.log;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Execute a relayed tool on the desktop that advertised it (spec §9.4).
   *
   * This is the Host-to-desktop hop only: the Host-side permission decision,
   * including session grants, precedes it and belongs to the Agent Host module,
   * and the relayed tool never runs on the Host nor receives Host secrets
   * (rules 1 and 2). It never throws — a desktop that is gone or silent yields a
   * `TOOL_FAILED` outcome, which the caller records as a tool error, so the tool
   * fails without the turn being interrupted (rule 3).
   */
  async executeRelayedTool(
    request: Omit<RacpToolExecuteParams, "executionId"> & { executionId?: string },
    timeoutMs: number = RACP_RELAY_DEFAULT_TIMEOUT_MS,
  ): Promise<RacpRelayedToolOutcome> {
    const params: RacpToolExecuteParams = {
      ...request,
      executionId: request.executionId ?? `exec_${randomUUID()}`,
    };
    return this.toolRelay.execute(params, timeoutMs);
  }

  /** The merged relayed catalog a session currently sees (for diagnostics and tests). */
  relayedCatalog(sessionId: string): import("@pi-desktop/shared").RacpRelayedToolDescriptor[] {
    return this.toolRelay.catalogFor(sessionId);
  }

  /**
   * Admit one authenticated transport. Returns the connection, or `null`
   * when the Host is at its client limit (the transport is closed with
   * `RATE_LIMITED`).
   */
  accept(auth: ConnectionAuth, transport: ServerConnectionTransport): RacpConnection | null {
    if (this.closed) {
      transport.close(1001, "server closing");
      return null;
    }
    if (this.connections.size >= this.limits.maxConnectedClients) {
      this.options.log("warn", "racp connection refused: client limit", { limit: this.limits.maxConnectedClients });
      transport.close(1013, "RATE_LIMITED");
      return null;
    }
    const connection = new RacpConnection(auth, transport, this);
    this.connections.set(connection.id, connection);
    const initializeTimer = setTimeout(() => {
      if (!connection.initialized) {
        this.options.log("warn", "racp connection closed: initialize deadline", { connectionId: connection.id });
        connection.close(1002, "PROTOCOL_MISMATCH");
      }
    }, this.options.initializeTimeoutMs ?? 10_000);
    initializeTimer.unref?.();
    transport.onMessage((frame, byteLength) => {
      if (byteLength > this.limits.maxFrameBytes) {
        connection.send({
          jsonrpc: "2.0",
          id: 0,
          error: errorObjectFrom(new RacpError("PAYLOAD_TOO_LARGE", "frame exceeds maxFrameBytes"), this.traceId()),
        });
        return;
      }
      void this.handleFrame(connection, frame);
    });
    transport.onClose(() => {
      clearTimeout(initializeTimer);
      this.release(connection);
    });
    this.options.log("info", "racp connection accepted", {
      connectionId: connection.id,
      subject: auth.principal.subject,
      kind: auth.kind,
    });
    return connection;
  }

  /** Stop accepting and close every connection; running turns are untouched. */
  close(): void {
    this.closed = true;
    for (const connection of [...this.connections.values()]) {
      connection.close(1001, "server closing");
      this.release(connection);
    }
  }

  private traceId(): string {
    return `trace_${randomUUID()}`;
  }

  private release(connection: RacpConnection): void {
    if (!this.connections.delete(connection.id)) return;
    // The relay's tools go with the connection that advertised them (spec §6.1:
    // "cleared on disconnect"), so a gone desktop leaves no catalog entry behind.
    this.toolRelay.release(connection.id);
    for (const subscription of connection.subscriptions.values()) {
      this.options.agentHost.unsubscribe(subscription.id, subscription.sessionId);
    }
    connection.subscriptions.clear();
    for (const terminalId of connection.terminals) {
      this.options.operations.terminal?.detach(terminalId);
    }
    connection.terminals.clear();
    connection.close(1000, "closed");
    this.options.log("info", "racp connection released", { connectionId: connection.id });
  }

  private async handleFrame(connection: RacpConnection, frame: string): Promise<void> {
    const message = parseFrame(frame);
    if (!message) {
      connection.send({
        jsonrpc: "2.0",
        id: 0,
        error: errorObjectFrom(new RacpError("INVALID_ARGUMENT", "frame is not a JSON-RPC 2.0 message"), this.traceId()),
      });
      return;
    }
    if (isResponse(message)) {
      connection.handleResponse(message.id, message.result, message.error);
      return;
    }
    if (!isRequest(message)) {
      if (isNotification(message) && message.method === RACP_INITIALIZED_NOTIFICATION) connection.initialized = true;
      return;
    }
    const traceId = this.traceId();
    try {
      const result = await this.dispatch(connection, message.method, message.params, traceId);
      connection.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (!(error instanceof RacpError)) {
        this.options.log("error", "racp operation failed", { method: message.method, traceId, error: String(error) });
      }
      connection.send({ jsonrpc: "2.0", id: message.id, error: errorObjectFrom(error, traceId) });
    }
  }

  private async dispatch(connection: RacpConnection, method: string, params: unknown, traceId: string): Promise<unknown> {
    if (method === "connection/initialize") {
      if (connection.initialized) throw new RacpError("CONFLICT", "the connection is already initialized");
      return this.initialize(connection, params);
    }
    if (!connection.initialized) {
      throw new RacpError("PROTOCOL_MISMATCH", "connection/initialize must complete first");
    }
    if (!(method in RACP_OPERATIONS)) throw new RacpError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    const operation = method as RacpOperation;
    const handler = this.handlers.get(operation);
    if (!handler) throw new RacpError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    if (!rolesAllowOperation(connection.principal.roles, operation)) {
      throw new RacpError("FORBIDDEN", `principal lacks the role for ${operation}`);
    }
    const request = (params ?? {}) as Record<string, unknown>;
    // ADR 0325: the ownership admission is applied once, here, on the one path
    // every RACP caller shares. The rule is the Agent Host's; this only says
    // which session the operation addresses.
    await this.admitSessionOwnership(connection.principal, operation, request);
    const context: OperationContext = {
      connection,
      principal: connection.principal,
      agentHost: this.options.agentHost,
      operations: this.options.operations,
      toolRelay: this.toolRelay,
      authenticator: this.options.authenticator,
      limits: this.limits,
      capabilities: this.capabilities,
      traceId,
      now: this.now,
      deliverEvent: (envelope) => this.deliverEvent(connection, envelope),
      closeSubscription: (subscriptionId, error, lastSafeCursor) => {
        connection.subscriptions.delete(subscriptionId);
        connection.notify(RACP_SUBSCRIPTION_CLOSED_NOTIFICATION, {
          subscriptionId,
          error: error.toRemoteError(this.traceId()),
          lastSafeCursor,
        });
      },
      log: this.options.log,
    };
    return handler(context, request);
  }

  /**
   * The session-ownership admission (ADR 0325). The rule and the durable
   * re-read are the Agent Host's (`authorizeSession` / `authorizeTurn`); this
   * method only resolves *which* session an operation addresses, so the
   * admission is applied once, on the one path every RACP caller shares, and a
   * handler — or a second caller of a handler — cannot restate or skip it.
   *
   * The session-addressed operations whose handler does not go through the
   * Agent Host module carry their session id on the wire; the terminal
   * operations carry a terminal id, resolved to its session through the
   * terminal access the Host is wired with; `turn/get` carries a turn id,
   * resolved inside the Host. An operation the Agent Host already admits
   * (`session/attach`, `session/history`, `turn/start`, …) is not listed here,
   * so its check is not run twice.
   */
  private async admitSessionOwnership(
    principal: Principal,
    operation: RacpOperation,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (operation === "turn/get") {
      const turnId = params.turnId;
      if (typeof turnId === "string" && turnId.length > 0) {
        await this.options.agentHost.authorizeTurn(principal, turnId);
      }
      return;
    }
    const sessionId = this.addressedSessionId(operation, params);
    if (sessionId !== undefined) await this.options.agentHost.authorizeSession(principal, sessionId);
  }

  /**
   * The session a session-addressed operation names, or `undefined` if it names
   * none.
   *
   * `terminal/open` is the one operation that is both: without a `terminalId`
   * it opens a new terminal in the session it names (resolved from the wire
   * `sessionId` below), but with a `terminalId` it re-attaches to an existing
   * terminal — and then the terminal's own session is what must be authorized,
   * never the caller-supplied `sessionId` sitting beside it. Resolving through
   * `sessionOf` there keeps the ownership *rule* in the Agent Host: this layer
   * only decides which session id to hand `authorizeSession`, so a caller
   * cannot name one session and act on another's terminal.
   */
  private addressedSessionId(operation: RacpOperation, params: Record<string, unknown>): string | undefined {
    const terminalId = params.terminalId;
    const namesTerminal = typeof terminalId === "string" && terminalId.length > 0;
    if (namesTerminal && (operation === "terminal/open" || TERMINAL_ADDRESSED_OPERATIONS.has(operation))) {
      return this.options.operations.terminal?.sessionOf(terminalId);
    }
    if (TERMINAL_ADDRESSED_OPERATIONS.has(operation)) return undefined;
    if (!SESSION_ADDRESSED_OPERATIONS.has(operation)) return undefined;
    const sessionId = params.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  }

  private deliverEvent(connection: RacpConnection, envelope: RacpEventEnvelope): void {
    connection.notify(RACP_EVENT_NOTIFICATION, envelope);
  }

  private initialize(connection: RacpConnection, params: unknown): RacpInitializeResult {
    if (!Value.Check(RacpInitializeParamsSchema, params)) {
      throw new RacpError("INVALID_ARGUMENT", "invalid connection/initialize params");
    }
    if (!protocolVersionsCompatible(RACP_PROTOCOL_VERSION, params.protocolVersion)) {
      throw new RacpError("PROTOCOL_MISMATCH", `protocol ${params.protocolVersion} is not compatible with ${RACP_PROTOCOL_VERSION}`);
    }
    if (!params.bindings.includes("RACP-WS")) {
      throw new RacpError("PROTOCOL_MISMATCH", "client does not offer the RACP-WS binding");
    }
    // A pairing connection may only pair; everything else needs the device's roles.
    connection.initialized = true;
    return {
      protocolVersion: RACP_PROTOCOL_VERSION,
      server: { name: this.options.serverName ?? "pi-host", version: this.options.serverVersion, hostId: this.options.hostId },
      connectionId: connection.id,
      principal: { subject: connection.principal.subject, roles: [...connection.principal.roles] },
      capabilities: this.capabilities,
      limits: this.limits,
      policy: this.policy,
    };
  }
}
