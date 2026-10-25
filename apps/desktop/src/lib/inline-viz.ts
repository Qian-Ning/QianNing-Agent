import type { InlineVisualizationKind } from "@pi-desktop/shared";
import { isInlineVisualizationKind } from "@pi-desktop/shared";

/**
 * Pure helpers for the inline-visualization transcript card (ADR 0327).
 * Kept free of React/i18n so the sandbox contract and payload parsing are
 * directly unit-testable under `node --test`.
 */

export type InlineVisualizationCardMeta = {
  id: string;
  sessionId: string;
  title: string;
  kind: InlineVisualizationKind;
  createdAt: string;
};

/**
 * The `WriteInlineVisualization` tool result payload down to
 * `{ visualization: meta }`, or null when the shape is anything else. The
 * payload arrives through the message's `details`; only well-formed
 * references produce a card, so a malformed or spoofed result fails closed.
 */
export function inlineVizMetaOf(payload: unknown): InlineVisualizationCardMeta | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as { visualization?: unknown }).visualization;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.title !== "string" ||
    !record.title ||
    !isInlineVisualizationKind(record.kind) ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    title: record.title,
    kind: record.kind,
    createdAt: record.createdAt,
  };
}

/**
 * The document handed to the sandboxed iframe. HTML is used as-is; SVG is
 * wrapped in a minimal document so it parses as inline SVG; JSON/CSV/text are
 * escaped into a `<pre>` so the content is shown verbatim and never parsed as
 * markup. Every path is inert: the iframe has no scripts and no same-origin
 * access regardless of what this document contains.
 */
export function srcDocFor(kind: InlineVisualizationKind, content: string): string {
  if (kind === "html") return content;
  if (kind === "svg") {
    return `<!doctype html><meta charset="utf-8"><body style="margin:0">${content}</body>`;
  }
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><pre>${escaped}</pre></body>`;
}