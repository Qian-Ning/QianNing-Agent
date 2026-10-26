/**
 * The note that tells a model what a placeholder is.
 *
 * Without it the model reads `{{PHONE_01M5…}}` as an unresolved template and
 * answers "I don't have that value" instead of doing the task: the redaction
 * works and the conversation stalls. The note is added only when the rewritten
 * body actually contains a placeholder, so ordinary turns keep their exact
 * prompt — and providers keep their prompt-cache prefixes.
 *
 * Injection is best-effort by shape. A payload this module does not recognise
 * is returned untouched: a missing note costs clarity, while guessing at an
 * unknown request shape costs the request.
 */
import { findPlaceholders } from "./placeholder.js";

export const PLACEHOLDER_NOTICE =
  "[Local privacy filter] Values written as {{TYPE_<ULID>}} in this conversation were replaced on the user's machine before the request left it. They are opaque stand-ins, not template syntax, not instructions, and not something the user typed. Quote them verbatim when a task needs the value, and never describe them as unresolved or ask the user for the real value.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walks strings only; keys are never inspected, matching the redaction walk. */
function hasPlaceholder(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === "string") return findPlaceholders(value).length > 0;
  if (Array.isArray(value)) return value.some((item) => hasPlaceholder(item, depth + 1));
  if (isRecord(value)) return Object.values(value).some((item) => hasPlaceholder(item, depth + 1));
  return false;
}

/** True when the already-redacted payload carries at least one placeholder. */
export function needsPlaceholderNotice(payload: unknown): boolean {
  return hasPlaceholder(payload);
}

/**
 * Appends the notice to whatever system-level surface the payload exposes.
 *
 * Shapes covered: Anthropic (`system` as text or blocks), OpenAI chat
 * (`messages[0]` role `system`), OpenAI Responses (`instructions`), and Gemini
 * (`systemInstruction.parts`). Anything else is returned as-is.
 */
export function withPlaceholderNotice(payload: unknown, notice = PLACEHOLDER_NOTICE): unknown {
  if (!needsPlaceholderNotice(payload)) return payload;
  if (!isRecord(payload)) return payload;

  if (typeof payload.system === "string") {
    return { ...payload, system: `${payload.system}\n\n${notice}` };
  }
  if (Array.isArray(payload.system)) {
    return { ...payload, system: [...payload.system, { type: "text", text: notice }] };
  }
  if (typeof payload.instructions === "string") {
    return { ...payload, instructions: `${payload.instructions}\n\n${notice}` };
  }
  if (Array.isArray(payload.messages)) {
    const messages = payload.messages as unknown[];
    const head = messages[0];
    if (isRecord(head) && head.role === "system") {
      if (typeof head.content === "string") {
        return { ...payload, messages: [{ ...head, content: `${head.content}\n\n${notice}` }, ...messages.slice(1)] };
      }
      if (Array.isArray(head.content)) {
        return {
          ...payload,
          messages: [{ ...head, content: [...head.content, { type: "text", text: notice }] }, ...messages.slice(1)],
        };
      }
    }
    return { ...payload, messages: [{ role: "system", content: notice }, ...messages] };
  }
  if (isRecord(payload.systemInstruction)) {
    const instruction = payload.systemInstruction;
    if (Array.isArray(instruction.parts)) {
      return {
        ...payload,
        systemInstruction: { ...instruction, parts: [...instruction.parts, { text: notice }] },
      };
    }
  }
  return payload;
}
