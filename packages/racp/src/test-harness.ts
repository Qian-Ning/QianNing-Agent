import type { AskToolResolution } from "@pi-desktop/shared";
import { RacpError, AgentHost, type ApprovalPort, type Principal, type RuntimePort, type SessionPort, type SessionSummary, type TurnStartRequest } from "@pi-desktop/agent-host";

import { DeviceTokenAuthenticator, MemoryCredentialStore, hashToken, newDeviceToken, type ConnectionAuth } from "./auth.js";
import { RacpClient, type ClientTransport, type ClientTransportFactory } from "./client.js";
import type { RacpHostOperations } from "./host-operations.js";
import { RacpServer, type ServerConnectionTransport } from "./server.js";

/** An in-memory transport pair: what `ws` provides, without a socket. */
export class MemoryLink {
  private clientHandlers: { message?: (frame: string) => void; close?: (info: { code: number; reason: string }) => void } = {};
  private serverHandlers: { message?: (frame: string, byteLength: number) => void; close?: () => void } = {};
  private open = true;
  /** Frames the server sent, for assertions. */
  readonly toClient: string[] = [];
  readonly toServer: string[] = [];

  get isOpen(): boolean {
    return this.open;
  }

  serverSide(): ServerConnectionTransport {
    return {
      send: (frame) => {
        if (!this.open) throw new Error("link closed");
        this.toClient.push(frame);
        queueMicrotask(() => this.clientHandlers.message?.(frame));
      },
      close: (code, reason) => this.drop(code, reason),
      onMessage: (handler) => {
        this.serverHandlers.message = handler;
      },
      onClose: (handler) => {
        this.serverHandlers.close = handler;
      },
    };
  }

  clientSide(): ClientTransport {
    return {
      send: (frame) => {
        if (!this.open) throw new Error("link closed");
        this.toServer.push(frame);
        queueMicrotask(() => this.serverHandlers.message?.(frame, Buffer.byteLength(frame, "utf8")));
      },
      close: (code, reason) => this.drop(code ?? 1000, reason ?? ""),
      onMessage: (handler) => {
        this.clientHandlers.message = handler;
      },
      onClose: (handler) => {
        this.clientHandlers.close = handler;
      },
      onError: () => undefined,
    };
  }

  /** Simulate the network dropping: both ends observe a close. */
  drop(code = 1006, reason = "dropped"): void {
    if (!this.open) return;
    this.open = false;
    queueMicrotask(() => {
      this.serverHandlers.close?.();
      this.clientHandlers.close?.({ code, reason });
    });
  }
}

export class FakeRuntime implements RuntimePort {
  prompts: TurnStartRequest[] = [];
  stops: string[] = [];
  aborts: Array<{ sessionId: string; turnId?: string }> = [];
  inputs: AskToolResolution[] = [];
  private counter = 0;
  async prompt(request: TurnStartRequest): Promise<{ turnId: string }> {
    this.prompts.push(request);
    this.counter += 1;
    return { turnId: `rt_${this.counter}` };
  }
  async stop(sessionId: string): Promise<{ requested: boolean }> {
    this.stops.push(sessionId);
    return { requested: true };
  }
  async abort(sessionId: string, turnId?: string): Promise<void> {
    this.aborts.push({ sessionId, turnId });
  }
  async respondInput(resolution: AskToolResolution): Promise<void> {
    this.inputs.push(resolution);
  }
}

/**
 * The fixture session's owner (ADR 0325). A viewer-role principal reaches a
 * session only when its subject is that session's owner: the per-session
 * scoped role that would give a viewer someone else's session is the deferred
 * follow-on, so today `dev_viewer` can only follow a session it owns. The
 * owner-role device above reaches every session through the owner bypass, so
 * the harness keeps both credentials meaningful.
 */
export const SESSION_OWNER_SUBJECT = "dev_viewer";

export function summary(id: string, permissionMode: SessionSummary["permissionMode"] = "ask"): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    projectId: "proj",
    mode: "agent",
    permissionMode,
    owner: SESSION_OWNER_SUBJECT,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

export function buildHost(limits: Partial<import("@pi-desktop/shared").RacpLimits> = {}): { host: AgentHost; runtime: FakeRuntime; sessions: Map<string, SessionSummary>; approvals: { tool: Array<{ requestId: string; decision: string }> } } {
  const runtime = new FakeRuntime();
  const sessions = new Map<string, SessionSummary>([["s1", summary("s1")]]);
  const sessionPort: SessionPort = {
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async history() {
      return { items: [], hasMore: false };
    },
  };
  const approvals = { tool: [] as Array<{ requestId: string; decision: string }> };
  const approvalPort: ApprovalPort = {
    async resolveTool(requestId, decision) {
      approvals.tool.push({ requestId, decision });
    },
    async resolveContract() {},
    async listPendingTools() {
      return [];
    },
  };
  const host = new AgentHost({ runtime, sessions: sessionPort, approvals: approvalPort, limits: { replayWindowEvents: 50, ...limits } });
  return { host, runtime, sessions, approvals };
}

export function fakeOperations(sessions: Map<string, SessionSummary>): RacpHostOperations {
  let counter = 0;
  return {
    sessions: {
      async list() {
        return [...sessions.values()];
      },
      async create(input) {
        counter += 1;
        const created = { ...summary(`s${counter + 1}`), title: input.title ?? "New session", ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) };
        sessions.set(created.id, created);
        return created;
      },
      async configure(sessionId, input) {
        const current = sessions.get(sessionId);
        if (!current) throw new RacpError("NOT_FOUND", "session");
        const next = { ...current, ...(input.mode ? { mode: input.mode } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) };
        sessions.set(sessionId, next);
        return next;
      },
      async fork(sessionId) {
        const current = sessions.get(sessionId);
        if (!current) throw new RacpError("NOT_FOUND", "session");
        const forked = { ...current, id: `${sessionId}-fork`, title: `${current.title} (fork)` };
        sessions.set(forked.id, forked);
        return forked;
      },
      async rename(sessionId, title) {
        const current = sessions.get(sessionId);
        if (current) sessions.set(sessionId, { ...current, title });
      },
      async delete(sessionId) {
        sessions.delete(sessionId);
      },
      async compact() {
        return { accepted: true };
      },
    },
    projects: {
      async list() {
        return [{ id: "proj", label: "proj", archived: false }];
      },
      async register(path) {
        if (path.includes("missing")) throw new RacpError("REMOTE_PATH_NOT_FOUND", "no such directory");
        return { id: "proj-2", label: path.split("/").pop() ?? path, archived: false, path };
      },
      async browse(path) {
        return { path: path ?? "/home/user", entries: [{ name: "work", path: `${path ?? "/home/user"}/work` }] };
      },
    },
    workspace: {
      async list(_sessionId, path) {
        if (path.includes("..")) throw new RacpError("REMOTE_PATH_FORBIDDEN", "escapes root");
        return { entries: [{ name: "README.md", kind: "file", size: 12 }] };
      },
      async read(_sessionId, path) {
        if (path.includes("..")) throw new RacpError("REMOTE_PATH_FORBIDDEN", "escapes root");
        return { kind: "text", content: "hello", size: 5 };
      },
      async diff() {
        return { repo: true, clean: true, files: [] };
      },
    },
  };
}

export const OWNER_TOKEN = newDeviceToken();
export const VIEWER_TOKEN = newDeviceToken();

/**
 * An in-memory terminal access for the ownership suite: it remembers which
 * session each terminal was opened for, which is what the RACP admission path
 * resolves a terminal-addressed operation through (ADR 0325). Seeding a
 * terminal lets a test address one it did not open over the wire, and seed's
 * third argument lets a test give that terminal a replay ring so `attach` can
 * *succeed* — the path a real re-attach takes and the one a fake that always
 * returned `null` never exercised.
 */
export function fakeTerminalAccess(): {
  access: import("./host-operations.js").RacpTerminalAccess;
  seed(sessionId: string, terminalId: string, replay?: string): string;
} {
  const terminals = new Map<string, { sessionId: string; replay: string; cols: number; rows: number }>();
  let counter = 0;
  const access: import("./host-operations.js").RacpTerminalAccess = {
    async open(sessionId, options) {
      counter += 1;
      const terminalId = `term_${counter}`;
      terminals.set(terminalId, { sessionId, replay: "", cols: options.cols, rows: options.rows });
      return { terminalId, replay: "", cols: options.cols, rows: options.rows };
    },
    async input() {},
    async resize() {},
    async close(terminalId) {
      terminals.delete(terminalId);
    },
    sessionOf(terminalId) {
      return terminals.get(terminalId)?.sessionId;
    },
    async attach(terminalId) {
      const terminal = terminals.get(terminalId);
      if (!terminal) return null;
      return { terminalId, replay: terminal.replay, cols: terminal.cols, rows: terminal.rows };
    },
    detach() {},
  };
  return {
    access,
    seed(sessionId, terminalId, replay = "") {
      terminals.set(terminalId, { sessionId, replay, cols: 80, rows: 24 });
      return terminalId;
    },
  };
}

export async function credentialStore(): Promise<{ store: MemoryCredentialStore; authenticator: DeviceTokenAuthenticator }> {
  const store = new MemoryCredentialStore();
  await store.saveDevice({ deviceId: "dev_owner", label: "desktop", roles: ["owner"], tokenHash: hashToken(OWNER_TOKEN), createdAt: "2026-09-18T00:00:00.000Z" });
  await store.saveDevice({ deviceId: "dev_viewer", label: "watcher", roles: ["viewer"], tokenHash: hashToken(VIEWER_TOKEN), createdAt: "2026-09-18T00:00:00.000Z" });
  return { store, authenticator: new DeviceTokenAuthenticator(store) };
}

export type Harness = {
  server: RacpServer;
  host: AgentHost;
  runtime: FakeRuntime;
  sessions: Map<string, SessionSummary>;
  approvals: { tool: Array<{ requestId: string; decision: string }> };
  authenticator: DeviceTokenAuthenticator;
  store: MemoryCredentialStore;
  links: MemoryLink[];
  /** Open a client whose transport authenticates with `token` on every (re)connect. */
  connect(token: string, options?: Partial<ConstructorParameters<typeof RacpClient>[0]>): Promise<{ client: RacpClient; events: import("@pi-desktop/shared").RacpEventEnvelope[]; link: () => MemoryLink }>;
};

export async function harness(options: { limits?: Partial<import("@pi-desktop/shared").RacpLimits>; operations?: Partial<RacpHostOperations>; onRelayedToolsChanged?: (sessionId: string) => void; bindings?: ReadonlyArray<import("@pi-desktop/shared").RacpBinding> } = {}): Promise<Harness> {
  const { host, runtime, sessions, approvals } = buildHost(options.limits);
  const { store, authenticator } = await credentialStore();
  const operations = { ...fakeOperations(sessions), ...options.operations };
  const server = new RacpServer({
    agentHost: host,
    operations,
    authenticator,
    hostId: "host_test",
    serverVersion: "0.15.0",
    limits: options.limits,
    log: () => undefined,
    initializeTimeoutMs: 1_000,
    bindings: options.bindings ?? ["RACP-WS"],
    ...(options.onRelayedToolsChanged ? { onRelayedToolsChanged: options.onRelayedToolsChanged } : {}),
  });
  const links: MemoryLink[] = [];
  return {
    server,
    host,
    runtime,
    sessions,
    approvals,
    authenticator,
    store,
    links,
    async connect(token, clientOptions = {}) {
      const events: import("@pi-desktop/shared").RacpEventEnvelope[] = [];
      let current: MemoryLink | null = null;
      const transport: ClientTransportFactory = async () => {
        const auth: ConnectionAuth | null = await authenticator.authenticate({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "pending" });
        if (!auth) throw Object.assign(new Error("unauthorized"), { errorCode: "REMOTE_AUTH_FAILED" });
        const link = new MemoryLink();
        links.push(link);
        current = link;
        const accepted = server.accept(auth, link.serverSide());
        if (!accepted) throw Object.assign(new Error("refused"), { errorCode: "REMOTE_CONNECTION_FAILED" });
        return link.clientSide();
      };
      const client = new RacpClient({
        transport,
        client: { name: "test", version: "0.15.0" },
        onEvent: (envelope) => events.push(envelope),
        requestTimeoutMs: 2_000,
        sleep: async () => undefined,
        ...clientOptions,
      });
      await client.connect();
      return { client, events, link: () => current! };
    },
  };
}

export const owner: Principal = { subject: "dev_owner", roles: ["owner"], pairedDevice: true };

export async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
