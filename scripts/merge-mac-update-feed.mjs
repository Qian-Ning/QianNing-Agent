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
 * Refuses to publish on: no feed found, a malformed entry, a duplicate file
 * URL, or two feeds whose `version` disagrees — a release that mixes versions is
 * a build error, not something to paper over. The checks live in exported
 * functions so `apps/desktop/test/mac-update-feed.test.mjs` can exercise them
 * without spawning a process.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ARCH_FEED_PATTERN = /^latest-mac-(.+)\.yml$/;

/** A build-state problem worth failing the release for. */
export class MacFeedError extends Error {}

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
export function parseMacFeed(source, name) {
  const files = [];
  let version;
  let feedPath;
  let sha512;
  let releaseDate;
  let current = null;

  const bad = (message) => {
    throw new MacFeedError(`${name}: ${message}`);
  };

  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      current = null;
      const colon = line.indexOf(":");
      if (colon === -1) bad(`unparsable line "${line}"`);
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
          if (value !== "") bad('expected "files:" to start a list');
          break;
        default:
          bad(`unexpected top-level key "${key}"`);
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
        if (colon === -1) bad(`unparsable list item "${rest}"`);
        current[rest.slice(0, colon)] = scalar(rest.slice(colon + 1).trim());
      }
      continue;
    }

    if (current === null) bad(`item key outside of a list item: "${line}"`);
    const colon = line.indexOf(":");
    if (colon === -1) bad(`unparsable item line "${line}"`);
    const key = line.slice(0, colon);
    if (key !== "url" && key !== "sha512" && key !== "size") {
      bad(`unexpected file key "${key}"`);
    }
    current[key] = scalar(line.slice(colon + 1).trim());
  }

  if (!version) bad("no version");
  if (files.length === 0) bad("no files");
  for (const file of files) {
    if (!file.url) bad("a file entry has no url");
    if (!file.sha512) bad(`${file.url} has no sha512`);
    if (!file.size) bad(`${file.url} has no size`);
    // YAML gives a consumer a number here, so model it the same way; a feed
    // whose size is not a positive integer is corrupt and must not ship.
    const size = Number(file.size);
    if (!Number.isInteger(size) || size <= 0) {
      bad(`${file.url} has a non-numeric size "${file.size}"`);
    }
    file.size = size;
  }
  return { version, path: feedPath, sha512, files, releaseDate };
}

/**
 * Read every `latest-mac-<arch>.yml` in `dir` and return the feed
 * electron-updater expects as `latest-mac.yml`. Throws `MacFeedError` when the
 * directory cannot produce a trustworthy feed.
 */
export function buildMacUpdateFeed(dir) {
  const names = readdirSync(dir).filter((name) => ARCH_FEED_PATTERN.test(name));
  if (names.length === 0) {
    throw new MacFeedError(
      `no latest-mac-<arch>.yml under ${dir}; refusing to publish without a macOS feed`,
    );
  }

  const feeds = names
    .map((name) => ({ arch: ARCH_FEED_PATTERN.exec(name)[1], name }))
    .sort((a, b) => a.arch.localeCompare(b.arch))
    .map(({ arch, name }) => ({
      arch,
      name,
      ...parseMacFeed(readFileSync(path.join(dir, name), "utf8"), name),
    }));

  const version = feeds[0].version;
  for (const feed of feeds) {
    if (feed.version !== version) {
      throw new MacFeedError(
        `${feed.name} declares version ${feed.version}, but ${feeds[0].name} declares ${version}`,
      );
    }
  }

  const files = [];
  for (const feed of feeds) {
    for (const file of feed.files) {
      if (files.some((existing) => existing.url === file.url)) {
        throw new MacFeedError(`${file.url} appears in more than one feed`);
      }
      files.push(file);
    }
  }

  const releaseDate = feeds
    .map((feed) => feed.releaseDate)
    .filter(Boolean)
    .sort()
    .at(-1);

  return { version, files, releaseDate, arches: feeds.map((feed) => feed.arch) };
}

/** Render the merged feed as the YAML electron-builder would have written. */
export function renderMacUpdateFeed(feed) {
  const lines = [`version: ${feed.version}`, "files:"];
  for (const file of feed.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  const primary = feed.files[0];
  lines.push(`path: ${primary.url}`);
  lines.push(`sha512: ${primary.sha512}`);
  if (feed.releaseDate) lines.push(`releaseDate: '${feed.releaseDate}'`);
  lines.push("");
  return lines.join("\n");
}

/** Build and write `latest-mac.yml`; returns the merged feed. */
export function mergeMacUpdateFeeds(dir) {
  const feed = buildMacUpdateFeed(dir);
  writeFileSync(path.join(dir, "latest-mac.yml"), renderMacUpdateFeed(feed));
  return feed;
}

function main() {
  const dir = process.argv[2] ?? "dist";
  try {
    const feed = mergeMacUpdateFeeds(dir);
    console.log(
      `merge-mac-update-feed: wrote latest-mac.yml from ${feed.arches.join(" + ")} ` +
        `(version ${feed.version}, ${feed.files.length} files)`,
    );
  } catch (error) {
    if (!(error instanceof MacFeedError)) throw error;
    console.error(`merge-mac-update-feed: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
