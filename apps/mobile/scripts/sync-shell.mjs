/**
 * Copies the client page out of the desktop's shell module into `www/`.
 *
 * The page lives in one place (`apps/desktop/electron/main/remote/app-shell.ts`)
 * because two delivery paths must not drift: the Host serves it at `/app`, and
 * this app bundles it. Editing the copy under `www/` is always wrong — run this
 * script instead.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const source = join(repo, "apps", "desktop", "electron", "main", "remote", "app-shell.ts");
const target = join(here, "..", "www", "index.html");

const module = await readFile(source, "utf8");
const marker = "const HTML = `";
const start = module.indexOf(marker);
if (start < 0) throw new Error(`no HTML template in ${source}`);
const bodyStart = start + marker.length;
const bodyEnd = module.indexOf("`;\n", bodyStart);
if (bodyEnd < 0) throw new Error("the HTML template is not terminated");

// The template escapes backslashes for TypeScript; the file form needs them
// literal so the browser receives the bytes the Host would have sent.
const html = module.slice(bodyStart, bodyEnd).replaceAll("\\\\", "\\");
if (!html.startsWith("<!doctype html>")) throw new Error("the extracted page does not start with a doctype");

await mkdir(dirname(target), { recursive: true });
await writeFile(target, html, "utf8");
console.log(`client shell: ${html.length} bytes -> apps/mobile/www/index.html`);
