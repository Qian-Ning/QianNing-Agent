import type { ThinkingLevel, UiMessage } from "@pi-desktop/shared";
import { THINKING_LEVELS } from "@pi-desktop/shared";
import type { SubagentRun } from "../../../lib/assistant-turns";
import { toolResultPayload } from "../../../lib/tool-presentation";

export function delegateAgentName(
  message: UiMessage,
  delegate?: SubagentRun,
): string {
  if (delegate?.agentName) return delegate.agentName;
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const requested = (args as { agent?: unknown }).agent;
    if (typeof requested === "string") return requested;
  }
  return "";
}

/** Effective model resolved for this delegation, recorded by the Task result. */
export function delegateModelId(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const modelId = (payload as { modelId?: unknown }).modelId;
  return typeof modelId === "string" ? modelId.trim() : "";
}

/** Effective thinking level resolved for this delegation, from the Task result.
 * `off` and `omit` deliberately have no visible suffix. */
/**
 * The model a delegation runs on, for the inline card.
 *
 * `delegateModelId` answers only once the call has returned, because the
 * resolution is reported in the result payload — too late for a card that is
 * worth reading while the delegate works. So the delegate's own turns are
 * consulted first: every assistant turn it produced names the model that
 * produced it, which is the same model the result goes on to report. The
 * parent's explicit override covers the first seconds of a run that has not
 * spoken yet.
 */
export function delegationModelId(message: UiMessage, run?: SubagentRun): string {
  const settled = delegateModelId(message);
  if (settled) return settled;
  const fromTurn = run?.items.find((item) => item.message.modelId)?.message.modelId;
  if (fromTurn) return fromTurn.trim();
  const args = message.toolArgs;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const pinned = (args as { model?: unknown }).model;
    if (typeof pinned === "string" && pinned.trim()) return pinned.trim();
  }
  return "";
}

export function delegateThinkingLevel(message: UiMessage): ThinkingLevel | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { thinkingLevel?: unknown }).thinkingLevel;
  if (
    typeof value !== "string" ||
    value === "off" ||
    !THINKING_LEVELS.includes(value as ThinkingLevel)
  ) {
    return undefined;
  }
  return value as ThinkingLevel;
}

/**
 * Copies a run row's command from its head. The expanded body holds only the
 * output, so this is the one place the command can be taken from (D226).
 */
