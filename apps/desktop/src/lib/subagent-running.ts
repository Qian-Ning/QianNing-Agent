import type { UiMessage } from "@pi-desktop/shared";
import { isDelegationStartTool } from "./tool-display";

/** One delegate still in flight, identified by the `Task` call that started it. */
export type RunningDelegation = {
  /** The running `Task` call; also the row a strip click should reveal. */
  toolCallId: string;
  startedAt: string;
  agentName?: string;
  /** The last tool the delegate called, when it has called one. */
  lastTool?: string;
  /** The delegate's model, once one of its turns has named one. */
  model?: string;
};

/**
 * The delegates still running, oldest first.
 *
 * Derived from the transcript instead of a second live registry: a `Task` call is
 * running exactly while its row has no result yet, so the strip above the
 * composer and the row in the transcript cannot disagree about what is in flight.
 * Lifecycle calls (TaskWait/TaskList/TaskStop) are not delegations of their own
 * (D319), and a call with no id cannot be revealed, so both are skipped.
 */
/** The model the parent pinned for this run, when it pinned one. */
function pinnedModel(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const pinned = (args as { model?: unknown }).model;
  return typeof pinned === "string" && pinned.trim() ? pinned.trim() : undefined;
}
export function runningDelegations(
  messages: readonly UiMessage[],
): RunningDelegation[] {
  // The delegate's turns carry the model that produced them, which is the
  // same model the Task result reports once the call settles.
  const spoke = new Map<string, string>();
  const lastTool = new Map<string, string>();
  for (const message of messages) {
    const parent = message.parentToolCallId;
    if (!parent) continue;
    if (message.modelId && !spoke.has(parent)) spoke.set(parent, message.modelId);
    if (message.toolName) lastTool.set(parent, message.toolName);
  }
  const running: RunningDelegation[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (message.toolStatus !== "running") continue;
    if (!isDelegationStartTool(message.toolName)) continue;
    const toolCallId = message.toolCallId;
    if (!toolCallId) continue;
    running.push({
      toolCallId,
      startedAt: message.createdAt,
      agentName: message.agentName,
      model: spoke.get(toolCallId) ?? pinnedModel(message.toolArgs),
      lastTool: lastTool.get(toolCallId),
    });
  }
  return running.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
