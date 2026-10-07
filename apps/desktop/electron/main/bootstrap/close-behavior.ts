import { dialog, type BrowserWindow } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { IPC, type CloseBehavior } from "@pi-desktop/shared";
import {
  readCloseBehavior,
  writeCloseBehavior,
} from "../window-preferences";
import type { WindowLifecycleState } from "./window";

export type CloseBehaviorDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  getLocale: () => string;
  createTray: () => void;
};

/** What the user picked in an in-app quit / close prompt (D674). */
export type QuitPromptChoice = "cancel" | "tray" | "quit";
/** `quit` confirms exiting the app; `close` picks the window-close behavior. */
export type QuitPromptKind = "quit" | "close";

/**
 * How long the main process waits for the renderer before falling back to the
 * native dialog. The prompt is drawn by a live renderer, so this only elapses
 * when that renderer is wedged mid-shutdown — the timeout keeps a quit from
 * hanging forever on a window that cannot answer.
 */
const QUIT_PROMPT_TIMEOUT_MS = 20_000;

function isAutomatedMode(): boolean {
  return (
    process.env.PI_DESKTOP_BOOT_PROBE === "1" ||
    process.env.PI_DESKTOP_SUPERVISION_PROBE === "1" ||
    process.env.PI_DESKTOP_CAPTURE === "1"
  );
}

export function createCloseBehaviorRuntime({
  state,
  dataDir,
  getLocale,
  createTray,
}: CloseBehaviorDependencies) {
  const pendingPrompts = new Map<string, (choice: QuitPromptChoice) => void>();
  let promptSequence = 0;

  const applyCloseBehavior = (next: CloseBehavior): void => {
    state.closeBehavior = next;
    writeCloseBehavior(dataDir, next);
    if (next === "tray") createTray();
  };

  /**
   * Answer a prompt the renderer is showing. Unknown or already-settled ids are
   * ignored, so a late click from a stale dialog can never quit the app.
   */
  const answerQuitPrompt = (requestId: string, choice: QuitPromptChoice): void => {
    const settle = pendingPrompts.get(requestId);
    if (!settle) return;
    pendingPrompts.delete(requestId);
    settle(choice);
  };

  /**
   * Ask the renderer to show the app's own dialog (D674) instead of the native
   * message box. Returns null when there is no live window, the app runs in an
   * automated probe, or the renderer does not answer in time — every one of
   * those falls back to the native dialog, so the prompt can never vanish.
   */
  const askRenderer = (
    kind: QuitPromptKind,
    target?: BrowserWindow,
  ): Promise<QuitPromptChoice | null> => {
    // The window that asked the question draws it: the closing window for the
    // close behavior, the main window for a quit confirmation.
    const window = target ?? state.mainWindow;
    if (
      isAutomatedMode() ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return Promise.resolve(null);
    }
    // A window the user cannot see cannot show the question, and waiting on it
    // would turn a tray quit into twenty silent seconds: ask natively instead.
    if (!window.isVisible() || window.isMinimized()) return Promise.resolve(null);
    const requestId = `quit-prompt-${++promptSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(requestId);
        resolve(null);
      }, QUIT_PROMPT_TIMEOUT_MS);
      pendingPrompts.set(requestId, (choice) => {
        clearTimeout(timer);
        resolve(choice);
      });
      try {
        window.webContents.send(IPC.event.appQuitPrompt, { requestId, kind });
      } catch {
        clearTimeout(timer);
        pendingPrompts.delete(requestId);
        resolve(null);
      }
    });
  };

  const askCloseBehavior = async (
    window: BrowserWindow,
  ): Promise<"tray" | "quit" | null> => {
    const answered = await askRenderer("close", window);
    if (answered) return answered === "cancel" ? null : answered;
    const labels = catalogs[resolveLocale(getLocale())];
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: labels.tray.askTitle,
      message: labels.tray.askTitle,
      detail: labels.tray.askBody,
      buttons: [labels.common.cancel, labels.tray.closeToTray, labels.tray.quit],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return response === 1 ? "tray" : response === 2 ? "quit" : null;
  };

  const confirmQuitDialog = async (): Promise<boolean> => {
    const answered = await askRenderer("quit");
    if (answered) return answered === "quit";
    const labels = catalogs[resolveLocale(getLocale())];
    const parent =
      state.mainWindow && !state.mainWindow.isDestroyed()
        ? state.mainWindow
        : undefined;
    const options = {
      type: "warning" as const,
      title: labels.tray.confirmQuitTitle,
      message: labels.tray.confirmQuitTitle,
      detail: labels.tray.confirmQuitBody,
      buttons: [labels.common.cancel, labels.tray.confirmQuit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  };

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    answerQuitPrompt,
    readCloseBehavior: () => readCloseBehavior(dataDir),
  };
}
