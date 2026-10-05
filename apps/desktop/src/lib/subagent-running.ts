import type { UiMessage } from "@pi-desktop/shared";
import { isDelegationStartTool } from "./tool-display";

/** One delegate still in flight, identified by the `Task` call that started it. */
export type RunningDelegation = {
  /** The running `Task` call; also the row a strip click should reveal. */
  toolCallId: string;
  startedAt: string;
  agentName?: string;
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
export function runningDelegations(
  messages: readonly UiMessage[],
): RunningDelegation[] {
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
    });
  }
  return running.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
