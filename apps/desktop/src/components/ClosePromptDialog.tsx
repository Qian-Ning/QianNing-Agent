import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { portalToBody } from "../lib/portal-visibility";
import { api } from "../lib/api";
import { Button } from "./ui";
import { IconCircleAlert, IconPower } from "./icons";

/**
 * The in-app quit / close prompt (D674).
 *
 * Every quit confirmation is drawn here — the application menu, Cmd+Q, the
 * window close that chose Quit, and the tray's Quit item. The main process asks
 * over `IPC.event.appQuitPrompt` and, for a quit raised from the tray, restores
 * and focuses the window first so this card is on screen. The native dialog is
 * a last resort for a renderer that cannot answer at all, never a surface a
 * normal quit passes through.
 *
 * The card owns its keyboard: Escape cancels, Enter takes the default action,
 * Tab stays inside it, and focus returns to whatever had it before.
 */

type QuitPrompt = { requestId: string; kind: "quit" | "close" };
type QuitPromptChoice = "cancel" | "tray" | "quit";

export function ClosePromptHost() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState<QuitPrompt | null>(null);
  // The dialog can unmount between the click and the IPC call, so the pending
  // request lives in a ref as well as in state.
  const pendingRef = useRef<QuitPrompt | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const unsubscribe = api.onQuitPrompt((next) => {
      if (!next || typeof next.requestId !== "string") return;
      if (next.kind !== "quit" && next.kind !== "close") return;
      if (next.dismiss) {
        // The main process gave up waiting and the native dialog asks instead
        // (D674): drop this card so it cannot linger over a settled question.
        if (pendingRef.current?.requestId !== next.requestId) return;
        pendingRef.current = null;
        setPrompt(null);
        return;
      }
      pendingRef.current = next;
      setPrompt(next);
    });
    return () => {
      unsubscribe?.();
      // A host that goes away mid-question (reload, window teardown) can no
      // longer draw the card, and nobody is waiting for that request any more.
      // Answering cancel releases it now instead of leaving the main process
      // to time out and raise a native dialog over a dead renderer.
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        void api
          .answerQuitPrompt(pending.requestId, "cancel")
          .catch(() => undefined);
      }
    };
  }, []);

  const answer = useCallback((choice: QuitPromptChoice) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setPrompt(null);
    // A dropped answer leaves the main process's timeout in charge, which
    // falls back to the native dialog: the prompt is never left hanging.
    void api.answerQuitPrompt(pending.requestId, choice).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!prompt) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Enter takes the default action, so the default button holds focus: the
    // focused control is the one Enter is about to press. Escape is the way
    // out and stays available from every control.
    requestAnimationFrame(() => confirmRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        answer("cancel");
        return;
      }
      if (event.key === "Enter") {
        // A focused button keeps its own meaning, so Enter on Cancel cancels
        // and Enter on Close to tray minimizes. Anywhere else — including the
        // card itself after the window was restored — Enter confirms.
        if (event.target instanceof HTMLElement && event.target.closest("button")) {
          return;
        }
        event.preventDefault();
        answer("quit");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialogRef.current?.contains(active)) {
        // Focus escaped the card (the window was just restored and focused, a
        // portal hop, a click on the page behind): pull it back in rather than
        // letting Tab walk the app under a modal overlay.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Restoring a window from the tray hands it focus without a click, so the
    // card has to claim it back or the first keystroke lands on the page.
    const onWindowFocus = () => {
      if (!dialogRef.current?.contains(document.activeElement)) {
        confirmRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focus", onWindowFocus);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [prompt, answer]);

  if (!prompt) return null;

  const isQuit = prompt.kind === "quit";
  const dialog = (
    <div
      className="overlay quit-prompt-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) answer("cancel");
      }}
    >
      <div
        ref={dialogRef}
        className="dialog quit-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quit-prompt-title"
        aria-describedby="quit-prompt-body"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="quit-prompt-mark" aria-hidden>
          {isQuit ? <IconPower size={18} /> : <IconCircleAlert size={18} />}
        </div>
        <h2 id="quit-prompt-title" className="quit-prompt-title">
          {t(isQuit ? "tray.confirmQuitTitle" : "tray.askTitle")}
        </h2>
        <p id="quit-prompt-body" className="quit-prompt-body">
          {t(isQuit ? "tray.confirmQuitBody" : "tray.askBody")}
        </p>
        <div className="quit-prompt-actions">
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            onClick={() => answer("cancel")}
          >
            {t("common.cancel")}
          </Button>
          {isQuit ? null : (
            <Button type="button" variant="secondary" onClick={() => answer("tray")}>
              {t("tray.closeToTray")}
            </Button>
          )}
          <Button
            ref={confirmRef}
            type="button"
            variant="primary"
            className="quit-prompt-confirm"
            onClick={() => answer("quit")}
          >
            {t("tray.confirmQuit")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
