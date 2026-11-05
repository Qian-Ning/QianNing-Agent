import { useCallback, useEffect, useMemo, useState } from "react";
import "./onboarding.css";
import brandMark from "../assets/brand-mark.png";
import type { Translate } from "../lib/i18n";
import {
  askBatteryExemption,
  askExactAlarms,
  askNotificationPermission,
  openNotificationSettings,
  readSystemPermissions,
  systemPermissionsAvailable,
  type PermissionSnapshot,
} from "../agent/system-permissions";

type Props = {
  t: Translate;
  onDone: () => void;
};

type Step = "welcome" | "notify" | "background";

/**
 * First run, three screens.
 *
 * The app can be used without any of this — the welcome screen says so — but a
 * phone that never receives a notification and gets frozen in the background
 * looks broken later, so the two settings that cause that are asked for here,
 * once, with the reason attached. Nothing is granted on the reader's behalf:
 * each row shows what Android currently reports.
 */
export function OnboardingView({ t, onDone }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  // Once Android has shown the dialog, asking again does nothing on 13+: the
  // only way back is the settings page.
  const [asked, setAsked] = useState(false);
  const native = systemPermissionsAvailable();

  const refresh = useCallback(async () => {
    setSnapshot(await readSystemPermissions());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returning from a settings page is the only way some of these change; the
  // numbers on screen must follow the system, not what we hoped the tap did.
  useEffect(() => {
    if (!native) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [native, refresh]);

  const notificationsOn = !snapshot || snapshot.notifications;
  const batteryFree = snapshot ? !snapshot.batteryOptimised : false;
  const alarmsOk = snapshot ? snapshot.exactAlarms : false;

  const run = useCallback(
    async (action: () => Promise<PermissionSnapshot | null>) => {
      setBusy(true);
      try {
        const next = await action();
        if (next) setSnapshot(next);
        else await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const steps = useMemo<Step[]>(() => ["welcome", "notify", "background"], []);
  const index = steps.indexOf(step);
  const advance = () => {
    const next = steps[index + 1];
    if (next) setStep(next);
    else onDone();
  };

  const title =
    step === "welcome"
      ? t("onboarding.welcome.title")
      : step === "notify"
        ? t("onboarding.notify.title")
        : t("onboarding.background.title");

  const body =
    step === "welcome"
      ? t("onboarding.welcome.body")
      : step === "notify"
        ? t("onboarding.notify.body")
        : t("onboarding.background.body");

  return (
    <div className="screen onboarding">
      <header className="onboarding-head">
        <img className="onboarding-mark" src={brandMark} alt="" width={44} height={44} />
        <div className="onboarding-dots" aria-hidden="true">
          {steps.map((entry) => (
            <span key={entry} className={entry === step ? "dot on" : "dot"} />
          ))}
        </div>
      </header>

      <div className="onboarding-copy">
        <h1>{title}</h1>
        <p className="muted">{body}</p>
      </div>

      {step === "notify" ? (
        <div className="onboarding-rows">
          <div className="onboarding-row">
            <div className="onboarding-row-text">
              <strong>{t("onboarding.notify.rowTitle")}</strong>
              <span className="muted">
                {notificationsOn ? t("onboarding.notify.granted") : t("onboarding.notify.denied")}
              </span>
            </div>
            {notificationsOn ? (
              <span className="onboarding-state ok">{t("onboarding.state.on")}</span>
            ) : (
              <button
                type="button"
                className="ghost tiny"
                disabled={busy}
                onClick={() => {
                  const canAsk = snapshot?.notificationsRuntime && !asked;
                  setAsked(true);
                  void run(canAsk ? askNotificationPermission : () => openNotificationSettings().then(() => null));
                }}
              >
                {snapshot?.notificationsRuntime && !asked
                  ? t("onboarding.notify.allow")
                  : t("onboarding.notify.settings")}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {step === "background" ? (
        <div className="onboarding-rows">
          <div className="onboarding-row">
            <div className="onboarding-row-text">
              <strong>{t("onboarding.background.batteryTitle")}</strong>
              <span className="muted">{t("onboarding.background.batteryBody")}</span>
            </div>
            {batteryFree ? (
              <span className="onboarding-state ok">{t("onboarding.state.on")}</span>
            ) : (
              <button
                type="button"
                className="ghost tiny"
                disabled={busy}
                onClick={() => void run(askBatteryExemption)}
              >
                {t("onboarding.background.allow")}
              </button>
            )}
          </div>
          <div className="onboarding-row">
            <div className="onboarding-row-text">
              <strong>{t("onboarding.background.alarmTitle")}</strong>
              <span className="muted">{t("onboarding.background.alarmBody")}</span>
            </div>
            {alarmsOk ? (
              <span className="onboarding-state ok">{t("onboarding.state.on")}</span>
            ) : (
              <button
                type="button"
                className="ghost tiny"
                disabled={busy}
                onClick={() => void run(askExactAlarms)}
              >
                {t("onboarding.background.allow")}
              </button>
            )}
          </div>
        </div>
      ) : null}

      <div className="onboarding-actions">
        <button type="button" className="primary wide" onClick={advance}>
          {step === "welcome"
            ? t("onboarding.welcome.cta")
            : step === "notify"
              ? t("onboarding.next")
              : t("onboarding.done")}
        </button>
        {step !== "background" ? (
          <button type="button" className="ghost wide" onClick={onDone}>
            {t("onboarding.skip")}
          </button>
        ) : (
          <p className="onboarding-footnote muted">{t("onboarding.background.footnote")}</p>
        )}
      </div>
    </div>
  );
}
