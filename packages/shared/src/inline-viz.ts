/**
 * Inline visualizations (ADR 0327).
 *
 * An agent turn can write a static artifact — HTML, SVG, JSON, CSV or plain
 * text — into the session it is running in. Host-core owns the storage (a
 * directory under the session data area) and the renderer shows the artifact
 * inside a strict no-script sandbox iframe. The write path is agent-only:
 * this file defines the read surface the renderer gets, never a write
 * channel.
 */

/** Content kinds the `WriteInlineVisualization` tool accepts. */
export const INLINE_VIZ_KINDS = ["html", "svg", "json", "csv", "text"] as const;

export type InlineVisualizationKind = (typeof INLINE_VIZ_KINDS)[number];

/**
 * Byte ceiling on one artifact's content, enforced by host-core
 * (`crates/host-core/src/inline_viz.rs`) and mirrored in the agent-runtime
 * tool schema so the model is told the limit up front.
 */
export const MAX_INLINE_VIZ_CONTENT_BYTES = 512 * 1024;

/** Upper bound on a visualization title, mirrored in host-core. */
export const MAX_INLINE_VIZ_TITLE_CHARS = 120;

export function isInlineVisualizationKind(
  value: unknown,
): value is InlineVisualizationKind {
  return (
    typeof value === "string" &&
    (INLINE_VIZ_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A stored visualization without its content. The `WriteInlineVisualization`
 * tool result carries one of these as `{ visualization: meta }`, so the
 * transcript can render the card without an IPC round trip; only the content
 * is fetched on demand.
 */
export interface InlineVisualizationMeta {
  id: string;
  /** The session the artifact belongs to; scopes every read. */
  sessionId: string;
  title: string;
  kind: InlineVisualizationKind;
  createdAt: string;
}

/** A stored visualization with its content, returned by the read channel. */
export interface InlineVisualizationArtifact extends InlineVisualizationMeta {
  content: string;
}

/** The tool-result payload host-core returns on a successful write. */
export interface InlineVisualizationWriteResult {
  visualization: InlineVisualizationMeta;
}

/**
 * The privileged scheme that streams one artifact into the preview iframe
 * (ADR 0328). Declared here because both the Electron handler and the
 * renderer's URL builder must agree on the wire format; a second copy of these
 * rules would be a second source of truth for a security boundary.
 */
export const INLINE_VIZ_SCHEME = "qn-visuals";

/** An id that is safe as one path segment: no separators, no traversal. */
export function isSafeInlineVizSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

export type InlineVizUrlParts = {
  sessionId: string;
  visualizationId: string;
  /** Whether the request asked for the scripted CSP tier (`?scripted=1`). */
  scripted: boolean;
};

/**
 * Parse a `qn-visuals://` URL down to its two ids, or null for anything the
 * scheme must not serve: foreign URLs, authority-bearing forms, encoded
 * separators, or traversal-shaped segments.
 */
export function parseInlineVizUrl(rawUrl: string): InlineVizUrlParts | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${INLINE_VIZ_SCHEME}:`) return null;
  if (url.hostname && url.hostname !== "localhost") return null;
  // `/session-id/viz-id` — exactly two segments, both safe as file names.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const [sessionId, visualizationId] = segments;
  if (!isSafeInlineVizSegment(sessionId) || !isSafeInlineVizSegment(visualizationId)) {
    return null;
  }
  // Only the literal "1" opts into scripts; anything else is the static tier.
  return {
    sessionId,
    visualizationId,
    scripted: url.searchParams.get("scripted") === "1",
  };
}

/**
 * The URL an iframe `src` uses for one artifact, or null when either id is not
 * a safe path segment (in which case the caller falls back to `srcDoc`).
 */
export function inlineVizUrlFor(
  sessionId: string,
  visualizationId: string,
  options: { scripted: boolean } = { scripted: false },
): string | null {
  if (!isSafeInlineVizSegment(sessionId) || !isSafeInlineVizSegment(visualizationId)) {
    return null;
  }
  const query = options.scripted ? "?scripted=1" : "";
  return `${INLINE_VIZ_SCHEME}://localhost/${encodeURIComponent(sessionId)}/${encodeURIComponent(visualizationId)}${query}`;
}
