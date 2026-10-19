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
  const window = {
    sent,
    visible,
    minimized,
    showed: 0,
    focused: 0,
    isDestroyed: () => false,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    show() {
      window.visible = true;
      window.showed += 1;
    },
    focus() {
      window.focused += 1;
    },
    restore() {
      window.minimized = false;
      window.visible = true;
    },
    hide() {
      window.visible = false;
    },
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  return window;
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

/**
 * The tray item wired to the real confirmation runtime, so the assertions
 * describe the app's menu → runtime → renderer path rather than a stub.
 */
function realConfirmationHarness({ window = fakeWindow({ visible: false }) } = {}) {
  const runtime = createCloseBehaviorRuntime({
    state: { mainWindow: window, closeBehavior: "tray" },
    dataDir: appRoot,
    getLocale: () => "en",
    createTray: () => {},
  });
  const harness = trayHarness({ window, confirm: () => runtime.confirmTrayQuit() });
  return { ...harness, runtime };
}

const QUIT_PROMPT_CHANNEL = "pi-desktop/app/event/quitPrompt";

/** Record every native message box, so "never asked" is observable. */
async function withoutNativeDialog(run) {
  const shown = [];
  const original = dialog.showMessageBox;
  dialog.showMessageBox = async (...args) => {
    shown.push(args);
    return { response: 1 };
  };
  try {
    return await run(shown);
  } finally {
    dialog.showMessageBox = original;
  }
}

test("the tray Quit item draws the app's card, restoring a hidden window", async () => {
  // This is the path that used to opt out on purpose: the window is hidden in
  // the tray, so the card could not be seen. It is restored instead, and the
  // OS dialog is never asked — asserted on the real menu wiring.
  const harness = realConfirmationHarness();
  const { window, runtime, menu } = harness;
  assert.equal(window.isVisible(), false);

  await withoutNativeDialog(async (shown) => {
    trayQuitItem(menu).click();
    await settled();

    assert.equal(shown.length, 0, "the tray quit must not raise the native dialog");
    assert.equal(window.isVisible(), true, "the window is restored so the card can be seen");
    assert.equal(window.focused > 0, true, "the restored window takes the keystrokes");
    assert.equal(window.sent.length, 1, "the renderer is asked exactly once");
    assert.equal(window.sent[0].channel, QUIT_PROMPT_CHANNEL);
    assert.equal(window.sent[0].payload.kind, "quit");
    assert.equal(quitCalls.length, 0, "nothing quits before the card is answered");

    runtime.answerQuitPrompt(window.sent[0].payload.requestId, "quit");
    await settled();
  });

  assert.equal(quitCalls.length, 1, "confirming the card quits the app once");
  assert.equal(harness.state.quitConfirmed, true);
});

test("cancelling the tray card leaves the restored window open and usable", async () => {
  const harness = realConfirmationHarness();
  const { window, runtime, menu } = harness;

  await withoutNativeDialog(async (shown) => {
    trayQuitItem(menu).click();
    await settled();
    runtime.answerQuitPrompt(window.sent[0].payload.requestId, "cancel");
    await settled();
    assert.equal(shown.length, 0);
  });

  assert.equal(quitCalls.length, 0, "Cancel must not quit");
  assert.equal(harness.state.quitConfirmed, false, "a cancelled quit asks again next time");
  // The window was shown for the question and stays shown: re-hiding it would
  // leave the user with an app that looks closed while it is running.
  assert.equal(window.isVisible(), true, "cancel leaves the app usable on screen");

  trayQuitItem(menu).click();
  await settled();
  assert.equal(window.sent.length, 2, "the next tray quit asks a fresh question");
  assert.notEqual(
    window.sent[1].payload.requestId,
    window.sent[0].payload.requestId,
    "one request id per question",
  );
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
