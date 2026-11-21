#!/usr/bin/env node
/**
 * Write `release-manifest.json` and `SHA256SUMS.txt` into a staged release dir.
 *
 * Usage:
 *   node scripts/generate-release-manifest.mjs --dir dist --version 2.4.2 --commit <sha>
 */

import { pathToFileURL } from "node:url";
import { buildReleaseManifest, writeReleaseManifest } from "./release-manifest.mjs";

function parseArgs(argv) {
  const args = { dir: "dist", version: "", commit: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dir") args.dir = value ?? "";
    else if (flag === "--version") args.version = value ?? "";
    else if (flag === "--commit") args.commit = value ?? "";
    else if (flag === "--help" || flag === "-h") args.help = true;
    if (flag.startsWith("--") && flag !== "--help" && flag !== "-h") index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/generate-release-manifest.mjs --dir <dist> --version <version> [--commit <sha>]");
    return 0;
  }
  if (!args.dir || !args.version) {
    console.error("generate-release-manifest: --dir and --version are required");
    return 2;
  }

  const manifest = await buildReleaseManifest(args.dir, args.version, { commit: args.commit });
  await writeReleaseManifest(args.dir, manifest);
  console.log(`release manifest: ${manifest.files.length} files for ${manifest.version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`generate-release-manifest: ${error.message}`);
    process.exitCode = 1;
  });
}
