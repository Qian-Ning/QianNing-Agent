import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { portalToBody } from "../lib/portal-visibility";
import { api } from "../lib/api";
import { Button } from "./ui";
import { IconCircleAlert, IconPower } from "./icons";

/**
 * The in-app quit / close prompt (D674).
 *
 * The main process used to raise a native message box for both questions, which
 * looked nothing like the app. It now asks the renderer first, over
 * `IPC.event.appQuitPrompt`, and falls back to the native dialog when no live
 * window can answer — so this host only has to draw a good one and reply
 * through `IPC.invoke.appQuitPromptAnswer`.
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
    // Escape cancels, and focus starts on the safe action: a stray Enter must
    // never be the keystroke that quits the app.
    requestAnimationFrame(() => cancelRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        answer("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
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
