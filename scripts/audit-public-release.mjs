#!/usr/bin/env node
/**
 * Audit a published GitHub Release over its *public, anonymous* URLs.
 *
 * A draft upload only proves what the API accepted with a token. This script
 * fetches the exact bytes an electron-updater client will fetch, without an
 * Authorization header, and compares them to the local release manifest and
 * the local updater feeds. If it fails, the release is not a safe update feed.
 *
 * Usage:
 *   node scripts/audit-public-release.mjs \
 *     --repo Qian-Ning/QianNing-Agent --tag v2.4.2 --version 2.4.2 \
 *     --manifest dist/release-manifest.json
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHECKSUM_FILE,
  FEED_FILES,
  MANIFEST_FILE,
  PRODUCT,
  isSafeAssetName,
  parseUpdateFeed,
} from "./release-manifest.mjs";

function parseArgs(argv) {
  const args = { repo: process.env.GITHUB_REPOSITORY ?? "", tag: "", version: "", manifest: "", attempts: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--repo") args.repo = value ?? "";
    else if (flag === "--tag") args.tag = value ?? "";
    else if (flag === "--version") args.version = value ?? "";
    else if (flag === "--manifest") args.manifest = value ?? "";
    else if (flag === "--attempts") args.attempts = Number(value ?? 6);
    else if (flag === "--help" || flag === "-h") args.help = true;
    if (flag.startsWith("--") && flag !== "--help" && flag !== "-h") index += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBuffer(url, timeoutMs, attempts) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "qianning-release-audit", "Cache-Control": "no-store" },
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      last = `${response.status} ${response.statusText}`;
      if (response.status !== 404 && response.status !== 403 && response.status !== 429) {
        throw new Error(`${url}: ${last}`);
      }
    } catch (error) {
      last = error.message;
    }
    if (attempt < attempts) await sleep(2000 * attempt);
  }
  throw new Error(`${url}: ${last ?? "unreachable"}`);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sha512 = (buffer) => createHash("sha512").update(buffer).digest("base64");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/audit-public-release.mjs --repo <owner/name> --tag <tag> --version <v> --manifest <file>");
    return 0;
  }
  if (!args.repo || !args.tag || !args.version || !args.manifest) {
    console.error("audit-public-release: --repo, --tag, --version and --manifest are required");
    return 2;
  }
  if (args.tag.replace(/^v/, "") !== args.version) {
    console.error(`audit-public-release: tag ${args.tag} does not match version ${args.version}`);
    return 2;
  }

  const manifestText = await readFile(args.manifest, "utf8");
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== args.version) {
    console.error(`audit-public-release: manifest version ${manifest.version}, expected ${args.version}`);
    return 1;
  }
  const byName = new Map(manifest.files.map((file) => [file.name, file]));
  const localDir = dirname(args.manifest);
  const base = `https://github.com/${args.repo}/releases/download/${encodeURIComponent(args.tag)}`;
  const errors = [];

  async function remote(name, timeoutMs = 60_000) {
    const url = `${base}/${encodeURIComponent(name)}`;
    return fetchBuffer(url, timeoutMs, args.attempts);
  }

  async function expectLocalFile(name) {
    const local = await readFile(join(localDir, name));
    const body = await remote(name);
    if (!local.equals(body)) errors.push(`${name}: public bytes differ from the staged file`);
    return body;
  }

  async function expectManifestFile(name) {
    const entry = byName.get(name);
    if (!entry) {
      errors.push(`${name}: not in ${MANIFEST_FILE}`);
      return remote(name);
    }
    const local = await readFile(join(localDir, name));
    if (local.length !== entry.size) errors.push(`${name}: staged size ${local.length}, manifest ${entry.size}`);
    if (sha256(local) !== entry.sha256) errors.push(`${name}: staged sha256 does not match ${MANIFEST_FILE}`);
    const body = await remote(name);
    if (!local.equals(body)) errors.push(`${name}: public bytes differ from the staged file`);
    return body;
  }

  // The manifest and the checksum file are themselves release assets. Comparing
  // their bytes proves the public copy is the one this run staged, not a stale
  // upload from an earlier tag.
  await expectLocalFile(MANIFEST_FILE);
  await expectLocalFile(CHECKSUM_FILE);

  let windowsFeed;
  for (const feedName of FEED_FILES) {
    const body = await expectManifestFile(feedName);
    const remoteText = body.toString("utf8");
    let feed;
    try {
      feed = parseUpdateFeed(remoteText, feedName);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (feed.version !== args.version) errors.push(`${feedName}: declares version ${feed.version}, expected ${args.version}`);
    for (const file of feed.files) {
      if (!byName.has(file.url)) errors.push(`${feedName}: references ${file.url}, which is not in ${MANIFEST_FILE}`);
    }
    if (feedName === "latest.yml") windowsFeed = feed;
  }

  if (!windowsFeed) {
    errors.push("latest.yml: missing or unparsable; cannot audit the Windows installer");
  } else {
    const expected = `${PRODUCT}-Setup-${args.version}.exe`;
    const primary = windowsFeed.path ?? expected;
    const entry = byName.get(primary);
    if (primary !== expected) {
      errors.push(`latest.yml: path ${primary}, expected the setup installer ${expected}`);
    } else if (!entry) {
      errors.push(`latest.yml: path ${primary} is not in ${MANIFEST_FILE}`);
    } else if (!isSafeAssetName(primary)) {
      errors.push(`latest.yml: unsafe path ${primary}`);
    } else if (windowsFeed.sha512 && windowsFeed.sha512 !== entry.sha512) {
      errors.push(`latest.yml: top-level sha512 does not match ${primary}`);
    } else {
      const body = await remote(primary, 300_000);
      if (body.length !== entry.size) errors.push(`${primary}: public size ${body.length}, manifest ${entry.size}`);
      if (sha256(body) !== entry.sha256) errors.push(`${primary}: public sha256 mismatch`);
      if (sha512(body) !== entry.sha512) errors.push(`${primary}: public sha512 mismatch`);
      console.log(`public installer: ${primary} (${body.length} bytes, sha256 ${entry.sha256.slice(0, 16)}...)`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    console.error(`public release audit FAILED: ${errors.length} problem(s)`);
    return 1;
  }
  console.log(`public release audit OK: ${args.repo} ${args.tag} (${FEED_FILES.length} feeds, ${args.version})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`audit-public-release: ${error.message}`);
    process.exitCode = 1;
  });
}
