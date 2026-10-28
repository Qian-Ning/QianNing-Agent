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
import { existsSync } from "node:fs";
import process from "node:process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", "pnpm build:js"], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });

console.log("[shared] building the desktop renderer");
execFileSync(node, [desktopCli, "build"], { cwd: desktop, stdio: ["ignore", "inherit", "inherit"] });

console.log("[shared] copying renderer into public/shared");
rmSync(target, { recursive: true, force: true });
cpSync(rendererOut, target, { recursive: true });

console.log("[shared] bundling the phone bridge");
const bootOut = join(appRoot, "public/shared/bridge-boot.js");
mkdirSync(join(appRoot, "public/shared"), { recursive: true });
const esbuild = join(repoRoot, "node_modules/esbuild/bin/esbuild");
if (!existsSync(esbuild)) throw new Error(`esbuild not found at ${esbuild}`);
execFileSync(
  node,
  [esbuild, join(appRoot, "src/bridge/boot.ts"), "--bundle", "--format=iife", "--platform=browser", "--target=es2022", `--outfile=${bootOut}`, "--log-level=warning"],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);


// The renderer's own bundle must not start before the bridge exists, or the
// first `invoke` in a module initializer hits an undefined `piDesktop`.
const indexFile = join(target, "index.html");
const html = readFileSync(indexFile, "utf8");
if (!html.includes("bridge-boot.js")) {
  const patched = html.replace(
    /(<script type="module"[^>]*><\/script>)/,
    '<script src="./bridge-boot.js"></script>\n    $1',
  );
  if (patched === html) throw new Error("could not find the renderer entry script to prepend the bridge to");
  writeFileSync(indexFile, patched, "utf8");
}

console.log(`[shared] ready: ${target}`);
