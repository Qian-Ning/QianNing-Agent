// Injects the phone bridge bootstrap into the built renderer entry.
//
// The Vite output is a self-closing module script tag
// (`<script type="module" crossorigin src="...">`), so the injection has to
// match the tag itself. A pattern that looks for a paired `</script>` never
// matches that shape, and the phone then ships without `window.piDesktop`:
// every bridge call fails, the renderer prints "piDesktop preload bridge
// unavailable", and the settings pages answer with an empty list.
//
// This module is the one place that knows how to wire the bridge in.

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Adds the bridge script tag to a renderer index.html, once.
 *
 * @param {string} indexFile absolute path to the built index.html
 * @returns {"injected" | "already-present"} what the file needed
 */
export function injectBridgeBoot(indexFile) {
  let html = readFileSync(indexFile, "utf8");
  if (html.includes("bridge-boot.js")) return "already-present";

  /*
    The bootstrap has to sit *before* the renderer entry, not inside it. The
    built entry is a self-closing `<script type="module" src="...">`: a tag
    inserted after its opening tag is swallowed by it — the module loads from
    its src and the nested script is never parsed, so the bridge never runs and
    every host call fails.
  */
  const moduleScript = html.match(/<script\b[^>]*\bsrc="[^"]*"[^>]*>/);
  if (moduleScript) {
    const insertAt = moduleScript.index;
    html =
      html.slice(0, insertAt) +
      '<script src="./bridge-boot.js"></script>\n    ' +
      html.slice(insertAt);
    writeFileSync(indexFile, html, "utf8");
    return "injected";
  }

  const pairedScript = html.match(/<script\b[^>]*type="module"[^>]*><\/script>/);
  if (!pairedScript) {
    throw new Error(
      `could not find the renderer entry script in ${indexFile} to prepend the bridge to`,
    );
  }
  const patched = html.replace(
    pairedScript[0],
    `<script src="./bridge-boot.js"></script>\n    ${pairedScript[0]}`,
  );
  writeFileSync(indexFile, patched, "utf8");
  return "injected";
}

// Run as a script: `node scripts/inject-bridge-boot.mjs <index.html>`.
if (process.argv[1] && process.argv[1].endsWith("inject-bridge-boot.mjs")) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/inject-bridge-boot.mjs <index.html>");
    process.exit(1);
  }
  console.log(`bridge bootstrap ${injectBridgeBoot(target)}`);
}
