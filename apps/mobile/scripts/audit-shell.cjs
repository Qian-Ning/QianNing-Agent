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
  const topbar = document.querySelector(".conversation-topbar, .ct-bar, .ct-root, header.ct") ||
    document.querySelector(".ct-actions")?.closest("header, .ct, .conversation-topbar");
  return {
    topbarButtons: topbar
      ? [...topbar.querySelectorAll("button, [role=button]")].filter(visible).map((element) => ({
          label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 14),
          ...box(element),
        }))
      : [],
    barBox: box(document.querySelector(".conversation-topbar")),
    actionsBox: box(document.querySelector(".ct-actions")),
    rightBox: box(document.querySelector(".ct-right")),
    rightChildren: [...(document.querySelector(".ct-right")?.children ?? [])].map((element) => ({
      tag: element.tagName, className: String(element.className || "").slice(0, 40), ...box(element),
    })),
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


const MEASURE_SETTINGS = String.raw`
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const box = (element) => {
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
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const snapshot = () => ({
    view: document.querySelector(".settings-shell")?.getAttribute("data-settings-view") || "",
    heading: (document.querySelector(".settings-content h2, .settings-page-header h2, .settings-content h1")?.textContent || "").trim(),
    cards: [...document.querySelectorAll(".settings-card-heading, .settings-card > h3, .settings-card-block > h3")]
      .filter(visible).map((element) => (element.textContent || "").trim()).filter(Boolean),
    segments: [...document.querySelectorAll(".settings-segment")].filter(visible).map((segment) => ({
      label: segment.getAttribute("aria-label") || "",
      ...box(segment),
      items: [...segment.children].filter(visible).map((item) => ({
        text: (item.textContent || "").trim(),
        ...box(item),
        scrollW: item.scrollWidth,
        clientW: item.clientWidth,
      })),
    })),
  });
  // On the phone the sidebar is a drawer: its buttons are inert until it opens.
  const opener = [...document.querySelectorAll("[aria-label]")]
    .find((element) => element.getAttribute("aria-label") === "切换侧边栏");
  if (opener) {
    opener.click();
    await wait(500);
  }
  const trigger = document.querySelector('[data-nav="settings"]')
    || [...document.querySelectorAll("[aria-label]")]
      .find((element) => element.getAttribute("aria-label") === "设置");
  if (!trigger) {
    return { reached: false, labels: [...document.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label")).slice(0, 40) };
  }
  trigger.click();
  await wait(800);
  const labels = [...document.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label")).slice(0, 60);
  const pages = [snapshot()];
  for (const name of ["AI", "常规"]) {
    // The phone's settings is a list that opens one destination at a time, so
    // reaching the second one means going back to the list first.
    if (document.querySelector('.settings-shell[data-settings-view="content"]') && typeof window.__qianningSettingsBack === "function") {
      window.__qianningSettingsBack();
      await wait(500);
    }
    const item = [...document.querySelectorAll(".settings-nav-item, .settings-nav-row, [data-settings-destination]")]
      .find((candidate) => (candidate.textContent || "").includes(name));
    if (!item) continue;
    item.click();
    await wait(600);
    const next = snapshot();
    if (!pages.some((page) => page.view === next.view && page.cards.join() === next.cards.join())) pages.push(next);
  }
  return {
    reached: true,
    labels,
    navItems: [...document.querySelectorAll(".settings-nav-item")].map((element) => (element.textContent || "").trim()).slice(0, 30),
    viewAttr: document.querySelector(".settings-shell")?.getAttribute("data-settings-view") ?? null,
    pages,
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
  if (measured.actionsBox && measured.barBox) {
    // A cluster that stops short of the bar's padding reads as a misaligned row
    // even when every button in it is the same size.
    const slack = measured.barBox.right - measured.actionsBox.right;
    if (slack > 18) push("actions-not-flush", `${slack}px from the right edge`);
  }
  if (measured.barScroll && measured.barScroll.scroll > measured.barScroll.client + 1) {
    push("toolbar-overflow", `${measured.barScroll.scroll} > ${measured.barScroll.client}`);
  }
  // A settings control that wraps per character is not "narrow", it is broken:
  // 智能体 becomes a three-line column. Height is the tell, width is the cause.
  for (const page of measured.settings?.pages ?? []) {
    for (const segment of page.segments) {
      for (const item of segment.items) {
        if (item.h > 48) push("segment-wrapped", `${segment.label}: ${item.text} ${item.w}x${item.h}`);
        else if (item.scrollW > item.clientW + 1) push("segment-clipped", `${segment.label}: ${item.text}`);
      }
      if (segment.right > width + 1) push("segment-overflow", `${segment.label} right=${segment.right}`);
    }
    for (const card of page.cards) {
      // Computer control drives the desktop's mouse and keyboard; there is no
      // such target on a phone, so the card is noise there.
      if (card === "电脑操作" || card === "Computer control") push("desktop-only-card", card);
    }
  }
  const controls = measured.controls;
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];
    if (control.h < 32) push("control-squashed", `${control.label} h=${control.h}`);
    if (control.right > width + 1) push("control-clipped", `${control.label} right=${control.right}`);
    for (const other of controls.slice(index + 1)) {
      // Two controls sharing pixels is how a send button ends up on top of the
      // model name at 320, which no overflow check would ever report.
      if (overlaps(control, other)) push("control-overlap", `${control.label} / ${other.label}`);
    }
  }
  return problems;
}

function arrowRightOf(actions) {
  return actions.every((action, index) => index === 0 || action.x >= actions[index - 1].x);
}

async function run(port, width) {
  const win = new BrowserWindow({ width, height: HEIGHT, show: false, backgroundColor: "#f7f2ea" });
  await win.loadURL(`http://127.0.0.1:${port}/shared/index.html?surface=mobile`);
  // Seed a configured phone. BrowserStore keeps values inside one JSON blob, so
  // the provider goes there; a top-level key is ignored and leaves the chip blank.
  await win.webContents.executeJavaScript(`
    const stamp = new Date().toISOString();
    const provider = {
      id: "p1", name: "Agnes", baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "x",
      apiStyle: "openai", models: ["agnes-3.0-flash"], defaultModelId: "agnes-3.0-flash",
      createdAt: stamp, updatedAt: stamp,
    };
    localStorage.setItem("qn.agent.values", JSON.stringify({
      "qn.local.providers": JSON.stringify([provider]),
      "qn.local.activeProvider": "p1",
    }));
    localStorage.setItem("qn.local.settings", JSON.stringify({ defaultPermissionMode: "ask" }));
    true;
  `);
  await win.webContents.reload();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const measured = await win.webContents.executeJavaScript(MEASURE);
  measured.settings = await win.webContents.executeJavaScript(MEASURE_SETTINGS);
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
    const pages = measured.settings?.pages ?? [];
    console.log(`  settings  ${measured.settings?.reached ? pages.map((page) => `${page.view}:${page.cards.length} cards/${page.segments.length} segments`).join("  ") : "unreachable"}`);
    for (const problem of problems) console.log(`  FAIL ${problem.kind}: ${problem.detail}`);
  }
}

if (raw) console.log(JSON.stringify(report, null, 2));
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
server.close();
app.exit(failures === 0 ? 0 : 1);
})();
