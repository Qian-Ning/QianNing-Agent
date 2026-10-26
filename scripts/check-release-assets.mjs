#!/usr/bin/env node
/**
 * Release asset audit: the published release must contain every artifact the
 * build matrix declared, and every electron-updater feed must describe the
 * version being tagged.
 *
 * Usage:
 *   node scripts/check-release-assets.mjs --version 2.0.0 --dir dist
 *   node scripts/check-release-assets.mjs --version 2.0.0 --assets-from assets.txt
 *
 * `--dir` audits a staged build directory before anything is published and is
 * the only mode that can read feed contents. `--assets-from` audits a published
 * release from a newline-separated asset list, normally produced by
 * `gh release view "$TAG" --json assets --jq '.assets[].name'`.
 *
 * Why this exists: a build matrix entry can fail for one platform while the
 * rest of the release still publishes. Nothing about a green Release run
 * implies every platform shipped — the release has to be checked against the
 * declared set. Assets beyond the declared set are allowed (the per-architecture
 * macOS feeds are intermediates), a missing one is not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCT = "QianNing-Agent";
const FEEDS = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];

/**
 * Every asset the release contract promises, derived from the electron-builder
 * targets in apps/desktop/package.json and the pi-host bundle job. Keep this in
 * lockstep with that configuration: if a target is added or an artifactName
 * template changes, this list changes in the same commit, and a release that
 * silently drops a platform fails here instead of shipping.
 */
export function expectedAssets(version) {
  const windows = [
    `${PRODUCT}-Setup-${version}.exe`,
    `${PRODUCT}-Setup-${version}.exe.blockmap`,
    `${PRODUCT}-Portable-${version}.exe`,
    `${PRODUCT}-Portable-${version}.zip`,
  ];
  const macos = ["arm64", "x64"].flatMap((arch) => [
    `${PRODUCT}-${version}-${arch}.dmg`,
    `${PRODUCT}-${version}-${arch}.dmg.blockmap`,
    `${PRODUCT}-${version}-${arch}-mac.zip`,
    `${PRODUCT}-${version}-${arch}-mac.zip.blockmap`,
  ]);
  const linux = [
    // The release workflow renames the AppImage before uploading: electron-builder
    // writes `${productName}-${version}.${ext}` with a space, GitHub publishes it
    // with a dot, and the updater feed carries electron-builder's hyphen form.
    // The workflow makes all three the dotted name this list declares.
    `QianNing.Agent-${version}.AppImage`,
    `qianning-agent_${version}_amd64.deb`,
    `qianning-agent-${version}-x86_64.rpm`,
    `${PRODUCT}-${version}-linux-x64.asar`,
  ];
  const host = [
    `pi-host-${version}-linux-x64.tar.gz`,
    `pi-host-${version}-linux-x64.tar.gz.sha256`,
  ];
  return [...windows, ...macos, ...linux, ...host, ...FEEDS];
}

/**
 * Compares the declared set against what actually exists.
 *
 * @param {string} version
 * @param {string[]} actual asset names present in the release
 * @param {Record<string, string>} [feedVersions] feed file name -> version it declares
 */
export function auditAssets(version, actual, feedVersions = {}) {
  const present = new Set(actual);
  const required = expectedAssets(version);
  const missing = required.filter((name) => !present.has(name));
  const feedMismatches = [];
  for (const feed of FEEDS) {
    const declared = feedVersions[feed];
    if (declared === undefined || missing.includes(feed)) continue;
    if (declared !== version) feedMismatches.push({ feed, declared, expected: version });
  }
  return { required, missing, feedMismatches, ok: missing.length === 0 && feedMismatches.length === 0 };
}

/** Reads the `version:` field of an electron-updater YAML feed. */
export function feedVersion(text) {
  const match = /^version:\s*"?([^"\n]+)"?\s*$/m.exec(text);
  return match?.[1]?.trim();
}

function parseArgs(argv) {
  const args = { version: "", dir: "", assetsFrom: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--version") args.version = value ?? "";
    else if (flag === "--dir") args.dir = value ?? "";
    else if (flag === "--assets-from") args.assetsFrom = value ?? "";
    else if (flag === "--help" || flag === "-h") args.help = true;
    if (flag.startsWith("--") && flag !== "--help" && flag !== "-h") i += 1;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/check-release-assets.mjs --version <v> (--dir <dist> | --assets-from <file>)");
    return 0;
  }
  if (!args.version) {
    console.error("check-release-assets: --version is required");
    return 2;
  }
  if (!args.dir && !args.assetsFrom) {
    console.error("check-release-assets: pass --dir or --assets-from");
    return 2;
  }

  /** @type {string[]} */
  let assets;
  /** @type {Record<string, string>} */
  const feedVersions = {};
  if (args.dir) {
    assets = readdirSync(args.dir);
    for (const feed of FEEDS) {
      if (!assets.includes(feed)) continue;
      const declared = feedVersion(readFileSync(join(args.dir, feed), "utf8"));
      if (declared) feedVersions[feed] = declared;
    }
  } else {
    assets = readFileSync(args.assetsFrom, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const result = auditAssets(args.version, assets, feedVersions);
  if (result.ok) {
    console.log(`release assets OK: ${result.required.length} declared assets present for ${args.version}`);
    return 0;
  }
  for (const name of result.missing) console.error(`::error::missing release asset: ${name}`);
  for (const { feed, declared, expected } of result.feedMismatches) {
    console.error(`::error::${feed} declares version ${declared}, expected ${expected}`);
  }
  console.error(
    `release assets FAILED for ${args.version}: ${result.missing.length} missing, ${result.feedMismatches.length} feed mismatch(es)`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
