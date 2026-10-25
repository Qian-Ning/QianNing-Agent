/**
 * The renderer's read-only window into session inline visualizations (ADR
 * 0327). Both channels are thin: validate the argument shape, forward to
 * host-core's `inlineViz.*` RPC, and return the answer. There is deliberately
 * no write channel — artifacts are written only by the agent runtime through
 * `tools.execute`, so a renderer compromise can read at most what the agent
 * already wrote to a session.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  InlineVisualizationArtifact,
  InlineVisualizationMeta,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

function requireHost(getHost: () => HostProcess | null): HostProcess {
  const host = getHost();
  if (!host) {
    throw Object.assign(new Error("host unavailable for inline visualizations"), {
      errorCode: "HOST_UNAVAILABLE",
    });
  }
  return host;
}

export function registerInlineVizIpc(options: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  const { registrar, getHost } = options;

  registrar.handle(IPC.invoke.inlineVizList, async (sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw Object.assign(new Error("sessionId is required"), {
        errorCode: "INVALID_ARGUMENT",
      });
    }
    const result = await requireHost(getHost).call<{
      visualizations: InlineVisualizationMeta[];
    }>("inlineViz.list", { sessionId });
    return result.visualizations;
  });

  registrar.handle(
    IPC.invoke.inlineVizRead,
    async (sessionId: unknown, visualizationId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw Object.assign(new Error("sessionId is required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      if (typeof visualizationId !== "string" || !visualizationId) {
        throw Object.assign(new Error("visualizationId is required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      const result = await requireHost(getHost).call<{
        visualization: InlineVisualizationArtifact;
      }>("inlineViz.read", { sessionId, visualizationId });
      return result.visualization;
    },
  );
}
