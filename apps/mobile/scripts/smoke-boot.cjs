// Boots the phone bridge in a bare DOM and fails if `window.piDesktop` never
// appears.
//
// Why this exists: a module-level crash in the bridge bundle is invisible from
// the outside — the renderer still mounts, and the only symptom is
// "piDesktop preload bridge unavailable" on every screen. That happened once
// with `import.meta.glob`, which Vite resolves and esbuild does not.
//
//   node scripts/smoke-boot.cjs
//
// Run it after `pnpm build:shared`; it loads the produced `bridge-boot.js`.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const bundle = path.join(__dirname, "..", "public", "shared", "bridge-boot.js");
if (!fs.existsSync(bundle)) {
  console.error(`[smoke] missing ${bundle} — run pnpm build:shared first`);
  process.exit(1);
}

const code = fs.readFileSync(bundle, "utf8");
const dom = new JSDOM("<!doctype html><div id=root></div>", {
  url: "http://localhost/index.html?surface=mobile",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const w = dom.window;

// The few browser APIs a WebView has and jsdom does not. They are stubs: the
// point is to reach the end of boot, not to make a network call.
w.matchMedia =
  w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
w.Response =
  w.Response ||
  class Response {
    constructor(body, init) {
      this.body = body;
      this.status = (init && init.status) || 200;
    }
  };
w.Headers = w.Headers || class Headers { get() { return null; } };
w.Request = w.Request || class Request {};
w.fetch = w.fetch || (async () => new w.Response("{}", { status: 500 }));

try {
  w.eval(code);
} catch (error) {
  console.error("[smoke] the bridge threw while loading:", error && error.message);
  console.error(String((error && error.stack) || "").split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}

if (typeof w.piDesktop?.invoke !== "function") {
  console.error("[smoke] window.piDesktop was not installed");
  process.exit(1);
}

// One round-trip proves the object is not just present but wired.
w.piDesktop
  .invoke("session/list")
  .then((result) => {
    if (!result || result.ok !== true) {
      console.error("[smoke] session/list answered", JSON.stringify(result));
      process.exit(1);
    }
    console.log("[smoke] bridge booted; session/list ok");
  })
  .catch((error) => {
    console.error("[smoke] session/list threw:", error && error.message);
    process.exit(1);
  });
