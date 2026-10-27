/**
 * The phone client the Host serves at `/app` (ADR 0333 P2).
 *
 * The page is a built app in `apps/mobile`, not a string in this file. That
 * matters more than it sounds: a page authored inside a TypeScript template
 * literal cannot be type-checked, cannot import anything, and fails to parse
 * silently when a backtick slips into a comment. The same bundle is what the
 * Android app ships, so the phone and the browser cannot drift.
 *
 * Nothing here is derived from a session, and the page is served without a
 * credential because collecting one is what it does.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export type StaticAsset = { body: string | Buffer; contentType: string };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Where the built client lives.
 *
 * Packaged builds carry it in `resources/mobile-shell` (electron-builder
 * `extraResources`); a development checkout reads it straight out of the
 * workspace, so building the mobile package is the only step needed to see a
 * change.
 */
function clientRoot(): string | null {
  const candidates: string[] = [];
  // A pointer for tests and for pointing a checkout at a bundle built elsewhere.
  const override = process.env.PI_DESKTOP_MOBILE_SHELL;
  if (override) candidates.push(override);
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(join(resources, "mobile-shell"));
  // `__dirname` under the packaged CJS main process; `import.meta.dirname` when
  // this module is loaded as ESM by the test runner.
  const here = typeof __dirname === "string" ? __dirname : import.meta.dirname;
  candidates.push(join(here, "..", "..", "..", "mobile", "dist"));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

let cachedRoot: { root: string | null } | null = null;

function root(): string | null {
  if (!cachedRoot) cachedRoot = { root: clientRoot() };
  return cachedRoot.root;
}

/** `/app`, `/app/`, `/` and `/index.html` are the same document. */
function relativePath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/app" || pathname === "/app/") {
    return "index.html";
  }
  if (pathname.startsWith("/app/")) return pathname.slice("/app/".length);
  if (pathname.startsWith("/assets/")) return pathname.slice(1);
  return null;
}

/**
 * Only the client is public; everything else falls through to the protocol.
 *
 * Hashed assets are immutable, so a phone that already has them does not ask
 * again; the document itself is never cached, because it names the current
 * hashes.
 */
export function serveClientShell(pathname: string): StaticAsset | null {
  const base = root();
  if (!base) return null;
  const relative = relativePath(pathname);
  if (!relative) return null;

  const target = resolve(base, relative);
  if (!target.startsWith(resolve(base) + sep)) return null;
  if (!existsSync(target)) return null;
  if (!statSync(target).isFile()) return null;

  const extension = extname(target).toLowerCase();
  return {
    body: readFileSync(target),
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
  };
}
