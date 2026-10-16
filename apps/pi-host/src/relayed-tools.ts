/**
 * The pi-host half of the reverse tool relay's runtime wiring (rollout R2b,
 * spec §9.4, architecture §6.3).
 *
 * The relay itself already exists and is tested where it lives: the RACP
 * registry records what each connected desktop advertises
 * (`ToolRelayRegistry`) and `RacpServer.executeRelayedTool` runs one relayed
 * call. What was missing is the seam that makes those reachable from a real
 * agent turn, and that is what this module adds:
 *
 * - it feeds a session's advertised tools into the runtime's tool list, so an
 *   advertised desktop tool is actually offered to the agent in that session; and
 * - it routes the agent's call for such a tool through
 *   `RacpServer.executeRelayedTool` to the desktop and returns the outcome.
 *
 * Both go through the two seams the embedding host already owns: the
 * `AgentSidecar`'s host-local tool registry (`setLocalTool` / `removeLocalTool`)
 * for execution, and its per-session `tools.list` overlay
 * (`setSessionTools` / `clearSessionTools`) for the catalogue.
 *
 * ## Lifecycle and ordering
 *
 * The registry notifies this bridge on every catalog change — an advertise (a
 * desktop connecting or re-advertising) and a release (a disconnect) — and the
 * bridge resyncs from `relayedCatalog(session)` rather than applying a delta.
 * That ordering is deliberate:
 *
 * 1. The registry mutates its own state first and notifies second, so a
 *    resync reads the catalog the notification is about, never a stale one.
 * 2. `advertise` notifies before it returns to the desktop, so a turn started
 *    after the advertisement resolves already sees the tool.
 * 3. A turn already past `refreshHostTools` keeps the catalogue it was given;
 *    the runtime re-reads on the next prompt, so a late advertisement lands on
 *    the session's next turn, exactly like the host capability mirror.
 * 4. `release` notifies after deleting the advertisement, so the resync sees an
 *    empty catalog and both the overlay entry and the local tool are withdrawn.
 *    A `tool/execute` already in flight is unaffected: the sidecar captured the
 *    handler before the call, and `executeRelayedTool` resolves a failed tool
 *    (never an exception) when the advertising connection is gone, so the turn
 *    survives (spec §9.4 rule 3).
 *
 * Resync is idempotent, which is what makes it safe across an `AgentSidecar`
 * restart: the supervisor can build a fresh sidecar with an empty registry, and
 * `refresh()` re-applies the whole catalog to it.
 */
import type {
  RacpRelayedToolDescriptor,
  RacpToolExecuteParams,
} from "@pi-desktop/shared";
import type { LocalToolHandler, LocalToolResult, SidecarSessionTool } from "@pi-desktop/host-runtime";
import type { RacpRelayedToolOutcome } from "@pi-desktop/racp";

/** The relay's server half, as the bridge reads it: `RacpServer` satisfies this. */
export type RelayedToolCatalogPort = {
  /** The merged, live relayed catalog for a session (empty when none). */
  relayedCatalog(sessionId: string): RacpRelayedToolDescriptor[];
  /** Run one relayed tool on the advertising desktop; resolves an outcome, never rejects. */
  executeRelayedTool(
    request: Omit<RacpToolExecuteParams, "executionId"> & { executionId?: string },
    timeoutMs?: number,
  ): Promise<RacpRelayedToolOutcome>;
};

/** The sidecar seam the bridge drives: `AgentSidecar` satisfies this. */
export type RelayedToolSidecarPort = {
  setLocalTool(name: string, handler: LocalToolHandler): void;
  removeLocalTool(name: string): void;
  setSessionTools(sessionId: string, tools: readonly SidecarSessionTool[]): void;
  clearSessionTools(sessionId: string): void;
};

export type RelayedToolBridgeOptions = {
  server: RelayedToolCatalogPort;
  /** Resolved on every refresh, so a restarted sidecar is picked up. */
  getSidecar: () => RelayedToolSidecarPort | null;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  /** Deadline for one relayed call; the relay's own default applies when omitted. */
  timeoutMs?: number;
};

/** The `tools/list` entry shape the runtime mirrors (see agent-sidecar `mergeSessionTools`). */
function toSessionTool(tool: RacpRelayedToolDescriptor): SidecarSessionTool {
  // The descriptor carries no argument schema (the relay advertises name,
  // description and kind only), so the runtime offers the tool with an open
  // object schema; the model supplies arguments the desktop interprets.
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
  };
}

/**
 * Map a relayed outcome to the host-local tool result the sidecar forwards. A
 * failure is a *tool* result with `isError`, never a thrown exception, so the
 * runtime records a failed tool and the turn continues (spec §9.4 rule 3).
 */
function toLocalToolResult(outcome: RacpRelayedToolOutcome): LocalToolResult {
  if (outcome.status === "failed") {
    return { ok: false, isError: true, errorCode: outcome.code, content: outcome.message };
  }
  if (outcome.isError) return { ok: false, isError: true, content: outcome.result };
  return { ok: true, content: outcome.result };
}

export class RelayedToolBridge {
  /** Per-session catalogs the Host currently holds for connected desktops. */
  private readonly catalogs = new Map<string, RacpRelayedToolDescriptor[]>();
  /** Names with a host-local tool registration in the current sidecar. */
  private registeredNames = new Set<string>();
  /** Sessions whose overlay is currently applied, for clearing the ones that go away. */
  private overlaidSessions = new Set<string>();
  private readonly handlers = new Map<string, LocalToolHandler>();

  constructor(private readonly options: RelayedToolBridgeOptions) {}

  /** Called for the session whose relayed catalog just changed. */
  onCatalogChanged(sessionId: string): void {
    const catalog = this.options.server.relayedCatalog(sessionId);
    if (catalog.length === 0) this.catalogs.delete(sessionId);
    else this.catalogs.set(sessionId, catalog);
    this.refresh();
  }

  /**
   * Re-apply the tracked catalogs to the current sidecar. Idempotent: it
   * reconciles the overlay and the local-tool set from the catalogs rather than
   * assuming any particular previous state, so it is also the right call after
   * the sidecar is (re)started with an empty registry.
   */
  refresh(): void {
    const sidecar = this.options.getSidecar();
    if (!sidecar) return;

    for (const [sessionId, catalog] of this.catalogs) {
      sidecar.setSessionTools(sessionId, catalog.map(toSessionTool));
    }
    for (const sessionId of this.overlaidSessions) {
      if (!this.catalogs.has(sessionId)) sidecar.clearSessionTools(sessionId);
    }
    this.overlaidSessions = new Set(this.catalogs.keys());

    // One host-local tool per distinct advertised name. Two desktops may
    // advertise the same name for different sessions; the handler resolves the
    // session at call time through `executeRelayedTool`, so one registration
    // serves them all and the relay picks the advertising connection.
    const union = new Set<string>();
    for (const catalog of this.catalogs.values()) {
      for (const tool of catalog) union.add(tool.name);
    }
    for (const name of union) {
      if (!this.registeredNames.has(name)) sidecar.setLocalTool(name, this.handlerFor(name));
    }
    for (const name of this.registeredNames) {
      if (!union.has(name)) sidecar.removeLocalTool(name);
    }
    this.registeredNames = union;
  }

  /** Withdraw every registration and overlay this bridge applied. */
  dispose(): void {
    const sidecar = this.options.getSidecar();
    if (sidecar) {
      for (const name of this.registeredNames) sidecar.removeLocalTool(name);
      for (const sessionId of this.overlaidSessions) sidecar.clearSessionTools(sessionId);
    }
    this.catalogs.clear();
    this.handlers.clear();
    this.registeredNames = new Set();
    this.overlaidSessions = new Set();
  }

  private handlerFor(name: string): LocalToolHandler {
    const existing = this.handlers.get(name);
    if (existing) return existing;
    const handler: LocalToolHandler = async ({ sessionId, toolCallId, turnId, args }) => {
      const outcome = await this.options.server.executeRelayedTool(
        {
          sessionId,
          toolCallId,
          toolName: name,
          args,
          // The turn id is not required by the relay, but when the runtime named
          // one it is carried to the desktop so both sides can correlate the
          // execution with the turn it belongs to (spec §9.4 rule 5).
          ...(turnId ? { turnId } : {}),
        },
        this.options.timeoutMs,
      );
      if (outcome.status === "failed") {
        this.options.log("warn", "relayed tool failed", {
          sessionId,
          toolName: name,
          reason: outcome.reason,
        });
      }
      return toLocalToolResult(outcome);
    };
    this.handlers.set(name, handler);
    return handler;
  }
}
