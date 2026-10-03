#!/usr/bin/env node
/**
 * Merge the per-architecture macOS electron-updater feeds into `latest-mac.yml`.
 *
 * Usage:
 *   node scripts/merge-mac-update-feed.mjs <release-dir>   # e.g. dist
 *
 * Each macOS lane packages one architecture and renames its feed to
 * `latest-mac-<arch>.yml`, because the publish job downloads every artifact
 * into a single directory with `merge-multiple: true` and two lanes writing one
 * `latest-mac.yml` would leave whichever uploaded last.
 *
 * That rename cannot be the end state: electron-updater builds the macOS
 * channel name as `latest` + `-mac` (see
 * `electron-updater/out/providers/Provider.js`, `getChannelFilePrefix`) and
 * requests `latest-mac.yml` on every Mac, regardless of architecture. With only
 * arch-suffixed files published, a Mac checks, gets 404, and reports a failed
 * update — while Windows (`latest.yml`) and Linux (`latest-linux.yml`) work.
 *
 * A single feed carrying both architectures is also what electron-updater
 * expects: `MacUpdater.filterFilesForArch` picks the matching entry by looking
 * for `arm64` in the file URL. So the merge concatenates the `files` arrays and
 * keeps one `version`.
 *
 * `path`/`sha512` are electron-updater's single-file fallback; `resolveFiles`
 * uses `files` whenever it is present, so the merged feed sets them from the
 * first entry purely to stay self-consistent.
 *
 * Exits non-zero on: no feed found, a malformed entry, a duplicate file URL, or
 * two feeds whose `version` disagrees — a release that mixes versions is a build
 * error, not something to paper over.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "dist";
const archFeedPattern = /^latest-mac-(.+)\.yml$/;

function fail(message) {
  console.error(`merge-mac-update-feed: ${message}`);
  process.exit(1);
}

/** Unwrap the single-quoted scalars electron-builder emits. */
function scalar(text) {
  const quoted = /^'(.*)'$/.exec(text);
  return quoted ? quoted[1] : text;
}

/**
 * Parse the fixed shape electron-builder writes for a macOS feed. Hand-rolled
 * on purpose: three known keys per file entry plus five scalars, and a YAML
 * dependency here would have to be a real one rather than a hoisted transitive
 * package that could vanish on the next install.
 */
function parseFeed(source, name) {
  const files = [];
  let version;
  let feedPath;
  let sha512;
  let releaseDate;
  let current = null;

  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      current = null;
      const colon = line.indexOf(":");
      if (colon === -1) fail(`${name}: unparsable line "${line}"`);
      const key = line.slice(0, colon);
      const value = scalar(line.slice(colon + 1).trim());
      switch (key) {
        case "version":
          version = value;
          break;
        case "path":
          feedPath = value;
          break;
        case "sha512":
          sha512 = value;
          break;
        case "releaseDate":
          releaseDate = value;
          break;
        case "files":
          if (value !== "") fail(`${name}: expected "files:" to start a list`);
          break;
        default:
          fail(`${name}: unexpected top-level key "${key}"`);
      }
      continue;
    }

    const itemMatch = /^-\s*(.*)$/.exec(line);
    if (itemMatch) {
      current = { url: undefined, sha512: undefined, size: undefined };
      files.push(current);
      const rest = itemMatch[1].trim();
      if (rest !== "") {
        const colon = rest.indexOf(":");
        if (colon === -1) fail(`${name}: unparsable list item "${rest}"`);
        current[rest.slice(0, colon)] = scalar(rest.slice(colon + 1).trim());
      }
      continue;
    }

    if (current === null) fail(`${name}: item key outside of a list item: "${line}"`);
    const colon = line.indexOf(":");
    if (colon === -1) fail(`${name}: unparsable item line "${line}"`);
    const key = line.slice(0, colon);
    if (key !== "url" && key !== "sha512" && key !== "size") {
      fail(`${name}: unexpected file key "${key}"`);
    }
    current[key] = scalar(line.slice(colon + 1).trim());
  }

  if (!version) fail(`${name}: no version`);
  if (files.length === 0) fail(`${name}: no files`);
  for (const file of files) {
    if (!file.url) fail(`${name}: a file entry has no url`);
    if (!file.sha512) fail(`${name}: ${file.url} has no sha512`);
    if (!file.size) fail(`${name}: ${file.url} has no size`);
  }
  return { version, path: feedPath, sha512, files, releaseDate };
}

const names = readdirSync(dir).filter((name) => archFeedPattern.test(name));
if (names.length === 0) {
  fail(`no latest-mac-<arch>.yml under ${dir}; refusing to publish without a macOS feed`);
}

const feeds = names
  .map((name) => ({ arch: archFeedPattern.exec(name)[1], name }))
  .sort((a, b) => a.arch.localeCompare(b.arch))
  .map(({ arch, name }) => ({ arch, name, ...parseFeed(readFileSync(path.join(dir, name), "utf8"), name) }));

const { version } = feeds[0];
for (const feed of feeds) {
  if (feed.version !== version) {
    fail(`${feed.name} declares version ${feed.version}, but ${feeds[0].name} declares ${version}`);
  }
}

const mergedFiles = [];
for (const feed of feeds) {
  for (const file of feed.files) {
    if (mergedFiles.some((existing) => existing.url === file.url)) {
      fail(`${file.url} appears in more than one feed`);
    }
    mergedFiles.push(file);
  }
}

const lines = [`version: ${version}`, "files:"];
for (const file of mergedFiles) {
  lines.push(`  - url: ${file.url}`);
  lines.push(`    sha512: ${file.sha512}`);
  lines.push(`    size: ${file.size}`);
}
const primary = mergedFiles[0];
lines.push(`path: ${primary.url}`);
lines.push(`sha512: ${primary.sha512}`);
const releaseDate = feeds.map((feed) => feed.releaseDate).filter(Boolean).sort().at(-1);
if (releaseDate) lines.push(`releaseDate: '${releaseDate}'`);
lines.push("");

writeFileSync(path.join(dir, "latest-mac.yml"), lines.join("\n"));
console.log(
  `merge-mac-update-feed: wrote latest-mac.yml from ${feeds.map((feed) => feed.arch).join(" + ")} ` +
    `(version ${version}, ${mergedFiles.length} files)`,
);
