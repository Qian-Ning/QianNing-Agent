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
