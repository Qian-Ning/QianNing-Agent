import { app, dialog, type MessageBoxOptions } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  describeRefusedLaunch,
  isProcessAlive,
  type InstallationOwner,
} from "./installation-owner";

/**
 * What a refused launch tells the user before it exits.
 *
 * Losing the single-instance lock used to be silent, so launching a newer
 * build while an older one runs surfaced the older window with no
 * explanation. The two cases that need a dialog are the ones the user cannot
 * read off the screen: a *different* build holds the profile, or the holder
 * left no usable record. An identical build stays silent, because surfacing
 * the window it already has is the whole answer there.
 */
export function refusalNoticeOptions(
  owner: InstallationOwner | undefined,
  ownVersion: string,
  locale: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): MessageBoxOptions | undefined {
  const reason = describeRefusedLaunch(owner, ownVersion, isAlive);
  if (reason === "same-version") return undefined;

  const strings = catalogs[resolveLocale(locale)].startup;
  const detail =
    reason === "other-version" && owner
      ? strings.alreadyRunningVersioned
          .replace("{version}", owner.version)
          .replace("{ownVersion}", ownVersion)
      : strings.alreadyRunningUnversioned;
  return {
    type: "info",
    title: strings.alreadyRunningTitle,
    message: strings.alreadyRunningTitle,
    detail,
    buttons: [strings.alreadyRunningDismiss],
    // A one-button notice: Escape, the red X, and the button all mean "read it".
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export type RefusedLaunchExitInput = {
  owner: InstallationOwner | undefined;
  ownVersion: string;
  getLocale: () => string;
  isAlive?: (pid: number) => boolean;
};

/**
 * Explain, then leave.
 *
 * The process is held open until the ready event so the dialog is legal, and
 * `app.exit` ends it without running the quit sequence: this launch owns no
 * window, tray, host, or sidecar, and it never took the lock, so the shared
 * shutdown path must not run on top of the installation that did.
 *
 * A dialog that cannot be shown is not a reason to hang around — the notice is
 * an explanation for a refusal that already happened.
 */
export function registerRefusedLaunchExit(input: RefusedLaunchExitInput): void {
  void app.whenReady().then(async () => {
    try {
      const options = refusalNoticeOptions(
        input.owner,
        input.ownVersion,
        input.getLocale(),
        input.isAlive,
      );
      if (options) await dialog.showMessageBox(options);
    } catch {
      // Nothing left to fall back on: the launch is refused either way.
    }
    app.exit(0);
  });
}
