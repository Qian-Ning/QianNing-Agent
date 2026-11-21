/**
 * Release manifest and electron-updater feed verification.
 *
 * The release workflow stages every artifact in a draft GitHub Release. Before
 * that draft becomes visible it must prove two things:
 *
 *   1. every file recorded in `release-manifest.json` survived the artifact
 *      upload byte-for-byte (size, sha256, sha512); and
 *   2. every `latest*.yml` feed points at a file from that manifest with the
 *      same size and sha512.
 *
 * The manifest is written after the build, so it describes what this run
 * produced, not what some earlier tag promised. `SHA256SUMS.txt` exists for
 * users with stock `sha256sum`; the JSON exists for the workflow and for
 * scripts that need the base64 sha512 electron-updater uses.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const PRODUCT = "QianNing-Agent";
export const MANIFEST_FILE = "release-manifest.json";
export const CHECKSUM_FILE = "SHA256SUMS.txt";
export const FEED_FILES = ["latest.yml", "latest-linux.yml", "latest-mac.yml"];

export class ReleaseManifestError extends Error {}

const RESERVED = new Set([MANIFEST_FILE, CHECKSUM_FILE]);

/** A release asset name is a single basename, never a path. */
export function isSafeAssetName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return basename(name) === name;
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash a file for the lifetime of one read; no whole-file buffering. */
export async function hashFile(path, algorithm, encoding = "hex") {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest(encoding);
}

/** Files that belong in the manifest; manifest/checksums are outputs, not inputs. */
export async function listPayloadFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (RESERVED.has(entry.name)) continue;
    names.push(entry.name);
  }
  names.sort();
  return names;
}

/**
 * Build the manifest for `dir`. Every entry carries the same digests the
 * verifier recomputes after the draft download.
 */
export async function buildReleaseManifest(dir, version, options = {}) {
  if (!version) throw new ReleaseManifestError("version is required");
  const names = await listPayloadFiles(dir);
  if (names.length === 0) throw new ReleaseManifestError(`no release payload in ${dir}`);

  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    const size = (await stat(path)).size;
    files.push({
      name,
      size,
      sha256: await hashFile(path, "sha256"),
      sha512: await hashFile(path, "sha512", "base64"),
    });
  }

  const manifest = {
    product: options.product ?? PRODUCT,
    version,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    files,
  };
  if (options.commit) manifest.commit = options.commit;
  return manifest;
}

/** Write the manifest and the stock-tool checksum file that includes it. */
export async function writeReleaseManifest(dir, manifest) {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(dir, MANIFEST_FILE), manifestText, "utf8");

  const lines = manifest.files.map((file) => `${file.sha256}  ${file.name}`);
  lines.push(`${sha256Text(manifestText)}  ${MANIFEST_FILE}`);
  await writeFile(join(dir, CHECKSUM_FILE), `${lines.join("\n")}\n`, "utf8");
}

function scalar(text) {
  const quoted = /^(['"])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

function assignFeedField(entry, line, bad) {
  const colon = line.indexOf(":");
  if (colon === -1) bad(`unparsable file line "${line}"`);
  const key = line.slice(0, colon).trim();
  const value = scalar(line.slice(colon + 1).trim());
  if (key !== "url" && key !== "sha512" && key !== "size") return;
  entry[key] = value;
}

/**
 * Parse the fixed shape electron-builder writes for an update feed.
 *
 * Hand-rolled for the same reason as `merge-mac-update-feed.mjs`: the publish
 * job must not install dependencies before it can audit its own upload, and a
 * transitive YAML package is not a contract. Unknown top-level keys are
 * ignored so a future electron-builder field does not break an old release;
 * unknown file keys are not expected and are ignored as well.
 */
export function parseUpdateFeed(source, name = "feed") {
  const bad = (message) => {
    throw new ReleaseManifestError(`${name}: ${message}`);
  };
  let version;
  let feedPath;
  let sha512;
  let inFiles = false;
  let current = null;
  const files = [];

  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      current = null;
      inFiles = false;
      const colon = line.indexOf(":");
      if (colon === -1) bad(`unparsable line "${line}"`);
      const key = line.slice(0, colon).trim();
      const value = scalar(line.slice(colon + 1).trim());
      if (key === "version") version = value;
      else if (key === "path") feedPath = value;
      else if (key === "sha512") sha512 = value;
      else if (key === "files") {
        if (value !== "") bad('expected "files:" to start a list');
        inFiles = true;
      }
      continue;
    }

    if (!inFiles) continue;
    if (line.startsWith("-")) {
      current = { url: undefined, sha512: undefined, size: undefined };
      files.push(current);
      const rest = line.slice(1).trim();
      if (rest !== "") assignFeedField(current, rest, bad);
      continue;
    }
    if (current === null) bad(`item key outside of a list item: "${line}"`);
    assignFeedField(current, line, bad);
  }

  if (!version) bad("no version");
  if (files.length === 0) bad("no files");
  for (const file of files) {
    if (!file.url) bad("a file entry has no url");
    if (!isSafeAssetName(file.url)) bad(`unsafe asset url "${file.url}"`);
    if (!file.sha512) bad(`${file.url} has no sha512`);
    if (Buffer.from(file.sha512, "base64").length !== 64) bad(`${file.url} has a non-sha512 digest`);
    const size = Number(file.size);
    if (!Number.isInteger(size) || size <= 0) bad(`${file.url} has a non-numeric size "${file.size}"`);
    file.size = size;
  }

  if (feedPath && !isSafeAssetName(feedPath)) bad(`unsafe path "${feedPath}"`);
  return { version, path: feedPath, sha512, files };
}

function parseChecksums(source, name) {
  const map = new Map();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9a-f]{64})\s+[* ]?(.+)$/.exec(line);
    if (!match) throw new ReleaseManifestError(`${name}: unparsable checksum line "${line}"`);
    if (map.has(match[2])) throw new ReleaseManifestError(`${name}: duplicate checksum for ${match[2]}`);
    map.set(match[2], match[1]);
  }
  return map;
}

/**
 * Recompute every file in `dir` and cross-check it against the manifest, the
 * checksum file recoverable from it, and the updater feeds. Returns errors
 * instead of throwing so the CLI can print one `::error::` per problem.
 */
export async function verifyReleaseDirectory(dir, options = {}) {
  const errors = [];
  const checked = [];
  const manifestPath = options.manifestPath ?? join(dir, MANIFEST_FILE);
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`cannot read manifest ${manifestPath}: ${error.message}`], checked };
  }

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: [`manifest ${manifestPath} is not an object`], checked };
  }
  if (!manifest.version || !Array.isArray(manifest.files)) {
    return { ok: false, errors: [`manifest ${manifestPath} has no version or files array`], checked };
  }
  if (manifest.files.length === 0) {
    return { ok: false, errors: [`manifest ${manifestPath} has an empty files array`], checked };
  }
  if (options.version && manifest.version !== options.version) {
    errors.push(`manifest declares version ${manifest.version}, expected ${options.version}`);
  }

  const byName = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") {
      errors.push("manifest has a non-object file entry");
      continue;
    }
    if (!isSafeAssetName(entry.name)) {
      errors.push(`manifest has an unsafe asset name "${entry.name}"`);
      continue;
    }
    if (byName.has(entry.name)) {
      errors.push(`manifest repeats ${entry.name}`);
      continue;
    }
    byName.set(entry.name, entry);
  }

  for (const [name, entry] of byName) {
    const path = join(dir, name);
    try {
      const size = (await stat(path)).size;
      if (size !== entry.size) {
        errors.push(`${name}: size ${size}, manifest says ${entry.size}`);
        continue;
      }
      const sha256 = await hashFile(path, "sha256");
      const sha512 = await hashFile(path, "sha512", "base64");
      if (sha256 !== entry.sha256) errors.push(`${name}: sha256 mismatch`);
      if (sha512 !== entry.sha512) errors.push(`${name}: sha512 mismatch`);
      checked.push(name);
    } catch (error) {
      errors.push(`${name}: ${error.code === "ENOENT" ? "missing" : error.message}`);
    }
  }

  const actual = await listFiles(dir);
  const allowed = new Set([MANIFEST_FILE, CHECKSUM_FILE, ...byName.keys()]);
  if (!options.allowExtra) {
    for (const name of actual) {
      if (!allowed.has(name)) errors.push(`unexpected asset ${name} (not in the manifest)`);
    }
  }
  for (const name of byName.keys()) {
    if (!actual.includes(name)) errors.push(`manifest asset ${name} is missing from ${dir}`);
  }

  const sumsPath = join(dir, CHECKSUM_FILE);
  try {
    const sums = parseChecksums(await readFile(sumsPath, "utf8"), CHECKSUM_FILE);
    for (const [name, entry] of byName) {
      const declared = sums.get(name);
      if (declared === undefined) errors.push(`${CHECKSUM_FILE}: no sha256 for ${name}`);
      else if (declared !== entry.sha256) errors.push(`${CHECKSUM_FILE}: sha256 mismatch for ${name}`);
    }
    for (const name of sums.keys()) {
      if (name === MANIFEST_FILE || byName.has(name)) continue;
      errors.push(`${CHECKSUM_FILE}: checksum for unexpected file ${name}`);
    }
    const manifestText = await readFile(manifestPath, "utf8");
    const manifestDigest = sha256Text(manifestText);
    if (!sums.has(MANIFEST_FILE)) errors.push(`${CHECKSUM_FILE}: no sha256 for ${MANIFEST_FILE}`);
    else if (sums.get(MANIFEST_FILE) !== manifestDigest) errors.push(`${CHECKSUM_FILE}: sha256 mismatch for ${MANIFEST_FILE}`);
  } catch (error) {
    errors.push(error.code === "ENOENT" ? `${CHECKSUM_FILE}: missing` : error.message);
  }

  for (const feedName of FEED_FILES) {
    if (options.requireFeeds === false) continue;
    let feed;
    try {
      feed = parseUpdateFeed(await readFile(join(dir, feedName), "utf8"), feedName);
    } catch (error) {
      errors.push(error.code === "ENOENT" ? `${feedName}: missing` : error.message);
      continue;
    }
    if (feed.version !== manifest.version) {
      errors.push(`${feedName}: declares version ${feed.version}, manifest says ${manifest.version}`);
    }
    for (const file of feed.files) {
      const entry = byName.get(file.url);
      if (!entry) {
        errors.push(`${feedName}: references ${file.url}, which is not in the manifest`);
        continue;
      }
      if (file.size !== entry.size) errors.push(`${feedName}: ${file.url} size ${file.size}, manifest ${entry.size}`);
      if (file.sha512 !== entry.sha512) errors.push(`${feedName}: ${file.url} sha512 mismatch`);
    }
    if (feed.path) {
      const entry = byName.get(feed.path);
      if (!entry) errors.push(`${feedName}: path ${feed.path} is not in the manifest`);
      else if (feed.sha512 && feed.sha512 !== entry.sha512) errors.push(`${feedName}: path ${feed.path} sha512 mismatch`);
    }
  }

  return { ok: errors.length === 0, errors, checked, manifest };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}
