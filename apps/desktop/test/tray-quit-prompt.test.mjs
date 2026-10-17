/**
 * The tray's Quit item must run the app's quit confirmation, not `app.quit()`.
 *
 * `app.quit()` starts the ordinary quit, which closes the window, which runs the
 * window's close handler, which asks `askCloseBehavior` — Cancel / Minimize to
 * tray / Quit. That question is wrong for a user who just chose Quit: it is a
 * different question and it offers to undo their choice. These tests drive the
 * tray menu item's own click handler and hold the app's quit confirmation still,
 * so "asked first", "cancel keeps running" and "confirm quits once" are observed
 * on the real lifecycle wiring rather than read out of the source text.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The tray icon is looked up on disk before the Tray is built; give the app a
// resource root that has one so `createTray()` runs for real.
const appRoot = mkdtempSync(join(tmpdir(), "tray-quit-"));
mkdirSync(join(appRoot, "build"), { recursive: true });
writeFileSync(join(appRoot, "build", "icon.png"), "");
process.env.PI_TRAY_APP_PATH = appRoot;

// Electron is the external boundary. Everything under test — the lifecycle's
// tray menu, the click handler, the confirmation runtime — is the real code.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  /** Every app.quit() the code under test performs, in call order. */
  export const quitCalls = [];
  export const app = Object.assign(new EventEmitter(), {
    quit() { quitCalls.push("quit"); },
    getLocale: () => "en",
    isPackaged: false,
    getAppPath: () => process.env.PI_TRAY_APP_PATH,
    setBadgeCount: () => true,
    isReady: () => true,
  });
  export const dialog = {
    showMessageBox: async () => ({ response: 0 }),
  };
  export class BrowserWindow {
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }
  export const Menu = { buildFromTemplate: (template) => template };
  export class Tray extends EventEmitter {
    static instances = [];
    constructor() {
      super();
      this.menu = null;
      this.destroyed = false;
      Tray.instances.push(this);
    }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
    destroy() { this.destroyed = true; }
  }
  export const nativeImage = {
    createFromPath: () => ({
      isEmpty: () => false,
      resize: () => ({ isEmpty: () => false, setTemplateImage() {} }),
    }),
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({ isEmpty: () => true }),
  };
  export const nativeTheme = { themeSource: "system", shouldUseDarkColors: false };
  export const powerSaveBlocker = { start: () => 1, stop: () => {} };
  export const screen = {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 }),
    on() {},
  };
  export const ipcMain = { on() {}, handle() {}, removeHandler() {} };
  export const shell = { openExternal: async () => {}, showItemInFolder() {} };
  export const globalShortcut = { register: () => true, unregister() {} };
`)}`;

registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron"
      ? { url: electron, shortCircuit: true }
      : next(specifier, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { quitCalls, Tray, dialog } = await import("electron");
const { createApplicationLifecycle } = await import(
  "../electron/main/bootstrap/app-lifecycle.ts"
);
const { createCloseBehaviorRuntime } = await import(
  "../electron/main/bootstrap/close-behavior.ts"
);
const { catalogs } = await import("@pi-desktop/i18n");

const labels = catalogs.en.tray;

/** Let every already-queued microtask and immediate settle. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function fakeWindow({ visible = false, minimized = false } = {}) {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    show() {},
    focus() {},
    restore() {},
    hide() {},
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

/**
 * A real lifecycle with the app's confirmation replaced by a promise this test
 * settles by hand — the click handler must wait for that answer, and no test
 * here sleeps on a timer to find out whether it did.
 */
function trayHarness({ confirm, window: windowArg } = {}) {
  // The mock's quit log is process-wide; each harness starts from zero so the
  // counts below describe this click only.
  quitCalls.length = 0;
  const window = windowArg ?? fakeWindow();
  const state = {
    mainWindow: window,
    quitting: false,
    quitConfirmed: false,
    closePromptOpen: false,
    closeBehavior: "tray",
    tray: null,
    menuRendererReadyGate: null,
  };
  const windowsAllowedToClose = new WeakSet();
  const closeBehaviorCalls = [];
  const confirmCalls = [];
  let answer = null;
  const confirmTrayQuit = () => {
    confirmCalls.push("asked");
    if (confirm) return confirm();
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const lifecycle = createApplicationLifecycle({
    state,
    appState: {
      windowCreationPromise: null,
      applicationBooted: true,
      pendingApplicationMenuCommands: [],
      appliedMenuSettings: null,
    },
    appearanceState: {
      updaterLocale: "en",
      pluginPanelTheme: "dark",
      appThemePreference: "system",
      broadcastAppearanceSignature: "",
    },
    dataDir: appRoot,
    isDevelopmentBuild: false,
    windowsAllowedToClose,
    windowMinWidth: 940,
    windowMinHeight: 600,
    windowBoundsSettleMs: 0,
    workPanelNativeResizeSettleMs: 0,
    applyWorkPanelReservation: () => ({}),
    markWorkPanelChatResizeActive: () => {},
    workPanelMinimumWindowWidth: () => 940,
    observedWorkPanelBaseBounds: () => null,
    classifyDisplayTransition: () => "same",
    sendToRenderer: () => {},
    safeOpenExternal: async () => {},
    showPluginLauncher: async () => {},
    // The three-option Cancel / Minimize-to-tray / Quit question. Reaching it
    // from the tray item is the bug.
    askCloseBehavior: async (target) => {
      closeBehaviorCalls.push(target);
      return null;
    },
    confirmTrayQuit,
    applyCloseBehavior: () => {},
    browserHost: { dispose: () => {} },
    pluginViews: { dispose: () => {} },
    plugins: { getThemes: () => [], broadcastEvent: () => {} },
    logger: { app: () => {} },
    refreshReleaseNotes: () => {},
    applyPluginLauncherShortcut: () => {},
    applyToggleWindowShortcut: () => {},
    broadcastPluginPanelEvent: () => {},
    getHost: () => null,
    getRunningSessionIds: () => [],
  });
  lifecycle.createTray();
  const tray = Tray.instances.at(-1);
  const menu = tray.menu;
  if (!menu) throw new Error("the tray was created without a context menu");
  return {
    state,
    window,
    lifecycle,
    tray,
    menu,
    closeBehaviorCalls,
    confirmCalls,
    answer: (value) => answer?.(value),
    windowsAllowedToClose,
  };
}

/** The tray Quit item, found by label rather than by position. */
function trayQuitItem(menu) {
  const item = menu.find((entry) => entry.label === labels.quit);
  if (!item) throw new Error(`no tray item labelled ${JSON.stringify(labels.quit)}`);
  return item;
}

test("the tray Quit item asks the quit confirmation before anything quits", async () => {
  const harness = trayHarness();
  const quit = trayQuitItem(harness.menu);

  quit.click();
  await settled();

  assert.equal(harness.confirmCalls.length, 1, "the tray item must ask the quit confirmation");
  assert.equal(quitCalls.length, 0, "nothing may quit while the confirmation is unanswered");
  assert.equal(harness.closeBehaviorCalls.length, 0, "the close-behaviour question must not be reached");
});

test("cancelling the tray quit leaves the app running", async () => {
  const harness = trayHarness();
  const quit = trayQuitItem(harness.menu);

  quit.click();
  await settled();
  harness.answer(false);
  await settled();

  assert.equal(quitCalls.length, 0, "Cancel must not quit the app");
  assert.equal(harness.state.quitting, false);
  assert.equal(harness.state.quitConfirmed, false, "a cancelled quit must prompt again next time");

  // And it is not a one-shot latch: the same item can be used again.
  quit.click();
  await settled();
  assert.equal(harness.confirmCalls.length, 2, "a second click asks again");
  harness.answer(true);
  await settled();
  assert.equal(quitCalls.length, 1, "the confirmed retry quits");
});

test("confirming the tray quit calls app.quit exactly once", async () => {
  const harness = trayHarness();
  const quit = trayQuitItem(harness.menu);

  quit.click();
  await settled();
  harness.answer(true);
  await settled();

  assert.equal(quitCalls.length, 1, "a confirmed tray quit quits the app once");
  assert.equal(
    harness.confirmCalls.length,
    1,
    "app.quit() is the answer to the confirmation, not a substitute for it",
  );
});

test("the close-behaviour question is not reached on the tray quit path", async () => {
  // The window's close handler asks `askCloseBehavior` unless the window was
  // let go explicitly (`windowsAllowedToClose`) or the app is already quitting.
  // A confirmed tray quit must set both gates before `app.quit()`, because that
  // is what makes the ordinary quit flow skip the Cancel / Minimize / Quit
  // question — the user already answered a different one.
  const harness = trayHarness();
  const quit = trayQuitItem(harness.menu);

  quit.click();
  await settled();
  harness.answer(true);
  await settled();

  assert.equal(quitCalls.length, 1);
  assert.equal(harness.state.quitConfirmed, true, "the quit is already confirmed");
  assert.equal(
    harness.windowsAllowedToClose.has(harness.window),
    true,
    "the window is released, so its close handler cannot ask the close-behaviour question",
  );
  assert.equal(harness.closeBehaviorCalls.length, 0);
});

test("the tray quit confirmation is the native dialog, deliberately", async (t) => {
  // The window is hidden in the tray, so the renderer cannot draw the question
  // and `askRenderer` would have to time out before the same native dialog
  // appeared. `confirmTrayQuit` therefore takes the native dialog on purpose —
  // even for a window that *could* draw it, which is the case below. If it went
  // back through `confirmQuitDialog()`'s auto surface, the promise would stay
  // pending here (the renderer is asked and never answers) and this fails.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = fakeWindow({ visible: true, minimized: false });
  const runtime = createCloseBehaviorRuntime({
    state: { mainWindow: window, closeBehavior: "ask" },
    dataDir: appRoot,
    getLocale: () => "en",
    createTray: () => {},
  });

  const shown = [];
  const original = dialog.showMessageBox;
  dialog.showMessageBox = async (...args) => {
    shown.push(args);
    return { response: 1 };
  };
  try {
    const answer = await Promise.race([
      runtime.confirmTrayQuit().then((value) => ({ value })),
      settled().then(() => ({ pending: true })),
    ]);

    assert.deepEqual(answer, { value: true }, "the native dialog answers without waiting on the renderer");
    assert.equal(window.sent.length, 0, "the renderer is never asked to draw a tray quit");
    assert.equal(shown.length, 1);
    const [parent, options] = shown[0].length === 2
      ? shown[0]
      : [undefined, shown[0][0]];
    assert.equal(parent, window, "the dialog is parented to the main window");
    assert.equal(options.title, labels.confirmQuitTitle);
    assert.equal(options.detail, labels.confirmQuitBody);
    assert.deepEqual(options.buttons, [catalogs.en.common.cancel, labels.confirmQuit]);
    assert.equal(options.defaultId, 0, "Cancel is the default: an accidental Enter keeps the app");
  } finally {
    dialog.showMessageBox = original;
  }
});

test("the tray Quit item is not wired straight to app.quit", async () => {
  // The regression this file exists for: `click: () => app.quit()` bypasses the
  // confirmation entirely. Clicking it must reach the confirmation first.
  const harness = trayHarness();
  trayQuitItem(harness.menu).click();
  await settled();
  assert.equal(harness.confirmCalls.length, 1);
  assert.equal(quitCalls.length, 0);
});

test.after(() => {
  rmSync(appRoot, { recursive: true, force: true });
});
