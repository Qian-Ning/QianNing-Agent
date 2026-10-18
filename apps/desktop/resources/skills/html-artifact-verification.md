---
name: html-artifact-verification
description: a generated HTML file has to be checked for correctness before anyone opens it in a browser
---

# Checking an HTML artifact without opening a browser

An HTML artifact — a report, a diagram page, a dashboard, a generated document —
usually has no tests, because it does not look like code. It is code, and the
failure mode is quiet: the file opens, the browser shows a page, and the data is
missing, the script threw before the first render, or the image is a broken icon.

Everything below runs on the file itself, with no browser and no headless
dependency. The claims it can make are narrow and checkable; the claims a
screenshot makes are broad and unverifiable.

## What a screenshot cannot prove

- That the visible text is the text you generated — it proves some text appeared.
- That every `src` and `href` resolves. A missing image is a subtly wrong layout,
  and a missing stylesheet is a page that "looks fine" in a different way.
- That the inline script did not throw. The browser prints the error to a console
  nobody has open, and the page renders a skeleton.
- That the page works at another width, in print, with JavaScript disabled, by
  keyboard only, or with reduced motion.
- That a number in a table is correct. Rendering is not correctness.
- Anything reproducible: a screenshot has no assertion, no diff, no line number,
  and no exit code.

Use a screenshot for *appearance* after the structural checks pass. It is the
last check, not the first.

## Assert in six groups

1. **Structure.** A doctype, exactly one `<body>`, and a floor on the visible
   text length after stripping `<script>`, `<style>`, and comments. The floor is
   the empty-render detector: a template that produced `<div id="root"></div>`
   has a doctype, a body, and no content.
2. **No unsubstituted holes or leaked values.** `{{...}}`, `${...}`, and text
   nodes that are exactly `undefined`, `NaN`, or `[object Object]`. Each one is a
   variable that never got a value, and each one is invisible in a screenshot
   because a human reads past it.
3. **References resolve.** Every relative `src` and `href`, with the query and
   fragment stripped and the path decoded, must exist next to the artifact. Also
   check `#fragment` targets against the `id` set, and `url(...)` inside a
   `<style>` block.
4. **Inline scripts parse.** Parse each one; a syntax error means the page
   renders with no behaviour at all.
5. **Embedded JSON parses.** Data islands (`type="application/json"` and the
   linked-data variants) are the payload of most generated pages. `JSON.parse`
   them.
6. **Scripts run against the page's own ids.** Build a stub `document` from the
   ids the file actually declares, then run each inline script in it. A script
   that calls `getElementById("summary")` on a page with no such element throws a
   `TypeError` here — which is exactly the error the browser would have logged
   and swallowed. Capture `console.error` and `console.warn` in the same
   sandbox and fail if anything was written.

## The runner

Save as `verify.mjs`, run `node verify.mjs artifact.html`. No dependencies.

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const file = process.argv[2];
assert.ok(file, "usage: node verify.mjs <artifact.html>");
const html = readFileSync(file, "utf8");
const base = dirname(resolve(file));

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// 1. Structure: a doctype, one body, and something actually rendered.
assert.match(html, /^<!doctype html>/i, "missing doctype");
assert.equal((html.match(/<body\b/gi) || []).length, 1, "expected exactly one <body>");
const visible = strip(html);
assert.ok(visible.length > 60, `visible text is ${visible.length} chars - the page renders empty`);

// 2. Unsubstituted template holes and leaked JS values.
for (const hole of [/\{\{[^}]*\}\}/, /\$\{[^}]*\}/, />\s*undefined\s*</, />\s*NaN\s*</, />\s*\[object Object\]\s*</]) {
  assert.doesNotMatch(html, hole, `unrendered or leaked value: ${hole}`);
}

// 3. Every local reference resolves on disk.
const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1])
  .filter((u) => u && !/^(?:[a-z]+:|\/\/|#)/i.test(u));
for (const ref of refs) {
  const target = resolve(base, decodeURIComponent(ref.split(/[?#]/)[0]));
  assert.ok(existsSync(target), `reference does not resolve: ${ref} -> ${target}`);
}

// 4. Each inline script parses. A syntax error renders nothing and fails silently.
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/type\s*=\s*"application\/(ld\+)?json"/i.test(m[1]));
for (const [, , code] of inline) {
  assert.doesNotThrow(() => new vm.Script(code, { filename: file }), `inline script does not parse in ${file}`);
}

// 5. Embedded JSON payloads must parse.
for (const [, , body] of html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)) {
  assert.doesNotThrow(() => JSON.parse(body), "embedded JSON does not parse");
}

// 6. Run the inline scripts against a stub built from the ids the page declares.
// A missing id throws here, which is the error a browser would only log to the console.
const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
const el = () => ({ textContent: "", innerHTML: "", value: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {}, focus() {} });
const byId = (id) => (ids.has(id) ? el() : null);
const document = {
  querySelector: (sel) => (/^#[\w-]+$/.test(sel) ? byId(sel.slice(1)) : el()),
  querySelectorAll: () => [],
  getElementById: byId,
  createElement: el,
  addEventListener() {},
  body: el(),
  documentElement: el(),
};
const logged = [];
const consoleStub = { log() {}, info() {}, debug() {}, warn: (...a) => logged.push(a.join(" ")), error: (...a) => logged.push(a.join(" ")) };
const sandbox = { document, window: { addEventListener() {} }, console: consoleStub, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(0) };
sandbox.globalThis = sandbox;
for (const [, , code] of inline) {
  assert.doesNotThrow(() => vm.runInNewContext(code, sandbox, { filename: file, timeout: 2000 }),
    "inline script threw against the page's own ids - a browser would render nothing here");
}

assert.deepEqual(logged, [], `the page logged errors or warnings: ${logged.join(" | ")}`);

console.log(`ok: ${file} (${html.length} bytes, ${visible.length} chars visible, ${refs.length} refs, ${inline.length} inline scripts, ${ids.size} ids)`);
```

On a passing artifact it prints one line:

```
ok: report.html (613 bytes, 99 chars visible, 0 refs, 1 inline scripts, 2 ids)
```

Every failure is an assertion message with the offending value, which is the
thing a screenshot can never give you.

## Tune three numbers per artifact

- **The visible-text floor.** Sixty characters is a smoke test. For a real
  artifact, derive it from the design: number of sections × a minimum per
  section. A report with twelve sections and 60 characters of text is broken even
  though this script passes it.
- **The reference set.** Some references are legitimately external (a font, a
  CDN script). Keep an allow-list of exact URLs rather than loosening the filter
  to "ignore anything starting with http", or the check stops catching typos.
- **The stub.** Add the handful of members your page actually calls
  (`dataset`, `children`, `insertBefore`, `classList.contains`). If the stub
  grows past a screen, the page depends on a real DOM and the structural checks
  are the wrong tool for it.

## Make it a test, not a one-off

Wrap the file in a test so a regenerated artifact is checked automatically:

```js
import test from "node:test";
import { execFileSync } from "node:child_process";

test("the generated report verifies", () => {
  execFileSync(process.execPath, ["verify.mjs", "out/report.html"], { stdio: "pipe" });
});
```

`execFileSync` with `stdio: "pipe"` throws on a non-zero exit and hands you the
stderr in the error object, so the assertion message is the same one the CLI
printed. Regenerate before the check, or the test verifies last week's file.

## The three ways a page renders empty

1. **The script threw before the first render.** A missing element, a null from a
   selector, a `TypeError` on `undefined`. Group 6 catches it; a browser shows a
   blank region and logs the error.
2. **The data arrived empty and the renderer treats empty as "draw nothing".** No
   exception anywhere, so no console error — only the text floor and a row count
   assertion catch it. Compare the number of rows in the payload to the number of
   rows in the markup.
3. **The error was caught and logged.** A `try/catch` that writes to the console
   and returns. Group 6's console capture turns it into a failure; nothing else
   will.

## Where this goes wrong

- Verifying the template instead of the output. Run the check on the generated
  file, after the render step, every time.
- Passing a file with the "renders empty" case because the floor was set to 10
  characters to make an early run green. The floor is a claim about content.
- Treating "the script did not throw" as "the output is correct". It proves the
  page is alive, not that the numbers in it are the numbers you meant. Assert on
  at least one value that came from the data.
- Checking only the happy-viewport claims and then reporting the artifact as
  verified. Say what was checked and what was not; the list above is the honest
  boundary.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
