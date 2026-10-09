/**
 * Electron wiring for the media-library asset scheme (ADR 0322).
 *
 * The scheme is reserved through `registerSchemesAsPrivileged` before the app is
 * ready — Electron refuses privileges afterwards — and its request handler is
 * installed with `protocol.handle` once the app is ready, exactly like the
 * plugin-asset and skin-asset schemes. It is torn down with `protocol.unhandle`
 * on quit. Requests are confined to the library root by
 * {@link resolveLibraryAsset}; a Range request is answered with 206 + the window
 * so a `<video>` element can drag-seek.
 */
import { open, readFile, realpath, stat } from "node:fs/promises";
import { protocol } from "electron";
import {
  MEDIA_ASSET_HOST,
  MEDIA_ASSET_SCHEME,
  fullResponseHeaders,
  isInside,
  mediaAssetMimeType,
  parseByteRange,
  rangeResponseHeaders,
  resolveLibraryAsset,
} from "./media-asset";
import { mediaLibraryDir } from "./services/media-library";

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/**
 * Reserve the scheme before the app is ready. `stream` is what a `<video>`
 * element needs for range playback; `secure` keeps the reference from reading as
 * mixed content, and the fetch/CORS pair lets a media element load the bytes.
 */
export function registerMediaAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Install the request handler. Call once, after the app is ready. The library
 * root is resolved once; every request is confined to it and answered with the
 * full file (200) or the requested byte window (206).
 */
export function installMediaAssetProtocol(dataDir: string): void {
  const root = mediaLibraryDir(dataDir);
  protocol.handle(MEDIA_ASSET_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.hostname !== MEDIA_ASSET_HOST) return notFound();
    const filePath = resolveLibraryAsset(root, url.pathname);
    if (!filePath) return notFound();
    const mime = mediaAssetMimeType(filePath);
    if (!mime) return notFound();

    let size: number;
    let realFile: string;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return notFound();
      size = info.size;
      realFile = await realpath(filePath);
    } catch {
      return notFound();
    }
    // A symlink planted inside the library must not escape it.
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot || !isInside(realRoot, realFile)) return notFound();

    const parsed = parseByteRange(request.headers.get("range"), size);
    if (parsed.kind === "invalid") {
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${size}`,
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (parsed.kind === "none") {
      let body: Buffer;
      try {
        body = await readFile(realFile);
      } catch {
        return notFound();
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: fullResponseHeaders(size, mime),
      });
    }

    const length = parsed.end - parsed.start + 1;
    const buffer = Buffer.alloc(length);
    let handle;
    try {
      handle = await open(realFile, "r");
    } catch {
      return notFound();
    }
    try {
      await handle.read(buffer, 0, length, parsed.start);
    } catch {
      return notFound();
    } finally {
      await handle.close().catch(() => undefined);
    }
    return new Response(new Uint8Array(buffer), {
      status: 206,
      headers: rangeResponseHeaders(parsed.start, parsed.end, size, mime),
    });
  });
}

/**
 * Remove the request handler. Paired with {@link installMediaAssetProtocol}: the
 * scheme itself was reserved before ready and cannot be un-reserved, so teardown
 * is the handler, on quit, next to the other resource disposals.
 */
export function uninstallMediaAssetProtocol(): void {
  try {
    protocol.unhandle(MEDIA_ASSET_SCHEME);
  } catch {
    // No handler installed (or already removed): nothing to release.
  }
}
