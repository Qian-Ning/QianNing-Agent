/**
 * The desktop half of the reverse tool relay (rollout R2b; protocol §9.4).
 *
 * A paired desktop answers two things here:
 *
 * - it advertises, over `tools/advertise`, the tools it is willing to run on its
 *   own machine — its user-configured MCP servers and the plugin tools that do
 *   not need the session workspace; and
 * - it answers the Host's `tool/execute` server request by running the tool
 *   locally under the desktop's own plugin permissions and returning
 *   `{ result, isError }`.
 *
 * The eligibility rule is applied before advertising and comes from
 * `@pi-desktop/shared` — the same {@link partitionRelayedTools} the Host runs —
 * so a workspace- or filesystem-bound plugin tool is withheld here and, if it
 * ever slipped through, refused there. The reason is design decision 2 of
 * `docs/spec/06-delivery/07-remote-control-rollout.md`: such a tool would act on
 * the *desktop's* filesystem while the session root is on the Host.
 *
 * The transport is injected as a minimal `request` surface, so this module is
 * driven both by the real `RacpClient` and by the in-memory harness in tests.
 */
import {
  partitionRelayedTools,
  type RacpRelayedTool,
  type RacpToolExecuteParams,
  type RacpToolExecuteResult,
  type RacpToolsAdvertiseResult,
} from "@pi-desktop/shared";

/** The desktop's candidate relayed tools: its MCP tools and its plugin tools. */
export type DesktopRelayToolSource = {
  listTools(): Promise<readonly RacpRelayedTool[]>;
};

/**
 * Runs one relayed tool on the desktop. The implementation owns the desktop's
 * plugin permission checks and confirmation rules (spec §9.4 rule 2: the Host has
 * already made its own decision, the client does not re-ask it).
 */
export type DesktopToolRunner = {
  run(params: RacpToolExecuteParams): Promise<RacpToolExecuteResult>;
};

export type DesktopToolRelayOptions = {
  /** The RACP client the relay speaks over; only `request` is used. */
  client: { request<T>(method: string, params?: unknown): Promise<T> };
  tools: DesktopRelayToolSource;
  runner: DesktopToolRunner;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type DesktopToolRelay = {
  /** Advertise the eligible tools for a session; the Host returns the resulting catalog. */
  advertise(sessionId: string): Promise<RacpToolsAdvertiseResult>;
  /** The tools this desktop offers, already split into eligible and excluded. */
  eligibleTools(): Promise<{ eligible: RacpRelayedTool[]; excluded: Array<{ name: string; reason: string }> }>;
  /**
   * Answer a server request. Returns `undefined` for any method this relay does
   * not own, so the caller can compose it with the approval and input handlers
   * on the one `onServerRequest` slot `RacpClient` exposes.
   */
  onServerRequest(method: string, params: unknown): Promise<unknown> | undefined;
};

export function createDesktopToolRelay(options: DesktopToolRelayOptions): DesktopToolRelay {
  const log = options.log ?? (() => undefined);

  const collect = async (): Promise<{ eligible: RacpRelayedTool[]; excluded: Array<{ name: string; reason: string }> }> => {
    const advertised = await options.tools.listTools();
    const { eligible, rejected } = partitionRelayedTools(advertised);
    if (rejected.length > 0) {
      log("info", "desktop tools withheld from the relay", { excluded: rejected });
    }
    return { eligible, excluded: rejected };
  };

  return {
    eligibleTools: collect,

    async advertise(sessionId: string): Promise<RacpToolsAdvertiseResult> {
      const { eligible } = await collect();
      const result = await options.client.request<RacpToolsAdvertiseResult>("tools/advertise", {
        sessionId,
        tools: eligible,
      });
      log("info", "advertised relayed tools", {
        sessionId,
        accepted: result.tools.length,
        rejected: result.rejected.length,
      });
      return result;
    },

    onServerRequest(method: string, params: unknown): Promise<unknown> | undefined {
      if (method !== "tool/execute") return undefined;
      const request = params as RacpToolExecuteParams;
      return (async (): Promise<RacpToolExecuteResult> => {
        try {
          const answer = await options.runner.run(request);
          return {
            ...(answer?.result === undefined ? {} : { result: answer.result }),
            isError: answer?.isError === true,
          };
        } catch (error) {
          // A tool that throws is a tool-level error, answered as a result so the
          // remote turn records a failed tool and continues (spec §9.4 rule 3),
          // not a protocol failure that would look like the connection broke.
          log("warn", "relayed tool threw on the desktop", {
            toolName: request.toolName,
            error: String(error),
          });
          return { result: error instanceof Error ? error.message : String(error), isError: true };
        }
      })();
    },
  };
}
