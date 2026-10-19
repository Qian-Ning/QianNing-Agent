import { readMainSource, readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  protocolSource,
  closeBehaviorSource,
  appIpcSource,
  apiSource,
  dialogSource,
  shellSource,
] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  readMainModule("bootstrap/close-behavior.ts"),
  readMainModule("ipc/app-ipc.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/ClosePromptDialog.tsx"),
  read("../src/features/app/AppShell.tsx"),
]);

function bodyOf(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const end = source.indexOf("\n  };", start);
  return source.slice(start, end === -1 ? undefined : end);
}

test("both quit questions are drawn by the renderer first", () => {
  // D674: the native message box looked nothing like the app, so each question
  // now asks the live renderer and only falls back to the message box.
  const close = bodyOf(closeBehaviorSource, "const askCloseBehavior = async");
  assert.ok(
    close.indexOf('askRenderer("close"') < close.indexOf("dialog.showMessageBox"),
    "the close-behavior question must ask the renderer before the native dialog",
  );

  const quit = bodyOf(closeBehaviorSource, "const confirmQuitDialog = async");
  assert.ok(
    quit.indexOf('askRenderer("quit")') < quit.indexOf("askNativeQuit()"),
    "the quit confirmation must ask the renderer before the native dialog",
  );
  // There is one surface now: no caller can opt out of the app's card, and the
  // tray item goes through the same confirmation as every other quit.
  assert.doesNotMatch(
    closeBehaviorSource,
    /QuitPromptSurface|confirmQuitDialog\("native"\)/,
    "the native surface is not selectable any more",
  );
  const tray = bodyOf(closeBehaviorSource, "const confirmTrayQuit =");
  assert.match(tray, /confirmQuitDialog\(\)/);
  assert.ok(
    closeBehaviorSource.indexOf("const askNativeQuit = async") <
      closeBehaviorSource.indexOf("const confirmTrayQuit ="),
    "the native dialog is one fallback implementation behind the card",
  );
});

test("a hidden window is shown so it can draw the card, not skipped", () => {
  const ask = bodyOf(closeBehaviorSource, "const askRenderer =");
  // A tray quit arrives with the window hidden: restore it instead of treating
  // it as a renderer that cannot answer.
  assert.doesNotMatch(ask, /!window\.isVisible\(\)\s*\|\|\s*window\.isMinimized\(\)/);
  assert.match(ask, /presentPromptWindow\(window\);/);
  assert.ok(
    ask.indexOf("presentPromptWindow(window);") < ask.indexOf("webContents.send"),
    "the window has to be on screen before the renderer is asked",
  );
  const present = bodyOf(closeBehaviorSource, "const presentPromptWindow =");
  assert.match(present, /if \(window\.isMinimized\(\)\) window\.restore\(\);/);
  assert.match(present, /if \(!window\.isVisible\(\)\) window\.show\(\);/);
  assert.match(present, /window\.focus\(\);/);
});

test("the prompt can never vanish when the renderer cannot answer", () => {
  const ask = bodyOf(closeBehaviorSource, "const askRenderer =");
  // No live window: the native dialog takes over immediately.
  assert.match(ask, /if \([\s\S]*?!window \|\|[\s\S]*?window\.isDestroyed\(\)[\s\S]*?window\.webContents\.isDestroyed\(\)[\s\S]*?\) \{\s*\n\s*return Promise\.resolve\(null\);/);
  // Automated probes must never wait on a prompt no human is watching.
  assert.match(ask, /isAutomatedMode\(\)/);
  // A wedged renderer resolves to the native fallback instead of hanging quit.
  // The bound is generous, so a window restored from the tray that is slow to
  // repaint is not mistaken for one that cannot answer.
  assert.match(closeBehaviorSource, /const QUIT_PROMPT_TIMEOUT_MS = 20_000;/);
  assert.match(ask, /setTimeout\(\(\) => \{[\s\S]*?resolve\(null\);/);
  // Giving up also withdraws the card it asked for: otherwise the native dialog
  // appears over an in-app prompt whose buttons can no longer decide anything.
  const timeout = bodyOf(ask, "const timer = setTimeout(");
  assert.match(
    timeout,
    /webContents\.send\(IPC\.event\.appQuitPrompt, \{\s*\n\s*requestId,\s*\n\s*kind,\s*\n\s*dismiss: true,\s*\n\s*\}\)/,
  );
  assert.ok(
    timeout.indexOf("dismiss: true") < timeout.indexOf("resolve(null)"),
    "the dismiss signal must leave before the fallback resolves",
  );
  // A failed send resolves too, so the promise state is the only source of truth.
  assert.match(ask, /catch \{[\s\S]*?resolve\(null\);/);
});

test("the prompt host drops a withdrawn prompt", () => {
  // D674: a dismissed request must clear the card instead of leaving its buttons
  // answering a settled request. The host keys the check to the same request id.
  assert.match(
    dialogSource,
    /if \(next\.dismiss\) \{[\s\S]*?pendingRef\.current\?\.requestId !== next\.requestId[\s\S]*?setPrompt\(null\);/,
  );
  assert.match(
    apiSource,
    /dismiss\?: boolean/,
    "the event payload type must carry the dismissal flag",
  );
});

test("only a pending request id can settle a prompt", () => {
  const answer = bodyOf(closeBehaviorSource, "const answerQuitPrompt =");
  // A stale or forged answer finds no pending entry, so it cannot quit the app.
  assert.match(answer, /const settle = pendingPrompts\.get\(requestId\);/);
  assert.match(answer, /if \(!settle\) return;/);
  assert.match(answer, /pendingPrompts\.delete\(requestId\);\s*\n\s*settle\(choice\);/);
  // The renderer is asked over the event channel and answered over the invoke
  // channel: one request id per prompt.
  assert.match(
    closeBehaviorSource,
    /window\.webContents\.send\(IPC\.event\.appQuitPrompt, \{ requestId, kind \}\)/,
  );
  assert.match(protocolSource, /appQuitPrompt:\s*"pi-desktop\/app\/event\/quitPrompt"/);
  assert.match(
    protocolSource,
    /appQuitPromptAnswer:\s*"pi-desktop\/app\/quitPrompt\/answer"/,
  );
});

test("the main process validates the answer before trusting it", () => {
  const handler = appIpcSource.slice(
    appIpcSource.indexOf("IPC.invoke.appQuitPromptAnswer"),
  );
  const body = handler.slice(0, handler.indexOf("\n  });") + 6);
  // Only the main window may answer, and the choice is a closed set.
  assert.match(body, /assertMainWindowSender\(event\)/);
  assert.match(body, /typeof answer\.requestId === "string"/);
  assert.match(body, /isQuitPromptChoice\(answer\.choice\)/);
  assert.match(
    appIpcSource,
    /value === "cancel" \|\| value === "tray" \|\| value === "quit"/,
  );
  // The composition root hands the runtime's settler to the IPC layer.
  assert.match(appIpcSource, /answerQuitPrompt\(\s*answer\.requestId,\s*answer\.choice,?\s*\)/);
});

test("the renderer host answers, and its default action is the confirm", () => {
  assert.match(dialogSource, /api\.onQuitPrompt\(/);
  assert.match(dialogSource, /api\.answerQuitPrompt\(/);
  // Escape cancels from anywhere; Enter takes the default action, so focus
  // starts on the default button (the card's confirm) rather than Cancel.
  assert.match(dialogSource, /event\.key === "Escape"/);
  assert.match(dialogSource, /event\.key === "Enter"/);
  assert.match(dialogSource, /event\.target === event\.currentTarget/);
  assert.match(dialogSource, /confirmRef\.current\?\.focus\(\)/);
  assert.match(dialogSource, /ref=\{confirmRef\}/);
  // Tab never leaves the card, and focus is pulled back if it escaped.
  assert.match(dialogSource, /event\.key !== "Tab"/);
  assert.match(dialogSource, /!dialogRef\.current\?\.contains\(active\)/);
  assert.match(dialogSource, /previouslyFocused\?\.isConnected\) previouslyFocused\.focus\(\)/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  // The three answers are the three the native dialog offered.
  for (const choice of ['"cancel"', '"tray"', '"quit"']) {
    assert.match(dialogSource, new RegExp(`answer\\(${choice}\\)`));
  }
  // Copy is localized from the labels the native dialog already used.
  assert.match(dialogSource, /t\("common\.cancel"\)/);
  assert.match(dialogSource, /t\("tray\.closeToTray"\)/);
  assert.match(dialogSource, /t\("tray\.confirmQuit"\)/);
  assert.doesNotMatch(dialogSource, /[\u4e00-\u9fff]/);

  // And the host is actually mounted next to the other overlay hosts.
  assert.match(shellSource, /<ClosePromptHost \/>/);
  assert.match(
    shellSource,
    /import \{ ClosePromptHost \} from "\.\.\/\.\.\/components\/ClosePromptDialog"/,
  );
});

test("the renderer exposes the prompt through the typed api surface", () => {
  assert.match(apiSource, /IPC\.invoke\.appQuitPromptAnswer/);
  assert.match(apiSource, /IPC\.event\.appQuitPrompt/);
  assert.match(apiSource, /onQuitPrompt:/);
});

test("main still owns the tray and windows the prompt talks about", async () => {
  // The prompt replies from `state.mainWindow`, so the runtime keeps its other
  // contract intact: one tray, close behavior applied through the same writer.
  const mainSource = await readMainSource();
  assert.match(mainSource, /createCloseBehaviorRuntime\(/);
  assert.match(closeBehaviorSource, /if \(next === "tray"\) createTray\(\);/);
});
