import { TOOL_ACTIVATION_SECTION } from "./fixed-tool-declarations.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  type SystemMessage,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";

import { SKILL_GROUP_SECTION_PREFIX, SKILL_PRELOAD_SECTION, SKILL_SECTION_PREFIX } from "./plugin-skills-prompt.js";

function systemMessages(messages: readonly AgentMessage[]): SystemMessage[] {
  return messages.filter((message): message is SystemMessage => message.role === "system");
}

function nextSystemTimestamp(messages: readonly AgentMessage[]): number {
  // Never backdate a state change relative to the response it invalidates.
  return messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp + 1), Date.now());
}

function currentSystemMessage(messages: readonly AgentMessage[]): SystemMessage | undefined {
  const systems = systemMessages(messages);
  if (systems.length < 2) return systems[0];
  const current = getCurrentSystemMessage(systems)!;
  // The upstream fold retains the first timestamp. A checkpoint must cover
  // every contributing update so old usage is not accidentally reactivated.
  return {
    ...current,
    timestamp: systems.reduce((timestamp, message) => Math.max(timestamp, message.timestamp), systems[0]!.timestamp),
  };
}

/** Transient budget section, dropped when a checkpoint folds the transcript. */
export const CONTEXT_BUDGET_SECTION = "context_budget";

function isSkillSection(name: string): boolean {
  return name.startsWith(SKILL_SECTION_PREFIX) || name.startsWith(SKILL_GROUP_SECTION_PREFIX);
}

/**
 * Desktop-owned sections retain their order ahead of extension sections.
 *
 * A grouped catalog is listed in insertion order: the renderer puts each group
 * heading directly before its entries, and sorting the keys would separate a
 * heading from the skills it introduces. Without headings there is no grouping
 * to protect, so entries keep the historical id order — callers may hand the
 * sections over in any order and still get the same prompt.
 */
function desktopSectionNames(sections: Record<string, unknown>): string[] {
  const skillNames = Object.keys(sections).filter(isSkillSection);
  const ordered = skillNames.some((name) => name.startsWith(SKILL_GROUP_SECTION_PREFIX))
    ? skillNames
    : [...skillNames].sort((a, b) => a.localeCompare(b));
  return ["runtime", TOOL_ACTIVATION_SECTION, "skills", ...ordered, SKILL_PRELOAD_SECTION, "context"];
}

export function systemPromptContent(messages: readonly AgentMessage[]): string {
  const current = getCurrentSystemMessage(messages);
  const sections = current?.sections;
  if (sections && desktopSectionNames(sections).some((name) => name in sections)) {
    return desktopSectionNames(sections).map((name) => sections[name]).filter(Boolean).join("\n\n");
  }
  return contentText(current?.content ?? "");
}

export function syncSystemSections(
  messages: AgentMessage[],
  desired: Record<string, string>,
): AgentMessage[] {
  const current = getCurrentSystemMessage(messages)?.sections ?? {};
  // Order follows the state being applied: the catalog renderer emits entries
  // in the order the model should read them, so its key order is the contract.
  // Keys that exist only in the current state are being revoked; they keep no
  // render position, so they are recorded just ahead of `context`.
  const names = desktopSectionNames(desired);
  for (const name of Object.keys(current)) {
    if (isSkillSection(name) && !(name in desired)) names.splice(names.length - 1, 0, name);
  }
  const sections: Record<string, string | null> = {};
  for (const name of names) {
    const next = desired[name] ?? null;
    if ((current[name] ?? null) !== next) sections[name] = next;
  }
  if (Object.keys(sections).length === 0) return messages;
  return [...messages, { role: "system", content: "", sections, timestamp: nextSystemTimestamp(messages) }];
}

export function initialSystemTranscript(
  prompt: string,
  tools: readonly Tool[],
  messages: AgentMessage[],
  sections: Record<string, string> = { runtime: prompt },
): AgentMessage[] {
  if (messages.some((message) => message.role === "system")) {
    return syncSystemSections(messages, sections);
  }
  if (!prompt && tools.length === 0) return messages;
  // Old sessions have no recorded baseline. Declare the current state at the
  // continuation boundary rather than inventing past instructions or tools.
  return [...messages, {
    role: "system", content: "", sections,
    toolsAdded: tools.map(toToolDeclaration), timestamp: nextSystemTimestamp(messages),
  }];
}

export function replaceSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  if (prompt === getCurrentSystemPrompt(messages) || prompt === systemPromptContent(messages)) return messages;
  const activation = getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION];
  return syncSystemSections(messages, { runtime: prompt, ...(activation ? { [TOOL_ACTIVATION_SECTION]: activation } : {}) });
}

export function rebuildSystemTranscript(
  previous: readonly AgentMessage[],
  messages: AgentMessage[],
): AgentMessage[] {
  let result = messages;
  for (let i = 0; i < previous.length; i++) {
    const message = previous[i];
    if (message.role !== "system" || result.includes(message)) continue;
    const following = previous.slice(i + 1).find((item) => result.includes(item));
    const preceding = previous.slice(0, i).reverse().find((item) => result.includes(item));
    let position = following ? result.indexOf(following) : preceding ? result.indexOf(preceding) + 1 : result.length;
    if (!following) while (result[position]?.role === "system") position++;
    if (result === messages) result = [...messages];
    result.splice(position, 0, message);
  }
  return result;
}

/** Fold state only at an explicit compaction boundary, with semantic time. */
export function systemTranscriptCheckpoint(messages: readonly AgentMessage[]): SystemMessage | undefined {
  const current = currentSystemMessage(messages);
  if (!current) return undefined;
  // Use the journal's durable shape, including extension-provided text blocks.
  const checkpoint: SystemMessage = { ...current, content: contentText(current.content),
    ...(current.toolsAdded ? { toolsAdded: current.toolsAdded.map(toToolDeclaration) } : {}) };
  if (!checkpoint.sections || !(CONTEXT_BUDGET_SECTION in checkpoint.sections)) return checkpoint;
  const { [CONTEXT_BUDGET_SECTION]: _expired, ...sections } = checkpoint.sections;
  return { ...checkpoint, sections };
}

/** Recovery discards failed trailing responses even after a prompt cleanup delta. */
export function removeTrailingAssistantMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index--) {
    if (result[index].role === "system") continue;
    if (result[index].role !== "assistant") break;
    result.splice(index, 1);
  }
  return result;
}
