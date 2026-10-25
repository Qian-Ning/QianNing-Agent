/**
 * Electron-side helpers for the session-visualization scheme (ADR 0328).
 *
 * The URL rules themselves live in `@pi-desktop/shared` because the renderer
 * builds the same URLs this handler parses; only the response shaping (MIME
 * type and CSP) is main-process knowledge, so it stays here behind the pure,
 * `node --test`-able boundary.
 */

export {
  INLINE_VIZ_SCHEME,
  inlineVizUrlFor,
  isSafeInlineVizSegment,
  parseInlineVizUrl,
  type InlineVizUrlParts,
} from "@pi-desktop/shared";

/**
 * The response headers for one artifact. The CSP mirrors the srcDoc wrapper
 * for the same mode: a static preview permits no script at all, a scripted
 * preview permits inline script only. Either way nothing networks out, so the
 * scheme can never be used as an exfiltration channel.
 */
export function inlineVizResponseHeaders(
  mime: string,
  options: { scripted: boolean },
): Record<string, string> {
  return {
    "content-type": mime,
    "content-security-policy": options.scripted
      ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;"
      : "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
    "x-content-type-options": "nosniff",
  };
}

/** The MIME type for a stored kind, or null when the kind is unknown. */
export function inlineVizMimeType(kind: string): string | null {
  switch (kind) {
    case "html":
      return "text/html; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv; charset=utf-8";
    case "text":
      return "text/plain; charset=utf-8";
    default:
      return null;
  }
}
