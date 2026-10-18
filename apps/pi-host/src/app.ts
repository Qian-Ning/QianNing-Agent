import { mkdir } from "node:fs/promises";

import { AgentHost, type ApprovalPort } from "@pi-desktop/agent-host";
import {
  AgentSidecar,
  HostProcess,
  PlanExecutionDispatcher,
  RuntimeService,
  RuntimeSupervisor,
  createHeadlessLaunchResolver,
  createHostQueueStore,
  createHostSecretReader,
  createHostSessionPort,
  createHostSettingsSurface,
  createMessagingInboundWiring,
  createMessagingOutboundRelay,
  createSlackInboundWiring,
  createDiscordInboundWiring,
  createMattermostInboundWiring,
  createMatrixInboundWiring,
  createNtfyInboundWiring,
  createHomeAssistantInboundWiring,
  createIrcInboundWiring,
  listPendingToolRequests,
  registerSkillAuthoringTools,
  settleWithinBudget,
  type MessagingInboundHandle,
  type MessagingOutboundRelay,
} from "@pi-desktop/host-runtime";
import { DeviceTokenAuthenticator, RacpServer, bindRacpWebSocket, type RacpHostOperations, type WsBinding } from "@pi-desktop/racp";
import { APP_VERSION, type AgentEventEnvelope } from "@pi-desktop/shared";

import type { PiHostConfig } from "./config.js";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";
import { createHostOperations } from "./host-operations.js";
import { createLogger, type HostLogger } from "./logger.js";
import { RelayedToolBridge } from "./relayed-tools.js";
import { TerminalService, loadPty } from "./terminal.js";

export type PiHostApp = {
  hostId: string;
  address: { host: string; port: number };
  agentHost: AgentHost;
  runtime: RuntimeService;
  authenticator: DeviceTokenAuthenticator;
  server: RacpServer;
  log: HostLogger;
  /** Mint a single-use pairing token for the bootstrap channel. */
  issuePairingToken(lifetimeMs: number): Promise<{ token: string; expiresAt: string }>;
  stop(): Promise<void>;
};

const APPROVAL_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long headless stop waits for the inbound loop to leave `run` after its
 * abort. Its own host calls carry no abort signal, so a single in-flight
 * iteration is bounded only by the host RPC deadline — far longer than a stop
 * may wait; this budget keeps a stop from stalling on it.
 */
const MESSAGING_INBOUND_STOP_BUDGET_MS = 2_000;

/**
 * Compose the headless Host: host-core and the sidecar under the shared
 * supervisor, the runtime service as the module's runtime port, the Agent
 * Host module, and the RACP server on loopback. Everything the desktop
 * would own for a local session — transcript, queue, approvals, tools,
 * workspace — lives here on this machine.
 */
export async function startPiHost(config: PiHostConfig, options: { log?: HostLogger } = {}): Promise<PiHostApp> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const log = options.log ?? createLogger({ dataDir: config.dataDir, minLevel: config.logLevel });
  const hostId = await loadOrCreateHostId(config.dataDir);
  const store = new FileCredentialStore(config.dataDir);
  const authenticator = new DeviceTokenAuthenticator(store);

  const state: { host: HostProcess | null; sidecar: AgentSidecar | null; stopping: boolean } = { host: null, sidecar: null, stopping: false };
  const getHost = () => state.host;
  const getSidecar = () => state.sidecar;

  /**
   * The reverse tool relay's runtime wiring (spec §9.4). Declared before the
   * sidecar boot so a restart can re-apply it, and assigned once the RACP server
   * exists; every method is a no-op while it is undefined.
   */
  let relayedTools: RelayedToolBridge | undefined;

  const launch = createHeadlessLaunchResolver({ getHost, dataDir: config.dataDir, log: (level, message, data) => log(level, message, data) });
  const runtime = new RuntimeService({ getHost, getSidecar, launch, log });

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      await host.call("permissions.resolve", { requestId, decision });
    },
    async resolveContract(input) {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>("plans.pending", { sessionId: input.sessionId });
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw Object.assign(new Error(`proposal ${input.proposalId} is not pending`), { errorCode: "NOT_FOUND" });
      const result = await host.call("plans.resolve", {
        proposalId: input.proposalId,
        sessionId: input.sessionId,
        turnId: proposal.turnId ?? "",
        toolCallId: proposal.toolCallId ?? "",
        action: input.action,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
      });
      if (input.action === "approve") void plans.dispatchExecutionForProposal(input.proposalId);
      return void result;
    },
    listPendingTools: (sessionId) => listPendingToolRequests(getHost, sessionId),
  };
  const agentHost = new AgentHost({
    runtime,
    sessions: createHostSessionPort(getHost),
    approvals,
    queueStore: createHostQueueStore(getHost),
    localApprovalLifetimeMs: APPROVAL_REQUEST_TIMEOUT_MS,
  });
  const plans = new PlanExecutionDispatcher({ getHost, getSidecar, launch, runtime, log });

  // Every runtime event feeds the module; a settled turn closes it there too.
  const abortingSessions = new Set<string>();
  runtime.onEvent((envelope: AgentEventEnvelope) => {
    const interrupted = envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
    if (envelope.event.type === "agent_end" || envelope.event.type === "error") abortingSessions.delete(envelope.sessionId);
    try {
      agentHost.ingest(envelope, { interrupted });
    } catch (error) {
      log("warn", "agent host ingest failed", { sessionId: envelope.sessionId, type: envelope.event.type, error: String(error) });
    }
  });
  runtime.onTurnEnded((info) => {
    abortingSessions.delete(info.sessionId);
    const status = info.reason === "aborted" ? "interrupted" : info.reason === "error" ? "failed" : "completed";
    try {
      agentHost.endTurn(info.sessionId, info.turnId, status, info.errorCode ? { error: { code: info.errorCode, message: info.errorCode, retriable: false, traceId: "" } } : {});
      agentHost.kick(info.sessionId);
    } catch (error) {
      log("warn", "agent host end turn failed", { sessionId: info.sessionId, turnId: info.turnId, error: String(error) });
    }
  });
  const originalAbort = runtime.abort.bind(runtime);
  runtime.abort = async (sessionId, turnId) => {
    abortingSessions.add(sessionId);
    try {
      await originalAbort(sessionId, turnId);
    } catch (error) {
      abortingSessions.delete(sessionId);
      throw error;
    }
  };

  const startHost = async () => {
    const host = new HostProcess({ binaryPath: config.hostCoreBinary, dataDir: config.dataDir, onStderr: log.child("host") });
    host.onExit(({ intentional }) => {
      if (state.host !== host) return;
      state.host = null;
      if (intentional || state.stopping) return;
      log("error", "host-core exited unexpectedly");
      void supervisor.superviseRestart("host");
    });
    state.host = host;
    try {
      await host.handshake();
      await host.call("session.recoverInflightMessages").catch((error: unknown) => log("warn", "in-flight recovery failed", { error: String(error) }));
    } catch (error) {
      if (state.host === host) state.host = null;
      await host.dispose();
      throw error;
    }
    runtime.attachHost(host);
    state.sidecar?.setHost(host);
    log("info", "host-core handshake ok", { generation: host.generation });
  };
  const startSidecar = async () => {
    const sidecar = new AgentSidecar({
      launch: { command: config.nodeBinary, args: [config.sidecarEntry], env: { ...process.env, PI_DESKTOP_DATA_DIR: config.dataDir } },
      onStderr: log.child("agent"),
    });
    sidecar.onExit(({ intentional, code, signal, stderrTail }) => {
      if (state.sidecar !== sidecar) return;
      state.sidecar = null;
      if (intentional || state.stopping) return;
      log("error", "agent sidecar exited unexpectedly", { exitCode: code, signal, stderrTail });
      void supervisor.superviseRestart("sidecar");
    });
    sidecar.setLocalTool("Skill", async ({ args, sessionId }) => {
      const id = String((args as { id?: unknown })?.id ?? "").trim();
      const host = getHost();
      if (!id || !host) return { ok: false, isError: true, content: "Skill: `id` is required." };
      const session = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(() => null);
      const result = await host.call<{ skill: { id: string; name: string } | null; body: string | null }>("skills.read", { id, projectPath: session?.session?.projectPath ?? null }).catch(() => null);
      if (!result?.skill || typeof result.body !== "string") return { ok: false, isError: true, content: `Skill: "${id}" is not available on this Host.` };
      return { ok: true, content: `# Skill: ${result.skill.name} (${result.skill.id})\n\n${result.body}` };
    });
    // The headless host embeds the same runtime, so the tool catalogue it builds
    // advertises SkillCreate too; without a handler here the model would be
    // offered a tool that always fails.
    registerSkillAuthoringTools(sidecar, {
      createUserSkill: async ({ name, description, body }) => {
        const host = getHost();
        if (!host) throw new Error("host unavailable");
        return host.call("skills.create", { skill: { name, description, body } });
      },
    });
    sidecar.setTrustedExtensionBridge({
      publishCommands: () => undefined,
      publishDiagnostics: () => undefined,
      requestUi: async () => {
        throw new Error("extension UI is not available on a headless host");
      },
      configureModel: async () => {
        throw new Error("extension model configuration is not available on a headless host");
      },
      queuePush: async (params) =>
        agentHost.startTurn({ subject: "extension", roles: ["controller"] }, {
          sessionId: String(params.sessionId ?? ""),
          admission: "queue",
          input: { text: String(params.content ?? "") },
          context: { requestId: `ext-${Date.now().toString(36)}`, ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) },
        }),
      queuePrioritize: async (params) => agentHost.prioritizeTurn({ subject: "extension", roles: ["controller"] }, String(params.id ?? "")),
    });
    state.sidecar = sidecar;
    runtime.attachSidecar(sidecar);
    if (state.host) sidecar.setHost(state.host);
    // A restarted sidecar comes up with an empty host-local tool registry, so
    // re-apply the relayed tools the Host currently holds: a live advertisement
    // must survive a sidecar crash, not silently stop being offered.
    relayedTools?.refresh();
    await sidecar.call("sidecar.configure", { hostBinary: config.hostCoreBinary, dataDir: config.dataDir });
    log("info", "agent sidecar configured");
  };
  const supervisor = new RuntimeSupervisor({
    start: { host: startHost, sidecar: startSidecar },
    afterRestart: () => plans.drainApprovedPlanExecutions(),
    isShuttingDown: () => state.stopping,
    onEvent: (event) => {
      if (event.phase === "fatal") log("error", `${event.kind} restart gave up`, { reason: event.reason, error: event.error ? String(event.error) : undefined });
      else if (event.phase === "restarted") log("warn", `${event.kind} restarted after crash`, { attempt: event.attempt });
      else if (event.phase === "restart_failed") log("error", `${event.kind} restart failed`, { attempt: event.attempt, error: String(event.error) });
    },
  });

  await startHost();
  await startSidecar();
  await agentHost.start();
  await plans.drainApprovedPlanExecutions().catch((error: unknown) => log("warn", "queued approved plan drain failed", { error: String(error) }));

  // The inbound messaging command path: a linked chat's commands act on the
  // session bound to it, through the same Agent Host the RACP handlers call.
  // The loop re-reads the channel's settings on every poll and holds no host
  // state across one; `stop()` aborts this controller and awaits the loop
  // before the host is disposed, so the loop cannot outlive the Host.
  const messagingAbort = new AbortController();
  const messaging: MessagingInboundHandle = {
    controller: messagingAbort,
    done: createMessagingInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The inbound Slack command path over Socket Mode (ADR 0326), beside the
  // Telegram loop: the same driver, over an outbound WSS connection the Host
  // originates (no port is bound). Config-gated on the Slack app-level token —
  // with none configured the transport starts nothing and this loop resolves at
  // once, so nothing changes with nothing configured. `stop()` aborts this
  // controller and awaits the loop, bounded, before the host is disposed.
  const messagingSlackAbort = new AbortController();
  const messagingSlack: MessagingInboundHandle = {
    controller: messagingSlackAbort,
    done: createSlackInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingSlackAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The inbound Discord and Mattermost channels, beside the Telegram and Slack
  // loops: the same driver over outbound gateway websockets the Host
  // originates (no port is bound). Each is config-gated on its own token and
  // record, so a Host with neither configured starts nothing. `stop()` aborts
  // both controllers and awaits them, bounded, before the host is disposed.
  const messagingDiscordAbort = new AbortController();
  const messagingDiscord: MessagingInboundHandle = {
    controller: messagingDiscordAbort,
    done: createDiscordInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingDiscordAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };
  const messagingMattermostAbort = new AbortController();
  const messagingMattermost: MessagingInboundHandle = {
    controller: messagingMattermostAbort,
    done: createMattermostInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingMattermostAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };
  // The Matrix sync loop, beside the other inbound loops: a long poll the Host
  // originates against the user's own homeserver, config-gated on its token and
  // record. Nothing is bound and nothing is polled until it is configured.
  const messagingMatrixAbort = new AbortController();
  const messagingMatrix: MessagingInboundHandle = {
    controller: messagingMatrixAbort,
    done: createMatrixInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingMatrixAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The inbound IRC channel, beside the others: the same driver over a raw TLS
  // connection the Host originates (no port is bound). Config-gated on its
  // record, nick and linked channel, so a Host with no IRC section starts
  // nothing. `stop()` aborts this controller and awaits the loop, bounded,
  // before the host is disposed.
  const messagingIrcAbort = new AbortController();
  const messagingIrc: MessagingInboundHandle = {
    controller: messagingIrcAbort,
    done: createIrcInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingIrcAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The inbound Home Assistant channel, beside the others: the same driver over
  // its own websocket, which the Host originates (no port is bound).
  // Config-gated on the long-lived access token and the channel record, so a
  // Host with no Home Assistant section starts nothing. Inbound is real but
  // authored: a message arrives only from an automation that fires
  // `qianning_message` in the user's Home Assistant.
  const messagingHomeAssistantAbort = new AbortController();
  const messagingHomeAssistant: MessagingInboundHandle = {
    controller: messagingHomeAssistantAbort,
    done: createHomeAssistantInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingHomeAssistantAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The inbound ntfy channel, beside the others: a `/json` long poll the Host
  // originates (no port is bound), config-gated on its base URL and topic. One
  // topic carries both directions; the send path tags what it publishes and the
  // receive path drops a message carrying that tag, so the channel cannot
  // answer itself.
  const messagingNtfyAbort = new AbortController();
  const messagingNtfy: MessagingInboundHandle = {
    controller: messagingNtfyAbort,
    done: createNtfyInboundWiring({
      agentHost,
      settings: createHostSettingsSurface(getHost),
      secrets: createHostSecretReader(getHost),
      signal: messagingNtfyAbort.signal,
      log: (level, message, data) => log(level, message, data),
    }).run(),
  };

  // The outbound messaging relay (ADR 0205 D375 item 9, rollout R3): the
  // Host-side redactor subscribed on the host-scope event surface, so the
  // redacted summaries of terminal turn outcomes and host-owned requests reach
  // the durable delivery ledger in host-core and then the channels. Config-gated
  // on each channel's own settings record — with no channel configured nothing
  // is subscribed and no delivery is issued, so nothing changes with nothing
  // configured. Started beside the two inbound loops; `stop()` releases its
  // subscriptions, bounded, before the host is disposed.
  const messagingOutbound: MessagingOutboundRelay = createMessagingOutboundRelay({
    agentHost,
    settings: createHostSettingsSurface(getHost),
    getHost,
    log: (level, message, data) => log(level, message, data),
  });

  const pty = loadPty();
  const terminal = pty
    ? new TerminalService({
        pty,
        log,
        sessionRoot: async (sessionId) => {
          const host = getHost();
          if (!host) throw new Error("host unavailable");
          const result = await host.call<{ session?: { projectPath?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 });
          const root = result.session?.projectPath?.trim();
          if (!root) throw Object.assign(new Error("the session has no project root"), { errorCode: "CONFLICT" });
          return root;
        },
      })
    : undefined;
  if (!pty) log("warn", "node-pty is not installed; terminals are disabled");

  const operations: RacpHostOperations = {
    ...createHostOperations({
      getHost,
      runtime,
      browseRoot: config.browseRoot,
      disposeSession: async (sessionId) => {
        const sidecar = getSidecar();
        if (!sidecar) return;
        await sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
      },
      revokeDevice: (deviceId) => store.revokeDevice(deviceId, new Date().toISOString()),
    }),
    ...(terminal ? { terminal } : {}),
  };
  const server = new RacpServer({
    agentHost,
    operations,
    authenticator,
    hostId,
    serverVersion: APP_VERSION,
    log,
    // The relay's catalog changes feed the runtime's tool list (spec §9.4). The
    // callback reads the bridge through a closure because the server is built
    // first and the bridge needs the server; the server only calls it once a
    // desktop advertises or disconnects, long after both exist.
    onRelayedToolsChanged: (sessionId) => relayedTools?.onCatalogChanged(sessionId),
  });
  relayedTools = new RelayedToolBridge({ server, getSidecar, log });
  let binding: WsBinding;
  try {
    binding = await bindRacpWebSocket({ server: server, authenticator, host: config.host, port: config.port, log });
  } catch (error) {
    state.stopping = true;
    await state.sidecar?.dispose();
    await state.host?.dispose();
    throw error;
  }
  log("info", "pi-host ready", { hostId, host: binding.address.host, port: binding.address.port, version: APP_VERSION, terminal: Boolean(terminal) });

  return {
    hostId,
    address: binding.address,
    agentHost,
    runtime,
    authenticator,
    server,
    log,
    issuePairingToken: (lifetimeMs) => authenticator.issuePairingToken(lifetimeMs),
    async stop() {
      if (state.stopping) return;
      state.stopping = true;
      log("info", "pi-host stopping");
      // Stop the inbound loop first: it reads and writes the settings row
      // through host-core, so it must be finished before the host is disposed.
      // The loop re-checks the signal between iterations, but a single
      // in-flight iteration can be waiting on a host RPC whose deadline is far
      // longer than a stop may wait, so the wait is bounded; giving up on it
      // still lets the rest of stop proceed.
      messaging.controller.abort();
      await settleWithinBudget(messaging.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The Slack Socket Mode loop stops the same way, beside the Telegram loop
      // and before the host is disposed: abort, then a bounded wait.
      messagingSlack.controller.abort();
      await settleWithinBudget(messagingSlack.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The Discord and Mattermost gateway loops stop the same way, beside the
      // other inbound loops and before the host is disposed.
      messagingDiscord.controller.abort();
      await settleWithinBudget(messagingDiscord.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      messagingMattermost.controller.abort();
      await settleWithinBudget(messagingMattermost.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The Matrix sync loop stops the same way: its long poll is aborted and
      // awaited under the same bound.
      messagingMatrix.controller.abort();
      await settleWithinBudget(messagingMatrix.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The IRC socket loop stops the same way, under the same bound.
      messagingIrc.controller.abort();
      await settleWithinBudget(messagingIrc.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The Home Assistant websocket loop stops the same way.
      messagingHomeAssistant.controller.abort();
      await settleWithinBudget(messagingHomeAssistant.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The ntfy long poll stops the same way, under the same bound.
      messagingNtfy.controller.abort();
      await settleWithinBudget(messagingNtfy.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      // The outbound relay is released the same way, beside the two loops and
      // before the host is disposed: it unsubscribes at once, and the (already
      // settled) wait is bounded so a release that ever refused to settle could
      // not stall a stop.
      messagingOutbound.stop();
      await settleWithinBudget(messagingOutbound.done, MESSAGING_INBOUND_STOP_BUDGET_MS);
      server.close();
      await binding.close();
      await terminal?.closeAll();
      // Withdraw the relayed-tool registrations while the sidecar is still
      // alive, so a fresh advertisement cannot be left pointing at a dead
      // sidecar registry.
      relayedTools?.dispose();
      plans.dispose();
      await runtime.dispose();
      await state.sidecar?.dispose();
      await state.host?.dispose();
      state.sidecar = null;
      state.host = null;
    },
  };
}
