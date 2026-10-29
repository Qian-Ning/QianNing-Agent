// Geometry gate for the phone shell.
//
// The phone renders the desktop shell with `data-surface="mobile"`. Every layout
// regression so far was a number nobody measured: two icon buttons a pixel apart,
// a composer row wider than the screen, a settings row that wrapped. This script
// loads the real bundle at three widths and reports those numbers, then fails on
// them.
//
//   node apps/mobile/scripts/audit-shell.mjs            # gate
//   node apps/mobile/scripts/audit-shell.mjs --json     # raw measurements
//
// It serves `apps/mobile/public` the way Capacitor does, because file:// fails on
// reload.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");


const here = __dirname;
const root = path.resolve(here, "..", "public");
const WIDTHS = [320, 360, 390];
const HEIGHT = 844;
const MIN_TARGET = 40;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "/shared/index.html" : url.pathname;
    const target = path.join(root, decodeURIComponent(relative));
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    fs.createReadStream(target).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const MEASURE = String.raw`
(() => {
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      right: Math.round(rect.right),
    };
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const actions = [...document.querySelectorAll(".ct-actions > *")].filter(visible);
  const composer = document.querySelector(".composer");
  const bar = document.querySelector(".composer-toolbar") || composer;
  const controls = bar
    ? [...bar.querySelectorAll("button, [role=button], .composer-chip, .composer-mode-chip")].filter(visible)
    : [];
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    topbar: box(document.querySelector(".ct-lead") ? document.querySelector(".ct-lead").parentElement : null),
    actions: actions.map((element) => ({ label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 12), ...box(element) })),
    composer: box(composer),
    barScroll: bar ? { client: bar.clientWidth, scroll: bar.scrollWidth } : null,
    controls: controls.map((element) => ({
      label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 14),
      className: String(element.className || "").slice(0, 60),
      aria: element.getAttribute("aria-label") || "",
      ...box(element),
    })),
  };
})()
`;

function overlaps(a, b) {
  return a.x < b.right && b.x < a.right && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inspect(measured, width) {
  const problems = [];
  const push = (kind, detail) => problems.push({ width, kind, detail });
  if (measured.scrollWidth > measured.viewport.w + 1) {
    push("horizontal-scroll", `${measured.scrollWidth} > ${measured.viewport.w}`);
  }
  const actions = measured.actions;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.h < MIN_TARGET || action.w < MIN_TARGET) {
      push("small-target", `${action.label || "icon"} ${action.w}x${action.h}`);
    }
    for (const other of actions.slice(index + 1)) {
      if (overlaps(action, other)) push("overlap", `${action.label || "icon"} / ${other.label || "icon"}`);
    }
  }
  if (actions.length > 1) {
    const first = actions[0];
    const heights = new Set(actions.map((action) => action.h));
    const centers = actions.map((action) => action.y + action.h / 2);
    if (heights.size > 1) push("action-heights", [...heights].join(" / "));
    if (Math.max(...centers) - Math.min(...centers) > 2) push("action-baseline", centers.join(" / "));
    if (arrowRightOf(actions) === false) push("action-order", "actions are not laid out left to right");
    if (first.y < 0) push("action-offscreen", `${first.y}`);
  }
  if (measured.barScroll && measured.barScroll.scroll > measured.barScroll.client + 1) {
    push("toolbar-overflow", `${measured.barScroll.scroll} > ${measured.barScroll.client}`);
  }
  for (const control of measured.controls) {
    if (control.h < 32) push("control-squashed", `${control.label} h=${control.h}`);
    if (control.right > width + 1) push("control-clipped", `${control.label} right=${control.right}`);
  }
  return problems;
}

function arrowRightOf(actions) {
  return actions.every((action, index) => index === 0 || action.x >= actions[index - 1].x);
}

async function run(port, width) {
  const win = new BrowserWindow({ width, height: HEIGHT, show: false, backgroundColor: "#f7f2ea" });
  await win.loadURL(`http://127.0.0.1:${port}/shared/index.html?surface=mobile`);
  // Seed a configured phone: an empty profile hides the model label, which is
  // exactly the case that collapses the chip, so measure the real one.
  await win.webContents.executeJavaScript(`
    const stamp = new Date().toISOString();
    localStorage.setItem("qn.local.providers", JSON.stringify([{
      id: "p1", name: "Agnes", baseUrl: "https://example.invalid/v1", apiKey: "x",
      apiStyle: "openai", models: ["agnes-3.0-flash"], defaultModelId: "agnes-3.0-flash",
      createdAt: stamp, updatedAt: stamp
    }]));
    localStorage.setItem("qn.local.activeProvider", "p1");
    localStorage.setItem("qn.local.settings", JSON.stringify({ defaultPermissionMode: "ask" }));
    true;
  `);
  await win.webContents.reload();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const measured = await win.webContents.executeJavaScript(MEASURE);
  win.destroy();
  return measured;
}

// Electron quits when the last window closes; this script closes one per width.
app.on("window-all-closed", () => {});

(async () => {
await app.whenReady();
const { server, port } = await serve();
const raw = process.argv.includes("--json");
const report = [];
let failures = 0;

for (const width of WIDTHS) {
  const measured = await run(port, width);
  const problems = inspect(measured, width);
  report.push({ width, measured, problems });
  failures += problems.length;
  if (!raw) {
    console.log(`\n${width}×${HEIGHT}`);
    console.log(`  actions   ${measured.actions.map((action) => `${action.label || "·"} ${action.w}x${action.h}@${action.x}`).join("  ")}`);
    console.log(`  controls  ${measured.controls.map((control) => `${control.label || "·"} ${control.w}x${control.h}`).join("  ")}`);
    console.log(`  toolbar   ${measured.barScroll ? `${measured.barScroll.scroll}/${measured.barScroll.client}` : "n/a"}`);
    for (const problem of problems) console.log(`  FAIL ${problem.kind}: ${problem.detail}`);
  }
}

if (raw) console.log(JSON.stringify(report, null, 2));
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
server.close();
app.exit(failures === 0 ? 0 : 1);
})();
