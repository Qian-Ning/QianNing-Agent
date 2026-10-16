/**
 * The reverse tool relay (rollout R2b; protocol §9.4, architecture §6.3).
 *
 * A paired desktop advertises the tools it is willing to run on its own machine
 * (`tools/advertise`); the Host merges the eligible ones into the session's
 * catalog and, when the Agent calls one, sends a `tool/execute` server request
 * back down the advertising connection. Eligibility is not accidental: a plugin
 * tool whose manifest requires workspace or filesystem access is refused by an
 * explicit filter ({@link partitionRelayedTools}) because it would act on the
 * desktop's filesystem while the session root is on the Host — design decision 2
 * of `docs/spec/06-delivery/07-remote-control-rollout.md`, given its reason by
 * protocol §9.4 rule 4.
 *
 * The failure contract (protocol §9.4 rule 3) is the clause most easily got
 * wrong: a desktop that is gone or silent — its connection dropped mid-call, or
 * the deadline elapsed — fails the *tool* with `TOOL_FAILED` and is never retried
 * on another connection, and it must never surface as an exception that would
 * abort the turn. {@link ToolRelayRegistry.execute} therefore resolves an
 * outcome instead of rejecting.
 */
import {
  partitionRelayedTools,
  relayedToolDescriptor,
  type RacpRelayedToolDescriptor,
  type RacpToolExecuteParams,
  type RacpToolExecuteResult,
  type RacpToolsAdvertiseParams,
  type RacpToolsAdvertiseResult,
} from "@pi-desktop/shared";

/**
 * The minimal connection surface the relay drives. Kept structural so the
 * registry does not import `server.ts` back (the server owns it, and a cycle
 * between the two would be an accident of file layout rather than a boundary).
 */
export type RelayTargetConnection = {
  readonly id: string;
  readonly isClosed: boolean;
  /** A server-initiated request (spec §4.3); rejects when the connection is gone or the deadline elapses. */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>;
};

/** Deadline for a relayed `tool/execute` when the caller names none (spec §9.4 rule 3). */
export const RACP_RELAY_DEFAULT_TIMEOUT_MS = 30_000;

/** Why a relayed tool failed; the code is always `TOOL_FAILED`, the reason tells the cases apart. */
export type RacpRelayFailureReason = "no_advertiser" | "disconnected" | "timeout" | "client_error";

/**
 * The result of executing a relayed tool. Never an exception: a tool-level
 * failure is a value the caller records as a tool result, which is exactly what
 * keeps the turn alive (spec §9.4 rule 3).
 */
export type RacpRelayedToolOutcome =
  | { status: "answered"; result: unknown; isError: boolean }
  | { status: "failed"; code: "TOOL_FAILED"; reason: RacpRelayFailureReason; message: string };

type Advertisement = {
  connection: RelayTargetConnection;
  sessionId: string;
  tools: RacpRelayedToolDescriptor[];
};

/**
 * Told which session's catalog changed after an advertisement is recorded or a
 * connection's advertisement is released. A session's catalog can change on an
 * `advertise` (a desktop connecting or re-advertising) and on a disconnect
 * (`release`), and the consumer must resync that session's tool list — so the
 * notification carries the session id, never a delta the caller has to
 * reconcile against a snapshot it might have missed.
 */
export type RelayCatalogChangeListener = (sessionId: string) => void;

/**
 * Per-Host registry of the tools connected desktops advertise for relay. One
 * advertisement per connection (spec §6.1: `tools/advertise` "replaces the
 * connection's previous set"), cleared when the connection is released.
 *
 * `onChange` is the fan-out seam the embedding host (pi-host) uses to keep the
 * Agent runtime's tool list in step with the relayed catalog. It is optional so
 * the registry stays usable without a consumer, and it is invoked synchronously
 * after the registry's own state mutates, so a listener that re-reads
 * `catalogFor` observes the change it was told about.
 */
export class ToolRelayRegistry {
  private readonly advertisements = new Map<string, Advertisement>();

  constructor(private readonly onChange?: RelayCatalogChangeListener) {}

  /**
   * Record one connection's advertised set and return the session's merged
   * catalog. The exclusion filter runs here, on the Host, so a desktop that
   * advertises a workspace-bound plugin tool is refused a catalog entry and told
   * why, rather than trusted to have filtered itself.
   */
  advertise(connection: RelayTargetConnection, params: RacpToolsAdvertiseParams): RacpToolsAdvertiseResult {
    const { eligible, rejected } = partitionRelayedTools(params.tools);
    this.advertisements.set(connection.id, {
      connection,
      sessionId: params.sessionId,
      tools: eligible.map(relayedToolDescriptor),
    });
    const tools = this.catalogFor(params.sessionId);
    this.onChange?.(params.sessionId);
    return { tools, rejected };
  }

  /**
   * Drop a connection's advertisement when it disconnects (spec §6.1). The
   * released session is reported to the change listener, because a disconnect
   * removes tools from a catalog just as an advertisement adds them.
   */
  release(connectionId: string): void {
    const advertisement = this.advertisements.get(connectionId);
    if (!advertisement) return;
    this.advertisements.delete(connectionId);
    this.onChange?.(advertisement.sessionId);
  }

  /** The merged, de-duplicated relayed catalog a session currently sees. */
  catalogFor(sessionId: string): RacpRelayedToolDescriptor[] {
    const merged = new Map<string, RacpRelayedToolDescriptor>();
    for (const advertisement of this.advertisements.values()) {
      if (advertisement.sessionId !== sessionId || advertisement.connection.isClosed) continue;
      for (const tool of advertisement.tools) merged.set(tool.name, tool);
    }
    return [...merged.values()];
  }

  /** Whether a live connection advertises at least one tool for this session. */
  hasAdvertiser(sessionId: string): boolean {
    for (const advertisement of this.advertisements.values()) {
      if (advertisement.sessionId === sessionId && !advertisement.connection.isClosed) return true;
    }
    return false;
  }

  /** The live connection that advertises `toolName` for `sessionId`, or `undefined`. */
  advertiserFor(sessionId: string, toolName: string): RelayTargetConnection | undefined {
    for (const advertisement of this.advertisements.values()) {
      if (advertisement.sessionId !== sessionId || advertisement.connection.isClosed) continue;
      if (advertisement.tools.some((tool) => tool.name === toolName)) return advertisement.connection;
    }
    return undefined;
  }

  /**
   * Run one relayed tool on the desktop that advertised it. Resolves an outcome;
   * a desktop that is gone, silent, or answers with an error fails the tool with
   * `TOOL_FAILED` and the turn continues (spec §9.4 rule 3). Nothing is retried
   * on another connection.
   */
  async execute(params: RacpToolExecuteParams, timeoutMs = RACP_RELAY_DEFAULT_TIMEOUT_MS): Promise<RacpRelayedToolOutcome> {
    const connection = this.advertiserFor(params.sessionId, params.toolName);
    if (!connection) {
      return {
        status: "failed",
        code: "TOOL_FAILED",
        reason: "no_advertiser",
        message: `no desktop advertises tool ${params.toolName} for this session`,
      };
    }
    try {
      const answer = await connection.request<RacpToolExecuteResult>("tool/execute", params, timeoutMs);
      return { status: "answered", result: answer?.result, isError: answer?.isError === true };
    } catch (error) {
      // The transport rejects a pending server request with `AGENT_UNAVAILABLE`
      // when the connection closes and `TOOL_FAILED` when the deadline elapsed
      // (server.ts). Both are normalised to the one tool-level failure the spec
      // names, so the caller sees a single code and never an exception.
      return {
        status: "failed",
        code: "TOOL_FAILED",
        reason: relayFailureReason(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function relayFailureReason(error: unknown): RacpRelayFailureReason {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "AGENT_UNAVAILABLE" || code === "HOST_DISCONNECTED") return "disconnected";
  if (code === "TOOL_FAILED" || code === "TIMEOUT") return "timeout";
  return "client_error";
}
