/**
 * The quit confirmation is the app's own card on every path.
 *
 * These tests drive `createCloseBehaviorRuntime` itself with a fake window and
 * a recording `dialog.showMessageBox`, so the four answers a user can give —
 * cancel, confirm, never answer (timeout), and no renderer to answer at all —
 * are observed on the real runtime rather than read out of the source text.
 */
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const electron = `data:text/javascript,${encodeURIComponent(`
  /** Every native message box the runtime raises, in call order. */
  export const dialogCalls = [];
  export const dialog = {
    nativeResponse: 0,
    showMessageBox: async (...args) => {
      dialogCalls.push(args);
      return { response: dialog.nativeResponse };
    },
  };
  export const app = { focus() {}, getLocale: () => "en", quit() {} };
  export class BrowserWindow {}
`)}`;

registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron"
      ? { url: electron, shortCircuit: true }
      : next(specifier, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { dialogCalls, dialog } = await import("electron");
const { createCloseBehaviorRuntime } = await import(
  "../electron/main/bootstrap/close-behavior.ts"
);

const QUIT_PROMPT_CHANNEL = "pi-desktop/app/event/quitPrompt";

/** Let every already-queued microtask and immediate settle. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function fakeWindow({ visible = true, minimized = false, destroyed = false } = {}) {
  const sent = [];
  const window = {
    sent,
    visible,
    minimized,
    destroyed,
    showed: 0,
    focused: 0,
    isDestroyed: () => window.destroyed,
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
      isDestroyed: () => window.destroyed,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  return window;
}

function runtimeFor(window, { closeBehavior = "tray" } = {}) {
  return createCloseBehaviorRuntime({
    state: { mainWindow: window, closeBehavior },
    dataDir: join(tmpdir(), "quit-prompt-surface"),
    getLocale: () => "en",
    createTray: () => {},
  });
}

test.beforeEach(() => {
  dialogCalls.length = 0;
  dialog.nativeResponse = 0;
});

test("a tray quit on a hidden window asks the card instead of the OS", async () => {
  const window = fakeWindow({ visible: false });
  const runtime = runtimeFor(window);

  const answer = runtime.confirmTrayQuit();
  await settled();

  assert.equal(dialogCalls.length, 0, "the native dialog is not the tray path any more");
  assert.equal(window.showed, 1, "the hidden window is shown so the card can be seen");
  assert.equal(window.focused, 1, "and focused so it receives the keys");
  assert.equal(window.sent.length, 1, "the renderer is asked exactly once");
  assert.deepEqual(window.sent[0], {
    channel: QUIT_PROMPT_CHANNEL,
    payload: { requestId: window.sent[0].payload.requestId, kind: "quit" },
  });

  runtime.answerQuitPrompt(window.sent[0].payload.requestId, "quit");
  assert.equal(await answer, true, "confirming the card is a confirmed quit");
  assert.equal(dialogCalls.length, 0);
});

test("a minimized window is restored before it is asked", async () => {
  const window = fakeWindow({ visible: false, minimized: true });
  const runtime = runtimeFor(window);

  const answer = runtime.confirmTrayQuit();
  await settled();

  assert.equal(window.isMinimized(), false, "the window is restored from the taskbar");
  assert.equal(window.isVisible(), true);
  runtime.answerQuitPrompt(window.sent[0].payload.requestId, "cancel");
  assert.equal(await answer, false);
});

test("cancel settles the question once and leaves the window usable", async () => {
  const window = fakeWindow({ visible: false });
  const runtime = runtimeFor(window);

  const answer = runtime.confirmTrayQuit();
  await settled();
  const { requestId } = window.sent[0].payload;
  runtime.answerQuitPrompt(requestId, "cancel");
  assert.equal(await answer, false, "Cancel does not confirm the quit");

  // A stale click from the card that just closed finds no pending request, so
  // it cannot quit the app and cannot settle anything twice.
  runtime.answerQuitPrompt(requestId, "quit");
  assert.equal(window.isVisible(), true, "the window stays on screen and usable");
  assert.equal(dialogCalls.length, 0, "cancel never needs the OS dialog");
  assert.equal(window.sent.length, 1, "no second question is raised by a stale answer");
});

test("confirm quits once and a duplicate answer is ignored", async () => {
  const window = fakeWindow({ visible: false });
  const runtime = runtimeFor(window);

  const answer = runtime.confirmTrayQuit();
  await settled();
  const { requestId } = window.sent[0].payload;

  runtime.answerQuitPrompt(requestId, "quit");
  runtime.answerQuitPrompt(requestId, "quit");
  assert.equal(await answer, true);
  assert.equal(window.sent.length, 1, "one question, one answer");
});

test("a renderer that never answers falls back to the OS after the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = fakeWindow({ visible: false });
  const runtime = runtimeFor(window);
  dialog.nativeResponse = 1;

  const answer = runtime.confirmTrayQuit();
  await settled();
  assert.equal(dialogCalls.length, 0, "the card gets the full timeout first");

  t.mock.timers.tick(20_000);
  assert.equal(await answer, true, "the native dialog answers once the card cannot");

  // The card it asked for is withdrawn before the OS dialog appears, so its
  // buttons cannot answer a request nobody waits on any more.
  const dismiss = window.sent.at(-1).payload;
  assert.equal(dismiss.dismiss, true);
  assert.equal(dismiss.requestId, window.sent[0].payload.requestId);
  assert.equal(dialogCalls.length, 1);
});

test("a destroyed window goes straight to the OS dialog", async () => {
  const window = fakeWindow({ destroyed: true });
  const runtime = runtimeFor(window);

  assert.equal(await runtime.confirmTrayQuit(), false, "the native Cancel is honoured");
  assert.equal(dialogCalls.length, 1, "no renderer exists, so the OS asks");
  assert.equal(window.sent.length, 0);
});

test("the close prompt uses the same card on the window being closed", async () => {
  const window = fakeWindow({ visible: true });
  const runtime = runtimeFor(window, { closeBehavior: "ask" });

  const answer = runtime.askCloseBehavior(window);
  await settled();

  assert.equal(dialogCalls.length, 0, "the close question is drawn by the app too");
  assert.equal(window.sent[0].payload.kind, "close");
  runtime.answerQuitPrompt(window.sent[0].payload.requestId, "tray");
  assert.equal(await answer, "tray", "the same three answers reach the caller");
});

test("automated probes never wait on a card no human is watching", async () => {
  process.env.PI_DESKTOP_BOOT_PROBE = "1";
  try {
    const window = fakeWindow({ visible: false });
    const runtime = runtimeFor(window);
    dialog.nativeResponse = 0;

    assert.equal(await runtime.confirmTrayQuit(), false);
    assert.equal(window.sent.length, 0);
    assert.equal(dialogCalls.length, 1);
  } finally {
    delete process.env.PI_DESKTOP_BOOT_PROBE;
  }
});
