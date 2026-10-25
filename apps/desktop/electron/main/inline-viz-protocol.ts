/**
 * Electron wiring for the session-visualization scheme (ADR 0328).
 *
 * The scheme is reserved through `registerSchemesAsPrivileged` before the app
 * is ready and its handler is installed with `protocol.handle` once the app is
 * ready, exactly like the media-asset, plugin-asset, and skin-asset schemes;
 * it is torn down with `protocol.unhandle` on quit. A request is answered only
 * when it names an artifact that exists inside host-core's visualization root
 * for the named session — the same directory rules `inline_viz.rs` enforces on
 * the write side — and every response carries the network-closed CSP the
 * scripted srcDoc path uses, so a preview can never fetch out even though its
 * scripts (when the user allowed them) may run.
 *
 * The handler reads the artifact JSON directly from the data directory rather
 * than round-tripping through a host RPC: host-core is the single writer and
 * the renderer-facing write paths are audited there, so a read-only mirror of
 * its on-disk shape loses nothing and keeps large documents off the IPC line.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { protocol } from "electron";
import {
  INLINE_VIZ_SCHEME,
  inlineVizMimeType,
  inlineVizResponseHeaders,
  parseInlineVizUrl,
} from "./inline-viz-scheme";

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/**
 * Reserve the scheme before the app is ready. `secure` keeps a reference from
 * reading as mixed content; the fetch/CORS pair lets the iframe load it.
 */
export function registerInlineVizScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INLINE_VIZ_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Install the request handler. Call once, after the app is ready, with the
 * same data directory host-core was given: the handler serves exactly the
 * `inline-viz` subtree under it, nothing else.
 */
export function installInlineVizProtocol(dataDir: string): void {
  const root = join(dataDir, "inline-viz");
  protocol.handle(INLINE_VIZ_SCHEME, async (request) => {
    const parts = parseInlineVizUrl(request.url);
    if (!parts) return notFound();
    const mime = await inlineVizMimeTypeFor(parts.sessionId, parts.visualizationId, root);
    if (!mime) return notFound();

    // The artifact file is `<id>.json` holding `{ meta, content }`; only its
    // `content` field is served, and only when the file sits inside the root
    // after realpath resolution — a planted symlink must not escape.
    const file = join(root, parts.sessionId, `${parts.visualizationId}.json`);
    let realFile: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) return notFound();
      realFile = await realpath(file);
    } catch {
      return notFound();
    }
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot || !realFile.startsWith(realRoot)) return notFound();

    let raw: string;
    try {
      raw = await readFile(realFile, "utf8");
    } catch {
      return notFound();
    }
    let content: unknown;
    try {
      content = JSON.parse(raw)?.content;
    } catch {
      return notFound();
    }
    if (typeof content !== "string") return notFound();
    return new Response(new Uint8Array(Buffer.from(content, "utf8")), {
      status: 200,
      headers: inlineVizResponseHeaders(mime, { scripted: parts.scripted }),
    });
  });
}

/**
 * The MIME type for one artifact, resolved from the stored meta's kind — an
 * unknown kind (or a meta that will not parse) is a miss, same as a missing
 * file.
 */
async function inlineVizMimeTypeFor(
  sessionId: string,
  visualizationId: string,
  root: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, sessionId, `${visualizationId}.json`), "utf8");
  } catch {
    return null;
  }
  try {
    const kind = JSON.parse(raw)?.meta?.kind;
    return typeof kind === "string" ? inlineVizMimeType(kind) : null;
  } catch {
    return null;
  }
}

/**
 * Remove the request handler. Paired with {@link installInlineVizProtocol}:
 * the scheme itself was reserved before ready and cannot be un-reserved, so
 * teardown is the handler, on quit, next to the other resource disposals.
 */
export function uninstallInlineVizProtocol(): void {
  try {
    protocol.unhandle(INLINE_VIZ_SCHEME);
  } catch {
    // No handler installed (or already removed): nothing to release.
  }
}
