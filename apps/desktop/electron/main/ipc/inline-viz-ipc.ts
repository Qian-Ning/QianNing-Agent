/**
 * The renderer's window into session inline visualizations (ADR 0327, ADR
 * 0328). All channels are thin: validate the argument shape, forward to
 * host-core's `inlineViz.*` RPC, and return the answer. The read channels
 * show what exists; the write channel (ADR 0328) is the one renderer->host
 * mutation, and it is deliberately narrow — the same bounds as the agent
 * tool, an existing-session check, and a host-side audit row — so a renderer
 * compromise can at most plant a bounded, audited artifact into an existing
 * session's visualization root.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  InlineVisualizationArtifact,
  InlineVisualizationMeta,
} from "@pi-desktop/shared";
import { INLINE_VIZ_KINDS } from "@pi-desktop/shared";
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

  registrar.handle(
    IPC.invoke.inlineVizWrite,
    async (
      _event,
      sessionId: unknown,
      input: unknown,
    ): Promise<InlineVisualizationMeta> => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw Object.assign(new Error("sessionId is required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      // The renderer is untrusted at this boundary: only the three fields the
      // host validates are forwarded, and each must be the right primitive.
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("title, kind and content are required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      const { title, kind, content } = input as Record<string, unknown>;
      if (typeof title !== "string" || !title.trim()) {
        throw Object.assign(new Error("title is required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      if (typeof kind !== "string" || !INLINE_VIZ_KINDS.includes(kind as never)) {
        throw Object.assign(new Error("kind is not a visualization kind"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      if (typeof content !== "string") {
        throw Object.assign(new Error("content is required"), {
          errorCode: "INVALID_ARGUMENT",
        });
      }
      const result = await requireHost(getHost).call<{
        visualization: InlineVisualizationMeta;
      }>("inlineViz.write", { sessionId, title, kind, content });
      return result.visualization;
    },
  );
}
