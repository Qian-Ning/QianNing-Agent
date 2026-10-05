import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconCheck } from "./icons";
import {
  ONBOARDING_RING_MS,
  doneIds,
  stepsJustCompleted,
} from "./onboarding-motion";

/** Host step ids (app.getOnboarding) mapped to locale keys under `onboarding.`. */
const STEP_LOCALE_KEY: Record<string, string> = {
  provider: "addProvider",
  secret: "saveKey",
  project: "openProject",
  prompt: "firstPrompt",
  plugin: "loadPlugin",
};

/** Stable empty set, so clearing the celebration is not a fresh object. */
const NOTHING_CELEBRATING: ReadonlySet<string> = new Set<string>();

/** First-run inline checklist (D021): rendered on the empty chat home until
 * every step is done or the user dismisses it. State comes from the host
 * (app.getOnboarding); actions deep-link into the relevant surface. */
export function OnboardingChecklist() {
  const { t } = useTranslation();
  const onboarding = useAppStore((s) => s.onboarding);
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const openProject = useAppStore((s) => s.openProject);

  const steps = onboarding?.steps ?? [];
  const allDone = steps.length > 0 && steps.every((s) => s.done);

  /**
   * The tick is the one moment this app may celebrate (§8.6 — rare is the
   * licence), and only the step that *just* completed gets it: `seenDone`
   * starts null so the steps already done when the checklist mounted play
   * nothing, and coming back to the empty home replays nothing (D652).
   */
  const [celebrating, setCelebrating] = useState<ReadonlySet<string>>(
    NOTHING_CELEBRATING,
  );
  const seenDone = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const justCompleted = stepsJustCompleted(seenDone.current, onboarding?.steps ?? []);
    seenDone.current = doneIds(onboarding?.steps ?? []);
    if (justCompleted.length === 0) return;
    setCelebrating(new Set(justCompleted));
    const settle = window.setTimeout(
      () => setCelebrating(NOTHING_CELEBRATING),
      ONBOARDING_RING_MS,
    );
    return () => window.clearTimeout(settle);
  }, [onboarding]);

  /**
   * The finished card leaves instead of vanishing. `gone` starts at the
   * mount-time answer, so a checklist that mounts already complete renders
   * nothing — no card flashes in just to animate back out. The unmount waits
   * for `animationend` of the exit itself; under `prefers-reduced-motion` the
   * §8.5 global net collapses that animation to 0.01ms, so the event still
   * arrives.
   */
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(allDone);
  useEffect(() => {
    if (allDone) {
      setLeaving(true);
      return;
    }
    setLeaving(false);
  }, [allDone]);

  if (!onboarding?.showChecklist) return null;
  if (steps.length === 0 || gone) return null;

  const stepLabel = (id: string, fallback: string) => {
    const key = `onboarding.${STEP_LOCALE_KEY[id] ?? id}`;
    const label = t(key);
    return label === key ? fallback : label;
  };

  const runAction = (id: string) => {
    switch (id) {
      case "settings.providers":
      case "addProvider":
      case "saveKey":
        setSettingsTab("agent");
        setPage("settings");
        break;
      case "project.open":
      case "openProject":
        void openProject();
        break;
      case "chat.focus":
        setPage("chat");
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLTextAreaElement>(".composer-input")
            ?.focus();
        });
        break;
      case "plugins.open":
      case "loadPlugin":
        setPage("plugins");
        break;
      default:
        break;
    }
  };

  const dismiss = () => {
    void api
      .dismissOnboarding()
      .catch(() => undefined)
      .finally(() => {
        const current = useAppStore.getState().onboarding;
        if (current) {
          useAppStore.setState({
            onboarding: { ...current, showChecklist: false },
          });
        }
      });
  };

  return (
    <div
      className={
        "home-onboarding-checklist mx-auto w-full max-w-[560px] rounded-lg-plus border border-border-subtle bg-bg-elevated-opaque p-4 text-left shadow-none" +
        (leaving ? " is-leaving" : "")
      }
      data-testid="onboarding-checklist"
      data-leaving={leaving ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (!leaving) return;
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("onboarding-checklist-out")) return;
        setGone(true);
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-md-plus font-medium text-text-primary">
          {t("onboarding.title")}
        </span>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-xs-plus text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={dismiss}
        >
          {t("onboarding.dismiss")}
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              disabled={step.done}
              onClick={() => runAction(step.action || step.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-md ${
                step.done
                  ? "cursor-default text-text-muted line-through"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              <span
                className={`onboarding-check flex h-4.5 w-4.5 flex-none items-center justify-center rounded-full border ${
                  step.done
                    ? "border-success bg-success/15 text-success"
                    : "border-border-strong text-transparent"
                }${celebrating.has(step.id) ? " is-celebrating" : ""}`}
                aria-hidden
              >
                <IconCheck size={10} />
              </span>
              {stepLabel(step.id, step.title)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
