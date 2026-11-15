/**
 * How a conversation's own prompt meets the built-in one.
 *
 * `replace` is the behaviour that shipped first: the custom prompt speaks
 * instead of the product persona. `append` keeps both, for the case where the
 * user wants to add instructions without restating what the product already
 * says about itself.
 *
 * Only the first part — the persona — is affected. The operational rules after
 * it are the product's behaviour contract and are appended in both modes, so a
 * prompt cannot switch off tool guidance, safety rules, or scratch handling.
 */
export type SystemPromptMode = "replace" | "append";

export const SYSTEM_PROMPT_MODES: readonly SystemPromptMode[] = ["replace", "append"];

/** Anything unrecognised falls back to the long-standing behaviour. */
export function resolveSystemPromptMode(value: unknown): SystemPromptMode {
  return value === "append" ? "append" : "replace";
}

/**
 * Build the parts that open the system prompt.
 *
 * `defaultParts[0]` is the built-in persona; the caller appends `defaultParts`
 * from index 1 regardless, so this only decides whether the built-in persona is
 * present alongside the custom one.
 */
export function composePersonaParts({
  persona,
  mode,
  defaultParts,
}: {
  persona: string | undefined;
  mode: SystemPromptMode;
  defaultParts: readonly string[];
}): string[] {
  const custom = persona?.trim();
  const builtIn = (defaultParts[0] ?? "").trim();
  if (!custom) return [builtIn];
  if (mode === "append") return [builtIn, custom];
  return [custom];
}
