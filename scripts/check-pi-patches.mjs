#!/usr/bin/env node
/**
 * Require every Pi patch to be mapped in pnpm-workspace.yaml, installed by
 * pnpm, recorded in pnpm-lock.yaml, and to still carry the audited contracts.
 *
 * Usage:
 *   node scripts/check-pi-patches.mjs
 *   node scripts/check-pi-patches.mjs --root <dir>
 *   pnpm check:pi-patches
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPatchHashes } from "./pi-patch-hash.mjs";

function parseArgs(argv) {
  let out = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      out = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

const root = parseArgs(process.argv.slice(2));
const targetVersion = "1.4.0";
const entries = [
  {
    name: "@earendil-works/pi-agent-core",
    patch: `patches/@earendil-works__pi-agent-core@${targetVersion}.patch`,
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-agent-core",
    markers: ["localRequestErrorDetails"],
  },
  {
    name: "@earendil-works/pi-ai",
    patch: `patches/@earendil-works__pi-ai@${targetVersion}.patch`,
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-ai",
    markers: ["hostedSearch", "withLocalRequestErrors", "AnthropicOAuthTokenError", "Retry-After"],
  },
];
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");

for (const entry of entries) {
  if (!existsSync(join(root, entry.patch))) throw new Error(`Missing patch: ${entry.patch}`);
  const patchText = readFileSync(join(root, entry.patch), "utf8");
  if (/diff --git a\/[^\n]*package-lock\.json/.test(patchText)) {
    throw new Error(`${entry.patch} must not change unrelated upstream package-lock.json files`);
  }
  for (const marker of entry.markers) {
    if (!patchText.includes(marker)) throw new Error(`${entry.patch} is missing audited behavior marker ${marker}`);
  }
  const workspaceMapping = `'${entry.name}@${targetVersion}': ${entry.patch}`;
  if (!workspace.includes(workspaceMapping)) throw new Error(`pnpm-workspace.yaml does not map ${entry.name} to ${entry.patch}`);
  const packagePath = join(root, entry.packagePath);
  if (!existsSync(packagePath)) {
    throw new Error(`Install dependencies before this check; missing ${entry.packagePath}`);
  }
  const patchHashes = installedPatchHashes(root, entry.name, targetVersion);
  if (patchHashes.length === 0) {
    throw new Error(`${entry.name}@${targetVersion} is not installed as a patched instance`);
  }
  const unlocked = patchHashes.filter(
    (patchHash) => !lockfile.includes(`${entry.name}@${targetVersion}(patch_hash=${patchHash}`),
  );
  if (unlocked.length > 0) {
    throw new Error(
      `${entry.name}@${targetVersion} installed patch hash is absent from pnpm-lock.yaml: ${unlocked.join(", ")}`,
    );
  }
}

const piAiPatch = readFileSync(join(root, entries[1].patch), "utf8");
const patchedDeepseekCatalogLine = piAiPatch
  .split("\n")
  .find((line) => line.startsWith('+{"openai-completions":') && line.includes('"chat:deepseek-flash"'));
if (!patchedDeepseekCatalogLine) {
  throw new Error("Pi AI patch is missing its DeepSeek Flash transcript-capability record");
}
const patchedDeepseekCatalog = JSON.parse(patchedDeepseekCatalogLine.slice(1));
if (
  patchedDeepseekCatalog["openai-completions"]?.["chat:deepseek-flash"]?.baseUrl !== "https://api.deepseek.com" ||
  patchedDeepseekCatalog["openai-completions"]?.["chat:deepseek-flash"]?.compat?.supportsMidConvoSystemMessages !== true
) {
  throw new Error("Pi AI patch must scope mid-conversation system support to the published DeepSeek Flash endpoint");
}
for (const touchedPath of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/types.d.ts",
  "dist/utils/estimate.js",
  "dist/utils/estimate.d.ts",
  "dist/utils/local-request-error.js",
  "dist/utils/local-request-error.d.ts",
  "dist/utils/local-request-stream.js",
  "dist/utils/local-request-stream.d.ts",
]) {
  if (!piAiPatch.includes(`diff --git a/${touchedPath} `)) {
    throw new Error(`Pi AI patch is missing the audited file ${touchedPath}`);
  }
}

// Upstream removed hosted search, so its token estimator's assistant-content
// fallback assumes every non-text block is a tool call and reads `block.name`.
// A stored search result has no `name`, which threw a TypeError and took
// compaction's estimate down with it. Losing this branch is a crash, not a
// cosmetic regression, so it is audited here rather than left to a test that
// may not exercise a persisted transcript.
if (!piAiPatch.includes('block.type === "hostedSearch"')) {
  throw new Error("Pi AI patch is missing the hosted-search token estimate branch");
}

process.stdout.write(`All Pi ${targetVersion} patches are mapped, locked, installed, and contain the audited contracts.\n`);
