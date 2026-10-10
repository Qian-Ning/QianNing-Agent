/**
 * The media-library asset scheme's pure core (ADR 0322).
 *
 * The containment rule and the Range parser are the security- and
 * playback-critical parts of serving the library to the renderer, so they are
 * pure functions and are exercised here directly. A separate block asserts the
 * Electron wiring and the renderer CSP still reference the scheme, so the
 * channel cannot be silently unplugged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_THUMBNAIL_BYTES,
  MEDIA_ASSET_SCHEME,
  contentRangeHeader,
  decodeThumbnailDataUrl,
  fullResponseHeaders,
  isInside,
  libraryRelativePath,
  mediaAssetMimeType,
  mediaAssetUrl,
  mediaAssetUrlForFile,
  parseByteRange,
  rangeResponseHeaders,
  resolveLibraryAsset,
} from "../electron/main/media-asset.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const root = resolve(desktopRoot, "test-fixture-library");

test("a request path maps into the library only when it stays inside it", () => {
  // A real render under a capability directory resolves.
  assert.equal(
    resolveLibraryAsset(root, "/video/generated-abc.mp4"),
    resolve(root, "video", "generated-abc.mp4"),
  );
  assert.equal(
    resolveLibraryAsset(root, "/image/generated-abc.png"),
    resolve(root, "image", "generated-abc.png"),
  );
  // Backslashes are normalized to the same path.
  assert.equal(
    resolveLibraryAsset(root, "/video\\generated-abc.mp4"),
    resolve(root, "video", "generated-abc.mp4"),
  );
});

test("traversal, absolute, and encoded paths are all refused", () => {
  // The three canonical vectors the invariant must reject.
  for (const traversal of [
    "..\\..\\evil.mp4",
    "../../evil.mp4",
    "/video/../../evil.mp4",
    "video/../../../../etc/passwd",
    "..%2f..%2fevil.mp4",
    "%2e%2e%2f%2e%2e%2fvideo%2fx.mp4",
    "video/..%2f..%2fx.mp4",
    "video/./x.mp4",
    "video/../x.mp4",
  ]) {
    assert.equal(resolveLibraryAsset(root, traversal), null, traversal);
  }
  // Absolute and drive-qualified paths never name a library-relative file.
  for (const absolute of ["/etc/passwd", "\\etc\\passwd", "C:\\Windows\\evil.mp4", "C:evil.mp4"]) {
    assert.equal(resolveLibraryAsset(root, absolute), null, absolute);
  }
});

test("only image/ and video/ renders are servable, and NUL is refused", () => {
  // The library index beside the renders is not an asset.
  assert.equal(resolveLibraryAsset(root, "/index.json"), null);
  assert.equal(resolveLibraryAsset(root, "/video"), null);
  assert.equal(resolveLibraryAsset(root, "/"), null);
  assert.equal(resolveLibraryAsset(root, ""), null);
  assert.equal(resolveLibraryAsset(root, "/video/x.mp4\0.png"), null);
  // A malformed percent-escape fails closed rather than throwing.
  assert.equal(resolveLibraryAsset(root, "/video/%zz.mp4"), null);
});

test("isInside is prefix-safe against sibling directories", () => {
  assert.equal(isInside(root, resolve(root, "video", "x.mp4")), true);
  assert.equal(isInside(root, resolve(root, "..", "sibling", "x.mp4")), false);
  assert.equal(isInside(join(root, "video"), root), false);
});

test("a URL is built only for a file inside the library", () => {
  assert.equal(
    mediaAssetUrlForFile(root, resolve(root, "video", "clip.mp4")),
    `${MEDIA_ASSET_SCHEME}://library/video/clip.mp4`,
  );
  // A failed or cancelled entry carries no path, so it gets no URL.
  assert.equal(mediaAssetUrlForFile(root, undefined), undefined);
  assert.equal(mediaAssetUrl("image/pic.png"), "media-asset://library/image/pic.png");
  // Outside the library, or the root itself, is not servable.
  assert.equal(mediaAssetUrlForFile(root, resolve(root, "..", "secret.mp4")), undefined);
  assert.equal(mediaAssetUrlForFile(root, root), undefined);
  assert.equal(mediaAssetUrlForFile(root, resolve(root, "index.json")), undefined);
  assert.equal(libraryRelativePath(root, resolve(root, "..", "secret.mp4")), null);
});

test("mime types are only served for the known render extensions", () => {
  assert.equal(mediaAssetMimeType("clip.mp4"), "video/mp4");
  assert.equal(mediaAssetMimeType("clip.WEBM"), "video/webm");
  assert.equal(mediaAssetMimeType("pic.png"), "image/png");
  assert.equal(mediaAssetMimeType("index.json"), null);
  assert.equal(mediaAssetMimeType("clip"), null);
});

test("a byte range parses against a known size", () => {
  const size = 1000;
  assert.deepEqual(parseByteRange(null, size), { kind: "none" });
  assert.deepEqual(parseByteRange("", size), { kind: "none" });
  assert.deepEqual(parseByteRange("bytes=0-99", size), { kind: "range", start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=990-", size), { kind: "range", start: 990, end: 999 });
  // Suffix form: the last N bytes.
  assert.deepEqual(parseByteRange("bytes=-100", size), { kind: "range", start: 900, end: 999 });
  // An end past the file is clamped to the last byte.
  assert.deepEqual(parseByteRange("bytes=999-5000", size), { kind: "range", start: 999, end: 999 });
  // A suffix larger than the file serves the whole file.
  assert.deepEqual(parseByteRange("bytes=-5000", size), { kind: "range", start: 0, end: 999 });
});

test("an unusable range is rejected, never served whole", () => {
  const size = 1000;
  for (const bad of ["bytes=abc", "bytes=-", "bytes=50-40", "bytes=1000-", "bytes=1200-", "bytes=0-10, 20-30", "items=0-1"]) {
    assert.deepEqual(parseByteRange(bad, size), { kind: "invalid" }, bad);
  }
  // A zero-length file cannot satisfy any range.
  assert.deepEqual(parseByteRange("bytes=0-", 0), { kind: "invalid" });
  assert.deepEqual(parseByteRange(null, 0), { kind: "none" });
});

test("206 and 200 responses carry the headers a video element needs", () => {
  const partial = rangeResponseHeaders(0, 1023, 4096, "video/mp4");
  assert.equal(partial["content-range"], "bytes 0-1023/4096");
  assert.equal(partial["content-length"], "1024");
  assert.equal(partial["accept-ranges"], "bytes");
  assert.equal(partial["content-type"], "video/mp4");
  assert.equal(contentRangeHeader(900, 999, 1000), "bytes 900-999/1000");

  const full = fullResponseHeaders(4096, "video/mp4");
  assert.equal(full["content-length"], "4096");
  assert.equal(full["accept-ranges"], "bytes");
  assert.equal(full["content-type"], "video/mp4");

  // A poster frame is taken by decoding a clip onto a canvas, and a cross-origin
  // element taints one unless the response allows it, so both response shapes have
  // to carry the pair — without it the frame is never drawable.
  for (const headers of [partial, full]) {
    assert.equal(
      headers["access-control-allow-origin"],
      "*",
      "the renderer may draw what it may display",
    );
    assert.match(headers["access-control-expose-headers"] ?? "", /content-range/);
  }
});

test("a poster frame is accepted only as a PNG inside the size cap", () => {
  const onePixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
  const accepted = decodeThumbnailDataUrl(`data:image/png;base64,${onePixelPng}`);
  assert.ok(accepted, "a canvas PNG is kept");
  assert.equal(accepted.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "it lands as a PNG");

  assert.equal(decodeThumbnailDataUrl("data:image/jpeg;base64,AAAA"), null, "only PNG");
  assert.equal(decodeThumbnailDataUrl("data:image/png;base64,"), null, "no bytes is no frame");
  assert.equal(decodeThumbnailDataUrl(onePixelPng), null, "a bare base64 string is not a data URL");
  assert.equal(
    decodeThumbnailDataUrl(
      `data:image/png;base64,${Buffer.from("definitely not a png").toString("base64")}`,
    ),
    null,
    "the magic number decides, not the label",
  );
  const oversized = Buffer.alloc(MAX_THUMBNAIL_BYTES + 1, 0x41);
  assert.equal(
    decodeThumbnailDataUrl(`data:image/png;base64,${oversized.toString("base64")}`),
    null,
    "an oversized frame is refused rather than written",
  );
});

test("the scheme is wired from startup to shutdown and allowed by the CSP", () => {
  const startup = readFileSync(join(desktopRoot, "electron/main/bootstrap/startup.ts"), "utf8");
  const shutdown = readFileSync(join(desktopRoot, "electron/main/bootstrap/shutdown.ts"), "utf8");
  const protocolSrc = readFileSync(join(desktopRoot, "electron/main/media-asset-protocol.ts"), "utf8");
  const html = readFileSync(join(desktopRoot, "index.html"), "utf8");

  assert.match(startup, /registerMediaAssetScheme\(\);/);
  assert.match(startup, /installMediaAssetProtocol\(dataDir\)/);
  assert.match(shutdown, /uninstallMediaAssetProtocol\(\)/);
  assert.match(protocolSrc, /registerSchemesAsPrivileged/);
  assert.match(protocolSrc, /protocol\.handle\(MEDIA_ASSET_SCHEME/);
  assert.match(protocolSrc, /resolveLibraryAsset\(root, url\.pathname\)/);
  // The renderer must be allowed to load the scheme it is handed, for video and
  // for a poster image alike.
  assert.match(html, /media-src[^;]*media-asset:/);
  assert.match(html, /img-src[^;]*media-asset:/);
});
