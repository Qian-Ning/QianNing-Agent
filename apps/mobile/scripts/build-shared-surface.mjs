// Builds the shared surface into the phone app's assets.
//
// The phone runs the desktop renderer (ADR 0339). This script produces that
// renderer, bundles the bridge that replaces `window.piDesktop`, and stitches
// the two together in `public/shared/` so `vite build` + `cap sync` carry both.
//
//   node scripts/build-shared-surface.mjs
//
// It is deliberately not part of `build`: the shared surface is still behind a
// flag until a device run proves a prompt round-trip.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import process from "node:process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { injectBridgeBoot } from "./inject-bridge-boot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");
const desktop = join(repoRoot, "apps/desktop");
const rendererOut = join(desktop, "out/renderer");
const target = join(appRoot, "public/shared");

// Run the JS entries with the current node: the `.cmd` shims need a shell, and a
// shell mangles the workspace paths on Windows.
const node = process.execPath;
const desktopCli = join(desktop, "node_modules/electron-vite/bin/electron-vite.js");
if (!existsSync(desktopCli)) throw new Error(`electron-vite not found at ${desktopCli}`);

// The renderer imports workspace packages by their built entry points, so the
// shared JS must exist before electron-vite resolves them.
console.log("[shared] building workspace JS");
// Only Windows needs cmd.exe to run the pnpm shim; elsewhere pnpm is a script
// on PATH, and asking for cmd.exe there is what made this Windows-only.
if (process.platform === "win32") {
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", "pnpm build:js"], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
} else {
  execFileSync("pnpm", ["build:js"], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
}

console.log("[shared] building the desktop renderer");
execFileSync(node, [desktopCli, "build"], { cwd: desktop, stdio: ["ignore", "inherit", "inherit"] });

console.log("[shared] copying renderer into public/shared");
rmSync(target, { recursive: true, force: true });
cpSync(rendererOut, target, { recursive: true });

// The bridge bundle is built by esbuild, which cannot resolve `import.meta.glob`;
// the skills are emitted as data first so the bundle carries them like any module.
console.log("[shared] generating the skill data");
execFileSync(node, [join(appRoot, "scripts/build-skills.mjs")], { cwd: appRoot, stdio: ["ignore", "inherit", "inherit"] });

console.log("[shared] bundling the phone bridge");
const bootOut = join(appRoot, "public/shared/bridge-boot.js");
mkdirSync(join(appRoot, "public/shared"), { recursive: true });
// Through the JS API, not the CLI: `node_modules/esbuild/bin/esbuild` is a
// platform binary, so handing it to node is a syntax error everywhere.
const requireFromRoot = createRequire(join(repoRoot, "package.json"));
const esbuild = requireFromRoot("esbuild");
await esbuild.build({
  entryPoints: [join(appRoot, "src/bridge/boot.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: bootOut,
  logLevel: "warning",
});


// The renderer's own bundle must not start before the bridge exists, or the
// first `invoke` in a module initializer hits an undefined `piDesktop`.
const indexFile = join(target, "index.html");
const injected = injectBridgeBoot(indexFile);
console.log(`[shared] bridge bootstrap ${injected}`);

console.log(`[shared] ready: ${target}`);
