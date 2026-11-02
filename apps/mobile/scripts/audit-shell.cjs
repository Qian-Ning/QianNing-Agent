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
if (process.env.PI_MOBILE_AUDIT_PROFILE) app.setPath("userData", process.env.PI_MOBILE_AUDIT_PROFILE);
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");


const here = __dirname;
const root = path.resolve(here, "..", "public");
const WIDTHS = [320, 360, 390, 400];
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
  const actions = [...document.querySelectorAll(".ct-actions > *, .app-work-panel-toggle")].filter(visible).sort((a,b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
  const composer = document.querySelector(".composer-shell");
  const bar = document.querySelector(".composer-toolbar") || composer;
  /*
    The row's controls are the toolbar's own flex items. On a phone the two
    clusters flatten with display:contents, so the items are the cluster's
    children plus the toolbar's own children — not the buttons inside them: a
    button carries its own padding and reads a narrower and offset box than
    the slot the row actually spaces out.
  */
  const rowItems = (() => {
    if (!bar) return [];
    const out = [];
    for (const child of bar.children) {
      if (getComputedStyle(child).display === "contents") {
        for (const leaf of child.children) if (visible(leaf)) out.push(leaf);
      } else if (visible(child)) {
        out.push(child);
      }
    }
    return out;
  })();
// The context ring is an independent toolbar control and is counted below.
  const controls = bar
    ? (rowItems.length
        ? rowItems
        : [...bar.querySelectorAll("button, [role=button], .composer-chip, .composer-mode-chip, .context-inspector-trigger")]
            .filter(visible))

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
    contextBox: box(document.querySelector(".context-inspector-trigger")),
    rightBox: box(document.querySelector(".ct-right")),
    rightChildren: [...(document.querySelector(".ct-right")?.children ?? [])].map((element) => ({
      tag: element.tagName, className: String(element.className || "").slice(0, 40), ...box(element),
    })),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    topbar: box(document.querySelector(".ct-lead") ? document.querySelector(".ct-lead").parentElement : null),
    actions: actions.map((element) => ({ label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 12), ...box(element) })),
    // The reasoning level lives inside the model chip on a phone; if it is not
    // painted there, the row has no way to show it at all.
    reasoningLevel: (() => {
      const level = document.querySelector(".composer-reasoning-chip .composer-model-thinking-icon");
      if (!level) return null;
      const rect = level.getBoundingClientRect();
      return { text: (level.textContent || "").trim(), w: Math.round(rect.width), h: Math.round(rect.height) };
    })(),
    composer: box(composer),
    toolbarBox: box(document.querySelector(".composer-toolbar")),
    modelSeatBox: box(document.querySelector(".composer-model-anchor")),
    modelChipBox: box(document.querySelector(".composer-model-chip")),
    modelText: box(document.querySelector('.composer-model-thinking-model')),
    glyphs: controls.map(element => {
      const svg = [...element.querySelectorAll('svg')].find(visible);
      if (!svg) return null;
      const ink = svg.getBBox();
      const view = svg.viewBox.baseVal;
      const rect = svg.getBoundingClientRect();
      const host = element.getBoundingClientRect();
      // A glyph that spills outside its own control is clipped by the control's
      // padding or by a span with overflow hidden: the icon looks cut in half.
      const fit = rect.left >= host.left - 0.5 && rect.right <= host.right + 0.5
        && rect.top >= host.top - 0.5 && rect.bottom <= host.bottom + 0.5;
      return { className: String(element.className), w: ink.width / view.width * rect.width, h: ink.height / view.height * rect.height, fit };
    }).filter(Boolean),
    // A control that draws an icon and also prints a label puts the text on top
    // of the glyph: the row reads as smeared ink. Only the model chip carries
    // text on the phone, and it has no icon inside it.
    iconText: controls.map(element => {
      const svg = [...element.querySelectorAll('svg')].find(visible);
      if (!svg) return null;
      const shown = [...element.querySelectorAll('*')]
        .filter(el => el.children.length === 0 && (el.textContent || '').trim())
        .filter(el => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden'
            && Number(cs.opacity) > 0 && r.width > 0;
        });
      if (shown.length === 0) return null;
      return { className: String(element.className).slice(0, 40),
        text: shown.map(el => (el.textContent || '').trim()).join('|').slice(0, 20) };
    }).filter(Boolean),
    barScroll: bar ? { client: bar.clientWidth, scroll: bar.scrollWidth } : null,
    toolbarStyle: bar ? {
      display: getComputedStyle(bar).display,
      flexWrap: getComputedStyle(bar).flexWrap,
    } : null,
    controls: controls.map((element) => ({
      label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 14),
      className: String(element.className || "").slice(0, 60),
      aria: element.getAttribute("aria-label") || "",
      background: getComputedStyle(element).backgroundColor,
      borderWidth: getComputedStyle(element).borderWidth,
      shadow: getComputedStyle(element).boxShadow,
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
    for (let index = 1; index < actions.length; index += 1) {
      const gap = actions[index].x - actions[index - 1].right;
      if (Math.abs(gap - 2) > 2) {
        push("action-gap", `${gap}px between ${actions[index - 1].label || "·"} and ${actions[index].label || "·"}`);
      }
    }
    const last = actions[actions.length - 1];
    const pageEdge = (measured.viewport?.w ?? width) - 12;
    if (Math.abs(last.right - pageEdge) > 2) {
      push("action-edge", `last action right=${last.right}, page edge=${pageEdge}`);
    }
    if (first.y < 0) push("action-offscreen", `${first.y}`);
  }
  // The bar's own 12px padding is the page margin; `action-edge` above pins
  // the last button to it, so no separate slack check is needed.
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
  if (controls.length !== 7) push("control-count", `${controls.length} != 7`);
  if (controls.some((c) => /voice|mic/i.test(c.className))) push("mobile-voice", "voice control rendered");
  // The model name's readable width lives on its anchor, the seat that holds
  // the chip: the chip itself is the inner box and is narrower by its own
  // padding. Measuring the chip made a 70px contract look like a 56px one.
  const model = measured.modelSeatBox
    ? { ...measured.modelSeatBox, className: "composer-model-anchor" }
    : controls.find((c) => c.className.includes("composer-model-chip"));
  // The row items are the seats the toolbar spaces out: the context trigger
  // sits in its own seat and the reasoning control in another.
  const context = controls.find((c) => /context-inspector/.test(c.className));
  const reasoningChip = controls.find((c) => /composer-reasoning-(chip|anchor)/.test(c.className));
  if (reasoningChip && (reasoningChip.background !== 'rgba(0, 0, 0, 0)' || reasoningChip.borderWidth !== '0px' || reasoningChip.shadow !== 'none')) push('reasoning-decoration', JSON.stringify(reasoningChip));
  if (!model) {
    push("model-unreadable", JSON.stringify(model));
  } else {
    /*
      A 320px phone cannot give the model name 70px and still fit the six icons
      around it, so the tightest layout ships a 56px floor and ellipses the
      rest. From 360px up the name keeps the full readable width.
    */
    const floor = width <= 359 ? 56 : 70;
    if (model.w < floor) push("model-unreadable", JSON.stringify(model));
  }
  if (model && measured.modelText && Math.abs(model.x + model.w / 2 - measured.modelText.x - measured.modelText.w / 2) > 1) push('model-text-center', JSON.stringify(measured.modelText));
  // The gap is measured from the chip's own right edge: the anchor is a wider
  // seat around it, and the seat's edge is not what the eye reads as the gap.
  // The row's own gap is the budget, so a gap equal to it is correct.
  const modelChipBox = measured.modelChipBox;
  if (modelChipBox && reasoningChip && (reasoningChip.x - modelChipBox.right < 1 || reasoningChip.x - modelChipBox.right > 6)) push('model-reasoning-gap', `${reasoningChip.x - modelChipBox.right}`);
  const sortedControls = [...controls].sort((a, b) => a.x - b.x);
  if (measured.composer && sortedControls.length) {
    /*
      The row's own inset is the toolbar's padding: the first control's edge and
      the last control's edge are measured against the toolbar box, not against
      the wider composer card that wraps it. Measuring against the card mixed
      the card's own margins into the row's inset and reported a lopsided 14/6.
    */
    const row = measured.toolbarBox ?? measured.composer;
    const left = sortedControls[0].x - row.x;
    const right = row.right - sortedControls.at(-1).right;
    if (left < 12 || right < 12 || Math.abs(left - right) > 1) push('composer-edge-inset', `${left}/${right}`);
    measured.composerInsets = { left, right };
  }
  for (const glyph of measured.glyphs ?? []) {
    if (/composer-mode-chip|mode-chip/.test(glyph.className) && Math.max(glyph.w, glyph.h) < 14) push('glyph-ink', JSON.stringify(glyph));
    if (glyph.fit === false) push('glyph-clipped', JSON.stringify({ c: glyph.className, w: Math.round(glyph.w), h: Math.round(glyph.h) }));
  }
  for (const over of measured.iconText ?? []) {
    if (/composer-model-chip/.test(over.className)) continue;
    push('icon-text-overlap', JSON.stringify(over));
  }
  const toolbarStyle = measured.toolbarStyle;
  if (toolbarStyle && (toolbarStyle.display !== "flex" || toolbarStyle.flexWrap !== "nowrap")) {
    // Any layout that can move a control to a second line puts it under the
    // input card, where it reads as a floating button.
    push("toolbar-can-wrap", `${toolbarStyle.display}/${toolbarStyle.flexWrap}`);
  }
  if (controls.length > 1) {
    // A control that drops to a second row lands below the input and reads as
    // a floating button; no per-control size check can see that.
    const tops = controls.map((control) => control.y + control.h / 2);
    if (Math.max(...tops) - Math.min(...tops) > 2) push("toolbar-two-rows", tops.join("/"));
  }
  for (const control of controls) {
    if (measured.composer && (control.y + control.h > measured.composer.y + measured.composer.h + 2)) {
      push("control-below-composer", `${control.label} bottom=${control.y + control.h} card=${measured.composer.y + measured.composer.h}`);
    }
  }
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];
    if (control.className.includes("send-btn") || control.className.includes("stop-btn")) {
      if (control.w !== 28 || control.h !== 28) push("send-not-square", `${control.w}x${control.h}`);
    } else if (control.h < 32) push("control-squashed", `${control.label} h=${control.h}`);
    if (control.right > width + 1) push("control-clipped", `${control.label} right=${control.right}`);
    for (const other of controls.slice(index + 1)) {
      // Two controls sharing pixels is how a send button ends up on top of the
      // model name at 320, which no overflow check would ever report.
      if (overlaps(control, other)) push("control-overlap", `${control.label} / ${other.label}`);
    }
  }
  const labels = controls.map((control) => control.label);
  if (!labels.some((label) => /每次询问|权限/.test(label))) push("permission-missing", labels.join(" | "));
  if (!measured.contextBox || measured.contextBox.w < 20) {
    push("context-missing", JSON.stringify(measured.contextBox));
  }
  const reasoning = measured.reasoningLevel;
  if (!reasoning || reasoning.w < 10 || reasoning.h < 8) {
    push("reasoning-level-missing", reasoning ? `${reasoning.text} ${reasoning.w}x${reasoning.h}` : "no inline level");
  }

  return problems;
}

function control_(control) {
  return control;
}

function arrowRightOf(actions) {
  return actions.every((action, index) => index === 0 || action.x >= actions[index - 1].x);
}

async function run(port, width) {
  const win = new BrowserWindow({ width, height: HEIGHT, show: true, useContentSize: true, backgroundColor: "#f7f2ea" });
  const requests = [];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:/.test(details.url) && new URL(details.url).port !== String(port);
    if (remote) requests.push(details.url);
    callback({ cancel: remote });
  });
  // Load the way the installed app does: no `?surface=` parameter. The phone
  // bundle is served by Capacitor at its own origin with no query string, so
  // passing one here would let a missing surface detection pass the audit while
  // every mobile rule stayed inert on a real device.
  await win.loadURL(`http://127.0.0.1:${port}/shared/index.html`);
  const surface = await win.webContents.executeJavaScript(
    `document.documentElement.dataset.surface || ""`);
  if (surface !== "mobile") {
    throw new Error(`surface attribute is "${surface}", expected "mobile"`);
  }
  // A mobile-only declaration proves the mobile sheet is live, not just the
  // attribute: the row gap is 6px on the wider phones and 4px on the narrow
  // ones, while the desktop base is 8px. Either value means the phone sheet
  // won; 8px means it did not apply.
  const phoneGap = await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.composer-toolbar'); return el ? getComputedStyle(el).columnGap : ''; })()`);
  const expectedGap = width >= 380 ? "6px" : "4px";
  if (phoneGap !== expectedGap) {
    throw new Error(`mobile stylesheet not applied: composer gap ${phoneGap}, expected ${expectedGap}`);
  }
  const emptyTitle = await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('.ct-empty-title'); return el ? getComputedStyle(el).display : 'none'; })()`);
  if (emptyTitle !== 'none') throw new Error('mobile empty title visible');
  // Seed a configured phone. BrowserStore keeps values inside one JSON blob, so
  // the provider goes there; a top-level key is ignored and leaves the chip blank.
  await win.webContents.executeJavaScript(`
    const stamp = new Date().toISOString();
    const provider = {
      id: "p1", name: "Agnes", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x",
      apiStyle: "openai", models: ["agnes-3.0-flash", "agnes-3.0-pro"], defaultModelId: "agnes-3.0-flash",
      createdAt: stamp, updatedAt: stamp,
    };
    localStorage.setItem("qn.agent.values", JSON.stringify({
      "qn.local.providers": JSON.stringify([provider]),
      "qn.local.activeProvider": "p1",
      "qn.local.settings": JSON.stringify({ defaultPermissionMode: "ask", voice: { enabled: true } }),
      "qn.local.sessionConfig.s1": JSON.stringify({ mode: "agent", permissionMode: "ask", thinkingLevel: "medium", providerId: "p1", modelId: "agnes-3.0-flash" }),
    }));
    localStorage.setItem("qn.local.settings", JSON.stringify({ defaultPermissionMode: "ask", voice: { enabled: true } }));
    const session = { id: "s1", title: "布局探针", createdAt: stamp, updatedAt: stamp };
    localStorage.setItem("qn.agent.sessions", JSON.stringify([session]));
    localStorage.setItem("qn.agent.messages.s1", JSON.stringify([
      { itemId: "m1", role: "user", text: "在吗", status: "done", createdAt: stamp },
      { itemId: "m2", role: "assistant", text: "在。", status: "done", createdAt: stamp,
        usage: { inputTokens: 1500, outputTokens: 300, totalTokens: 1800 } },
    ]));
    true;
  `);
  const started = Date.now();
  win.reload();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await win.webContents.executeJavaScript(`(async () => {
    const opener = document.querySelector('.sidebar-toggle-btn') || [...document.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === '切换侧边栏');
    if (opener) opener.click();
    await new Promise(resolve => setTimeout(resolve, 200));
    /*
      The session list paints when the bridge answers, and a reload can be
      slower than the fixed wait that used to be enough. Poll for the seeded
      row instead of asserting on the first frame, and report what the store
      actually holds when it never arrives.
    */
    const deadline = Date.now() + 8000;
    let item = null;
    while (Date.now() < deadline) {
      item = document.querySelector('[data-sidebar-session-row="s1"]');
      if (item) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!item) {
      const sessions = localStorage.getItem('qn.agent.sessions');
      const rows = [...document.querySelectorAll('[data-sidebar-session-row]')].map(el => el.getAttribute('data-sidebar-session-row'));
      throw new Error('seeded session row missing; stored=' + String(sessions).slice(0, 120) + ' rendered=' + JSON.stringify(rows));
    }
    item.click();
    await new Promise(resolve => setTimeout(resolve, 400));
  })()`);
  const measured = await win.webContents.executeJavaScript(MEASURE);
  measured.localReadyMs = Date.now() - started;
  measured.interactions = await win.webContents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 250));
    const results = [];
    const read = async () => {
      const response = await window.piDesktop.invoke('pi-desktop/session/get', 's1');
      if (!response.ok) throw new Error('session read failed');
      return response.data.session;
    };
    document.querySelector('.composer-mode-chip').click(); await wait();
    if (document.querySelectorAll('[data-mode-choice]').length !== 3) throw new Error('mode choices missing');
    document.querySelector('[data-mode-choice="plan"]').click(); await wait();
    if ((await read()).mode !== 'plan') throw new Error('mode selection not persisted');
    if (document.querySelector('.composer-mode-chip').dataset.mode !== 'plan') throw new Error('mode UI not updated');
    if (document.querySelector('[data-mode-choice]')) throw new Error('mode menu stayed open');
    results.push('mode select/readback');
    for (const selector of ['.composer-permission button', '.composer-model-chip', '.composer-reasoning-chip', '.context-inspector-trigger']) {
      const trigger = document.querySelector(selector);
      if (!trigger) throw new Error('missing trigger ' + selector);
      trigger.click(); await wait();
      const menu = document.querySelector('[role="menu"], [role="dialog"]');
      if (!menu) throw new Error('menu did not open ' + selector);
      if (selector === '.composer-model-chip') {
        const choice = document.querySelector('.composer-model-option-select[title="agnes-3.0-pro"]');
        if (!choice) throw new Error('alternate model choice missing');
        choice.click(); await wait();
        if ((await read()).modelId !== 'agnes-3.0-pro') throw new Error('model selection not persisted');
        if (document.querySelector('.composer-model-chip')?.getAttribute('aria-expanded') !== 'false') throw new Error('model choice did not close menu');
      }
      if (selector === '.composer-reasoning-chip') {
        const choice = document.querySelector('[data-thinking-index="1"]');
        if (!choice) throw new Error('reasoning choices missing');
        choice.click(); await wait();
        if ((await read()).thinkingLevel === 'medium') throw new Error('reasoning not persisted: ' + JSON.stringify(await read()));
        if (document.querySelector('.composer-reasoning-chip')?.getAttribute('aria-expanded') !== 'false') throw new Error('reasoning choice did not close menu');
      }
      if (selector === '.composer-permission button') {
        const choice = document.querySelectorAll('[role="menuitemradio"]')[1];
        if (!choice) throw new Error('permission choices missing');
        choice.click(); await wait();
        if ((await read()).permissionMode === 'ask') throw new Error('permission not persisted');
      }
      results.push(selector);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait();
    }
    const config = await read();
    if (config.providerId !== 'p1' || config.modelId !== 'agnes-3.0-pro') throw new Error('model lost in partial update');
    return { results, config };
  })()`);
  win.reload();
  await new Promise(resolve => setTimeout(resolve, 900));
  const reopened = await win.webContents.executeJavaScript(`window.piDesktop.invoke('pi-desktop/session/get', 's1')`);
  for (const field of ['mode', 'permissionMode', 'thinkingLevel', 'providerId', 'modelId']) {
    if (reopened.data.session[field] !== measured.interactions.config[field]) throw new Error('configuration changed after reload: ' + field);
  }
  measured.remoteRequests = requests.length;
  if (requests.length) throw new Error('cache startup attempted remote requests: ' + requests.length);
  await win.webContents.executeJavaScript(`(async () => {
    const opener = [...document.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === '切换侧边栏');
    if (opener) opener.click();
    await new Promise(resolve => setTimeout(resolve, 200));
    document.querySelector('[data-sidebar-session-row="s1"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    if (document.querySelector('.composer-mode-chip')?.dataset.mode !== 'plan') throw new Error('reopened mode UI wrong');
  })()`);
  await win.webContents.executeJavaScript('document.activeElement?.blur(); true');
  const output = process.env.PI_MOBILE_AUDIT_ARTIFACTS;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `phone-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('.composer-model-chip').click(); true");
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(output, `phone-${width}-model-menu.png`), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); true");
  }
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
  if (process.env.PI_MOBILE_AUDIT_ARTIFACTS) fs.writeFileSync(path.join(process.env.PI_MOBILE_AUDIT_ARTIFACTS, 'audit-report.json'), JSON.stringify(report, null, 2));
  failures += problems.length;
  if (!raw) {
    console.log(`\n${width}×${measured.viewport.h}`);
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
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
