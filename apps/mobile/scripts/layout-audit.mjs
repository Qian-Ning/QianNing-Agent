// Layout audit for the phone build.
//
// Renders the shipped bundle at several widths and font scales, walks every
// screen, and fails on the four things that actually break a phone layout:
// horizontal scroll, text that overflows without an ellipsis, touch targets
// under 40px, and a screen that renders nothing.
//
// Run after `pnpm --filter @pi-desktop/mobile build`:
//   node apps/mobile/scripts/layout-audit.mjs
//
// Screenshots are written to $TMPDIR/mobile-layout-audit for eyeballing; the
// exit code is the gate.

import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");
const outDir = path.join(os.tmpdir(), "mobile-layout-audit");

const WIDTHS = [320, 360, 392, 430];
const FONTS = ["1", "1.3"];
const HEIGHT = 780;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/**
 * file:// works for the first load and then fails on reload with ERR_FAILED, so
 * the audit serves the bundle the way Capacitor does: over http.
 */
function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.join(distDir, decodeURIComponent(relative));
    if (!target.startsWith(distDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
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

const MEASURE = `(() => {
  const doc = document.documentElement;
  const problems = [];
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push({ kind: "doc-overflow", detail: doc.scrollWidth + ">" + doc.clientWidth });
  }
  const visible = (el) => el.getClientRects().length > 0;
  for (const el of document.querySelectorAll(".screen *")) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== "ellipsis" && style.overflowX !== "hidden") {
      const label = (el.className && typeof el.className === "string" ? el.className : el.tagName).slice(0, 40);
      // Name the widest child: a container overflow is always some child's fault.
      let widest = "";
      for (const child of el.children) {
        if (child.scrollWidth > el.clientWidth - 8) {
          widest += " [" + child.tagName + "." + String(child.className).slice(0, 24) + " " + child.scrollWidth + "]";
        }
      }
      problems.push({ kind: "text-overflow", detail: label + " " + el.scrollWidth + ">" + el.clientWidth + widest.slice(0, 80) });
    }
  }
  for (const el of document.querySelectorAll("button, a, input, textarea, [role=button]")) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 40 || rect.width < 40) {
      const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24);
      problems.push({ kind: "target", detail: label + " " + Math.round(rect.width) + "x" + Math.round(rect.height) });
    }
  }
  return problems;
})()`;

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
}

async function clickText(win, text) {
  return win.webContents.executeJavaScript(
    `(() => {
      const el = [...document.querySelectorAll("button, .row")].find((b) => (b.textContent || "").trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
}

async function clickSelector(win, selector) {
  return win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  );
}

async function measure(win, failures, context) {
  const problems = await win.webContents.executeJavaScript(MEASURE);
  for (const problem of problems) failures.push({ ...context, ...problem });
  const text = await win.webContents.executeJavaScript("document.body.innerText");
  if (text.trim().length < 10) failures.push({ ...context, kind: "blank", detail: `${text.trim().length} chars` });
}

async function runCombination(width, font, failures, url) {
  const win = new BrowserWindow({ width, height: HEIGHT, show: true });
  await win.loadURL(url);
  await sleep(600);
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem("qn.host", "local");
    localStorage.setItem("qn.local.provider", JSON.stringify({
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiKey: "sk-layout-audit-not-a-key",
      modelId: "agnes-3.0-flash"
    }));
    true;
  `);
  await win.webContents.reload();
  await sleep(900);
  await win.webContents.executeJavaScript(
    `document.documentElement.style.setProperty("--font-scale", ${JSON.stringify(font)}); true`,
  );
  await sleep(200);

  const tag = `${width}@${font}`;

  // Sessions (empty state on a fresh store).
  await measure(win, failures, { screen: "sessions", tag });
  await shoot(win, `sessions-${tag}`);

  // A conversation, then the drawer over it.
  await clickText(win, "新建会话");
  await sleep(700);
  await measure(win, failures, { screen: "chat", tag });
  await shoot(win, `chat-${tag}`);

  await clickSelector(win, ".bar .ghost");
  await sleep(500);
  await measure(win, failures, { screen: "drawer", tag });
  await shoot(win, `drawer-${tag}`);
  await clickSelector(win, ".drawer-backdrop");
  await sleep(300);

  // Settings and every page under it.
  await win.webContents.executeJavaScript(`history.length; true`);
  await clickSelector(win, ".bar .ghost");
  await sleep(400);
  // The gear is an icon with an accessible name, not the word 设置.
  await clickSelector(win, '[aria-label="设置"]');
  await sleep(500);
  for (const [label, name] of [
    ["通用", "settings-general"],
    ["模型", "settings-model"],
    ["外观与皮肤", "settings-appearance"],
    ["通知", "settings-notifications"],
    ["定时任务", "settings-schedules"],
    ["连接", "settings-connection"],
    ["远程访问", "settings-remote"],
    ["用量", "settings-usage"],
    ["关于", "settings-about"],
  ]) {
    const opened = await clickText(win, label);
    await sleep(400);
    if (opened) {
      await measure(win, failures, { screen: name, tag });
      await shoot(win, `${name}-${tag}`);
      await clickSelector(win, '[aria-label="返回"]');
      await sleep(250);
    }
  }

  win.destroy();
}

// Every combination closes its own window; without this Electron quits after
// the first one and the audit silently reports a single row.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const url = `http://127.0.0.1:${port}/index.html`;
  const failures = [];
  for (const width of WIDTHS) {
    for (const font of FONTS) {
      try {
        await runCombination(width, font, failures, url);
      } catch (cause) {
        failures.push({ screen: "load", tag: `${width}@${font}`, kind: "crash", detail: String(cause).slice(0, 120) });
      }
      const seen = failures.filter((f) => f.tag === `${width}@${font}`).length;
      console.log(`${width}@${font}: ${seen === 0 ? "ok" : seen + " problem(s)"}`);
    }
  }

  if (failures.length === 0) {
    console.log(`\nlayout audit clean — screenshots in ${outDir}`);
    app.exit(0);
    return;
  }

  console.log(`\n${failures.length} problem(s):`);
  for (const failure of failures) {
    console.log(`  [${failure.screen} ${failure.tag}] ${failure.kind}: ${failure.detail}`);
  }
  console.log(`\nscreenshots in ${outDir}`);
  app.exit(1);
});
