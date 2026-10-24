import { Type } from "@earendil-works/pi-ai";
import {
  INLINE_VIZ_KINDS,
  MAX_INLINE_VIZ_CONTENT_BYTES,
  MAX_INLINE_VIZ_TITLE_CHARS,
} from "@pi-desktop/shared";

/**
 * The `WriteInlineVisualization` tool (ADR 0327): attach a static artifact —
 * HTML, SVG, JSON, CSV or plain text — to the session, rendered opt-in in the
 * transcript inside a strict no-script sandbox iframe. Host-core owns the
 * storage and executes the write behind the normal permission + audit gate.
 */
export const WRITE_INLINE_VIZ_NAME = "WriteInlineVisualization";

export const writeInlineVisualizationDescription =
  "Create an inline visualization attached to the current conversation: static HTML, an SVG document, JSON, CSV, or plain text. The transcript may render it inside a strict sandbox (scripts and same-origin access are disabled) when the user has inline visualizations switched on in Settings; the content itself is stored with the session and never executed. Use it for self-contained charts, diagrams, dashboards, tables or formatted output the user should see rendered rather than as raw text. Keep the content self-contained: it cannot load local files or network resources in the sandboxed preview.";

export const writeInlineVisualizationParameters = {
  sessionId: Type.String({
    description: "The session id to attach the visualization to (must match the current session).",
  }),
  title: Type.String({
    minLength: 1,
    maxLength: MAX_INLINE_VIZ_TITLE_CHARS,
    description: "Short title shown on the transcript card.",
  }),
  kind: Type.Union(
    INLINE_VIZ_KINDS.map((kind) => Type.Literal(kind)),
  ),
  content: Type.String({
    maxLength: MAX_INLINE_VIZ_CONTENT_BYTES,
    description:
      "The artifact content. html/svg are rendered as documents; json/csv/text are shown verbatim. No scripts of any kind ever run.",
  }),
};
