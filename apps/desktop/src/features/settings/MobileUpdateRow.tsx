/**
 * App update, phone only.
 *
 * The desktop has electron-updater behind it; the phone is sideloaded and has
 * nothing watching the release page. This row is that watcher: it asks GitHub
 * for the latest release, compares it with the running version and, when there
 * is something newer, hands the APK to the system installer. Android still asks
 * the user to confirm — an app cannot install silently, and pretending
 * otherwise would only make the button look broken.
 */

import { APP_VERSION } from "@pi-desktop/shared";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { SettingsRow } from "./primitives";

type State = "idle" | "checking" | "latest" | "available" | "installing" | "error";

function onPhone(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.surface === "mobile";
}

export function MobileUpdateRow() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>("idle");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setState("checking");
    setError(null);
    try {
      const answer = await api.checkAppUpdate();
      setVersion(answer.version);
      setState(answer.available ? "available" : "latest");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/permission/.test(message) ? t("settings.mobileUpdatePermission") : t("settings.mobileUpdateFailed"));
      setState("error");
    }
  }, [t]);

  /**
   * A phone that can reach the release page is also a phone whose build is
   * worth checking on mount — the row is one screen deep in Settings, and an
   * update nobody notices is the same as no updater at all.
   */
  useEffect(() => {
    if (!onPhone()) return;
    void check();
  }, [check]);

  const install = useCallback(async () => {
    setState("installing");
    setError(null);
    try {
      const answer = await api.checkAppUpdate();
      await api.installAppUpdate(answer.url);
      setState("available");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/permission/.test(message) ? t("settings.mobileUpdatePermission") : message);
      setState("error");
    }
  }, [t]);

  if (!onPhone()) return null;

  return (
    <SettingsRow
      title={t("settings.mobileUpdateTitle")}
      description={t("settings.mobileUpdateCurrent", { version: APP_VERSION })}
    >
      <div className="mobile-update">
        {state === "available" || state === "installing" ? (
          <span className="mobile-update-version">{version}</span>
        ) : null}
        <Button
          variant={state === "available" ? "primary" : "secondary"}
          disabled={state === "checking" || state === "installing"}
          onClick={() => void (state === "available" ? install() : check())}
        >
          {state === "checking"
            ? t("settings.mobileUpdateChecking")
            : state === "installing"
              ? t("settings.mobileUpdateInstalling")
              : state === "available"
                ? t("settings.mobileUpdateInstall", { version })
                : state === "latest"
                  ? t("settings.mobileUpdateLatest")
                  : t("settings.mobileUpdateCheck")}
        </Button>
        {error ? <p className="mobile-update-error">{error}</p> : null}
      </div>
    </SettingsRow>
  );
}
