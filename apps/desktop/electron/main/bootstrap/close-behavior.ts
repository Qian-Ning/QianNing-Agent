import { app, dialog, type BrowserWindow } from "electron";
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
 * when that renderer is wedged — the timeout keeps a quit from hanging forever
 * on a window that cannot answer.
 *
 * Deliberately generous: the window may have been restored from the tray a
 * moment earlier, and a slow repaint or a lazily resumed page must not be
 * mistaken for a dead one and replaced by the very OS dialog this change
 * removes. Only a renderer that is genuinely stuck ever reaches the bound.
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
   * Bring the window that will draw the prompt in front of the user. A quit
   * raised from the tray arrives while the main window is hidden: a hidden
   * window can neither paint the card nor take the keystrokes that answer it,
   * so it is restored and focused first. Cancelling leaves it on screen — the
   * app is running again, and a window that was shown to ask a question must
   * not be left claiming to be hidden.
   */
  const presentPromptWindow = (window: BrowserWindow): void => {
    try {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      // macOS keeps a window behind the other apps unless the app itself is
      // activated, and a card nobody can see is the problem being fixed.
      if (process.platform === "darwin") app.focus({ steal: true });
      window.focus();
    } catch {
      // The window died between the checks and these calls; the send below
      // fails the same way, and the caller falls back to the native dialog.
    }
  };

  /**
   * Ask the renderer to show the app's own dialog (D674). Returns null only
   * when the renderer provably cannot answer — no window, a destroyed window
   * or webContents, an automated probe — or when it stays silent past
   * `QUIT_PROMPT_TIMEOUT_MS`. Every other case, including a quit raised from
   * the tray while the window is hidden, is drawn by the app.
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
    presentPromptWindow(window);
    const requestId = `quit-prompt-${++promptSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(requestId);
        // The native dialog takes the question over from here, so the card in
        // the renderer has to go: its buttons would answer a request nobody is
        // waiting on any more, and that reads as a dead app.
        try {
          window.webContents.send(IPC.event.appQuitPrompt, {
            requestId,
            kind,
            dismiss: true,
          });
        } catch {
          // The window died with the prompt on screen; nothing is left to clear.
        }
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

  /**
   * The last-resort OS dialog. Reachable only when `askRenderer` returned null:
   * no live renderer at all, or one that stayed silent past the timeout. No
   * normal quit path takes this route — see `confirmQuitDialog`.
   */
  const askNativeQuit = async (): Promise<boolean> => {
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

  /**
   * The one quit confirmation every entry point shares: the tray's Quit item,
   * the window close that chose Quit, the application menu and Cmd+Q. It is
   * always the app's own card; the native dialog answers only when the renderer
   * provably cannot (no live window) or stops answering past the timeout.
   */
  const confirmQuitDialog = async (): Promise<boolean> => {
    const answered = await askRenderer("quit");
    if (answered) return answered === "quit";
    return askNativeQuit();
  };

  /**
   * The tray's Quit item, answered by the same card as every other quit.
   *
   * A tray quit is raised outside the window, usually while the window sits
   * hidden in the tray. The card is still drawn there: `askRenderer` restores
   * and focuses the window so it can be seen and answered, and a cancelled
   * quit leaves that window open and usable rather than re-hiding it behind
   * the question.
   */
  const confirmTrayQuit = (): Promise<boolean> => confirmQuitDialog();

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    confirmTrayQuit,
    answerQuitPrompt,
    readCloseBehavior: () => readCloseBehavior(dataDir),
  };
}
