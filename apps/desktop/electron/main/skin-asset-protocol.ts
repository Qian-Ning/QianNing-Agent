import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { protocol } from "electron";

/**
 * The host-owned scheme that serves a skin's background image or video to the
 * renderer. A skin never hands the renderer a filesystem path: it stores the
 * media under the installation data directory and references it by opaque
 * asset id, and this handler streams the bytes back over
 * `skin-asset://asset/<id>.<ext>`. That keeps skin backgrounds on the same
 * confinement rule as plugin theme assets (ADR 0248) — the renderer can only
 * name an id, never walk the disk.
 */
export const SKIN_ASSET_SCHEME = "skin-asset";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};

const MIME_TYPES: Record<string, string> = { ...IMAGE_MIME, ...VIDEO_MIME };

/**
 * The maximum bytes a single background asset may occupy. A skin background is
 * a decoration, not a media library: 48 MB is generous for a looping clip while
 * keeping the on-disk skins directory and an exported `.qnskin` bundle bounded.
 */
export const SKIN_ASSET_MAX_BYTES = 48 * 1024 * 1024;

/** The directory a skin's background media lives under, inside the data dir. */
export function skinAssetsDir(dataDir: string): string {
  return join(dataDir, "skins", "assets");
}

/**
 * True when `candidate` resolves to a path inside `root`. Compared on resolved
 * absolute paths with a trailing separator so a sibling directory that merely
 * shares a name prefix cannot pass.
 */
function isInside(root: string, candidate: string): boolean {
  const base = resolve(root) + sep;
  const target = resolve(candidate);
  return target.startsWith(base);
}

const ASSET_ID = /^[a-f0-9]{8,64}$/;
const ASSET_EXT = /^[a-z0-9]{2,5}$/;

function mimeTypeFor(ext: string): string | null {
  return MIME_TYPES[ext] ?? null;
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/**
 * Reserve the scheme before the app is ready — Electron refuses to register
 * privileges afterwards. `stream` is what a `<video>` element needs for range
 * playback; the rest mirror the plugin asset scheme so a stylesheet `url()` and
 * a media element can both load the bytes.
 */
export function registerSkinAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SKIN_ASSET_SCHEME,
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
 * Install the request handler. Call once, after the app is ready. Every request
 * is confined to {@link skinAssetsDir}: the id and extension are format-checked,
 * the resolved path is proven to sit inside the assets directory, and anything
 * else fails closed with a 404.
 */
export function installSkinAssetProtocol(dataDir: string): void {
  const root = skinAssetsDir(dataDir);
  protocol.handle(SKIN_ASSET_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return notFound();
    const id = name.slice(0, dot).toLowerCase();
    const ext = name.slice(dot + 1).toLowerCase();
    if (!ASSET_ID.test(id) || !ASSET_EXT.test(ext)) return notFound();
    const mime = mimeTypeFor(ext);
    if (!mime) return notFound();
    const filePath = join(root, `${id}.${ext}`);
    if (!isInside(root, filePath)) return notFound();
    let body: Uint8Array | null;
    try {
      body = new Uint8Array(readFileSync(filePath));
    } catch {
      return notFound();
    }
    const bytes = new Uint8Array(body);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
      },
    });
  });
}

export type StoredSkinAsset = { assetId: string; ext: string; bytes: number };

/**
 * Copy raw media bytes into the skins assets directory under a fresh id,
 * returning the id and extension the renderer will reference. The id is derived
 * from a random UUID hashed to hex so it always matches {@link ASSET_ID} and
 * never collides with an existing file. Throws when the payload is empty or
 * over {@link SKIN_ASSET_MAX_BYTES}, so an oversized import fails loudly rather
 * than silently filling the profile.
 */
export function storeSkinAsset(dataDir: string, ext: string, bytes: Uint8Array): StoredSkinAsset {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!ASSET_EXT.test(cleanExt) || !mimeTypeFor(cleanExt)) {
    throw new Error("unsupported skin asset type");
  }
  if (bytes.byteLength === 0) throw new Error("empty skin asset");
  if (bytes.byteLength > SKIN_ASSET_MAX_BYTES) throw new Error("skin asset too large");
  const dir = skinAssetsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const assetId = createHash("sha1").update(randomUUID()).digest("hex");
  const filePath = join(dir, `${assetId}.${cleanExt}`);
  writeFileSync(filePath, bytes);
  return { assetId, ext: cleanExt, bytes: bytes.byteLength };
}

/** Read a stored asset's bytes for export, or null when it is missing. */
export function readSkinAsset(dataDir: string, assetId: string, ext: string): Uint8Array | null {
  const cleanId = assetId.toLowerCase();
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!ASSET_ID.test(cleanId) || !ASSET_EXT.test(cleanExt)) return null;
  const dir = skinAssetsDir(dataDir);
  const filePath = join(dir, `${cleanId}.${cleanExt}`);
  if (!isInside(dir, filePath)) return null;
  try {
    if (statSync(filePath).size > SKIN_ASSET_MAX_BYTES) return null;
    return new Uint8Array(readFileSync(filePath));
  } catch {
    return null;
  }
}

/** Delete a stored asset, ignoring a missing file. Confined to the assets dir. */
export function deleteSkinAsset(dataDir: string, assetId: string, ext: string): void {
  const cleanId = assetId.toLowerCase();
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!ASSET_ID.test(cleanId) || !ASSET_EXT.test(cleanExt)) return;
  const dir = skinAssetsDir(dataDir);
  const filePath = join(dir, `${cleanId}.${cleanExt}`);
  if (!isInside(dir, filePath)) return;
  try {
    rmSync(filePath, { force: true });
  } catch {
    // A missing asset is already the desired end state.
  }
}
