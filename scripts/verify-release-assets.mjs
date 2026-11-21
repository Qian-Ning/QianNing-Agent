#!/usr/bin/env node
/**
 * Verify every staged/downloaded release asset against release-manifest.json.
 *
 * Usage:
 *   node scripts/verify-release-assets.mjs --dir dist --version 2.4.2
 *   node scripts/verify-release-assets.mjs --dir verify --manifest dist/release-manifest.json
 */

import { pathToFileURL } from "node:url";
import { verifyReleaseDirectory } from "./release-manifest.mjs";

function parseArgs(argv) {
  const args = { dir: "dist", manifest: "", version: "", allowExtra: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dir") {
      args.dir = argv[index + 1] ?? "";
      index += 1;
    } else if (flag === "--manifest") {
      args.manifest = argv[index + 1] ?? "";
      index += 1;
    } else if (flag === "--version") {
      args.version = argv[index + 1] ?? "";
      index += 1;
    } else if (flag === "--allow-extra") {
      args.allowExtra = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/verify-release-assets.mjs --dir <dir> [--manifest <file>] [--version <v>] [--allow-extra]");
    return 0;
  }
  if (!args.dir) {
    console.error("verify-release-assets: --dir is required");
    return 2;
  }

  const result = await verifyReleaseDirectory(args.dir, {
    manifestPath: args.manifest || undefined,
    version: args.version || undefined,
    allowExtra: args.allowExtra,
  });

  for (const error of result.errors) console.error(`::error::${error}`);
  if (!result.ok) {
    console.error(`release assets FAILED: ${result.errors.length} problem(s) in ${args.dir}`);
    return 1;
  }
  console.log(`release assets verified: ${result.checked.length} files, version ${result.manifest.version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`verify-release-assets: ${error.message}`);
    process.exitCode = 1;
  });
}
