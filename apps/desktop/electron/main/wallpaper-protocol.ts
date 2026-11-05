import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { protocol } from "electron";
import { queuePrivilegedScheme } from "./protocol-schemes";

/**
 * The host-owned scheme that serves a wallpaper *project directory* to the
 * renderer. Unlike `skin-asset://`, a wallpaper is not one file: a Wallpaper
 * Engine project is a folder of HTML/JS/textures or a `scene.pkg` plus its
 * `project.json`. The renderer therefore addresses a whole tree, and the tree
 * it may address is chosen by the host: `wallpaper://project/<rootId>/<path>`
 * where `<rootId>` was registered by main-process code the renderer cannot
 * reach. A path that escapes its root, or names an unregistered root, 404s.
 */
export const WALLPAPER_SCHEME = "wallpaper";

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  pkg: "application/octet-stream",
  bin: "application/octet-stream",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  glsl: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/**
 * A wallpaper document runs untrusted-ish code (a workshop scene's own HTML).
 * It is served from its own origin, so it cannot touch the app realm; this
 * policy keeps it inside that origin as well — no calling home to a remote
 * server, no framing the app.
 */
const DOCUMENT_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-ancestors 'none'",
].join("; ");

export type WallpaperRoots = Map<string, string>;

/**
 * The process-wide root table. Main-process code registers a directory under a
 * stable id (`demo`, `workshop-<id>`, `import-<uuid>`); the renderer only ever
 * references the id. Mutating this after install is intentional — an imported
 * project becomes servable without re-registering the protocol.
 */
export const wallpaperRoots: WallpaperRoots = new Map();

/**
 * Locate the demo project in both layouts: a packaged build ships it as an
 * extra resource beside the app, while a dev checkout keeps it under
 * `apps/desktop/resources`. Missing in both is not fatal — the root then 404s
 * and the layer logs a mount failure instead of taking the window down.
 */
export function resolveWallpaperPresetsRoot(appPath: string, resourcesPath: string): string {
  const besideApp = join(resourcesPath, "wallpapers");
  const inRepo = join(appPath, "resources", "wallpapers");
  return existsSync(besideApp) ? besideApp : inRepo;
}

export function resolveDemoWallpaperRoot(appPath: string, resourcesPath: string): string {
  const besideApp = join(resourcesPath, "wallpaper-demo");
  const inRepo = join(appPath, "resources", "wallpaper-demo");
  return existsSync(besideApp) ? besideApp : inRepo;
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/** True when `candidate` resolves inside `root` (prefix-safe on boundaries). */
function isInside(root: string, candidate: string): boolean {
  const base = resolve(root) + sep;
  return resolve(candidate).startsWith(base);
}

/** Reserve the scheme before app-ready; Electron refuses later registration. */
export function registerWallpaperScheme(): void {
  queuePrivilegedScheme({
      scheme: WALLPAPER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    });
}

/**
 * Install the handler. `roots` is read per request so a root registered after
 * startup (an imported project, a newly scanned workshop folder) is served
 * without reinstalling the protocol.
 */
export function installWallpaperProtocol(roots: WallpaperRoots): void {
  protocol.handle(WALLPAPER_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== "project") return notFound();

    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [rootId, ...rest] = segments;
    if (!rootId || rest.length === 0) return notFound();
    if (rest.some((part) => part === ".." || part === "." || part.includes("\0"))) {
      return notFound();
    }

    const root = roots.get(rootId);
    if (!root) return notFound();

    const filePath = join(root, ...rest);
    if (!isInside(root, filePath)) return notFound();

    let size: number;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return notFound();
      size = stat.size;
    } catch {
      return notFound();
    }

    const ext = extname(filePath).slice(1).toLowerCase();
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": mime,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
    };
    // A wallpaper document is its own origin; keep it there.
    if (mime.startsWith("text/html")) headers["content-security-policy"] = DOCUMENT_CSP;

    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (Number.isFinite(start) && start <= end && start < size) {
          const length = end - start + 1;
          const buffer = Buffer.alloc(length);
          const fd = openSync(filePath, "r");
          try {
            readSync(fd, buffer, 0, length, start);
          } finally {
            closeSync(fd);
          }
          return new Response(new Uint8Array(buffer), {
            status: 206,
            headers: {
              ...headers,
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-length": String(length),
            },
          });
        }
      }
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }

    const buffer = Buffer.alloc(size);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buffer, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: { ...headers, "content-length": String(size) },
    });
  });
}
