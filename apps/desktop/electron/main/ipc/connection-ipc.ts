import { IPC } from "@pi-desktop/shared";
import { dialog, type BrowserWindow, type OpenDialogOptions } from "electron";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ConnectionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** Owns the native key-file dialog; a dialog with no owner floats loose. */
  getMainWindow: () => BrowserWindow | null;
};

/**
 * The Connections destination's channels (ADR 0320 §10).
 *
 * Each one is a thin forward to the matching `connection.*` host method: the
 * host owns validation, persistence, the secret store, and the audit row, and
 * nothing here second-guesses it. The methods that create, edit, enable, or
 * delete a profile are reachable only from this process, which is why the
 * agent never gets one — it may reach the targets a person set up, never set
 * them up.
 *
 * `connection.setCredential` carries a secret from the renderer to the host.
 * It travels as an argument like any other field, is written straight into the
 * host's secret store, and is returned by no method — the reply is
 * `credentialConfigured`, a boolean.
 */
export function registerConnectionIpc({
  registrar,
  getHost,
  getMainWindow,
}: ConnectionIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (payload?: any) => Promise<any>) => {
    registrar.handle(channel, async (payload) => {
      host = getHost();
      if (!host) throw new Error("host unavailable");
      return fn(payload);
    });
  };

  handle(IPC.invoke.connectionProfiles, () => host!.call("connection.profiles"));

  handle(IPC.invoke.connectionProbe, (profileId: string) =>
    host!.call("connection.probe", { profileId }),
  );

  handle(IPC.invoke.connectionCreate, (draft: unknown) =>
    host!.call("connection.create", draft ?? {}),
  );

  handle(IPC.invoke.connectionUpdate, (draft: unknown) =>
    host!.call("connection.update", draft ?? {}),
  );

  handle(IPC.invoke.connectionDelete, (profileId: string) =>
    host!.call("connection.delete", { profileId }),
  );

  handle(
    IPC.invoke.connectionSetEnabled,
    (payload: { profileId: string; enabled: boolean }) =>
      host!.call("connection.setEnabled", payload),
  );

  handle(
    IPC.invoke.connectionSetCredential,
    (payload: { profileId: string; secret: string }) =>
      host!.call("connection.setCredential", payload),
  );

  handle(IPC.invoke.connectionClearCredential, (profileId: string) =>
    host!.call("connection.clearCredential", { profileId }),
  );

  handle(
    IPC.invoke.connectionAcceptHostKey,
    (payload: { profileId: string; fingerprint: string }) =>
      host!.call("connection.acceptHostKey", payload),
  );

  handle(
    IPC.invoke.connectionActivity,
    (payload: { profileId: string; limit?: number }) =>
      host!.call("connection.activity", payload ?? {}),
  );

  /**
   * The one channel here that forwards to no host method: it is a native file
   * dialog. The picker is a path-only affordance for the identity-file field —
   * ssh reads that file itself at connect time, so no process of ours ever
   * reads a private key, and only the chosen path crosses back to the
   * renderer. A second open while one is up returns `canceled` rather than
   * stacking dialogs on the window.
   */
  let identityPickerActive = false;
  registrar.handle(IPC.invoke.connectionPickIdentityFile, async () => {
    if (identityPickerActive) return { path: null, canceled: true };
    identityPickerActive = true;
    try {
      const options: OpenDialogOptions = {
        properties: ["openFile", "showHiddenFiles"],
        filters: [
          { name: "SSH", extensions: ["pem", "key", "ppk", "pub"] },
          { name: "*", extensions: ["*"] },
        ],
      };
      const owner = getMainWindow();
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      const picked = result?.filePaths?.[0];
      if (!result || result.canceled || !picked) return { path: null, canceled: true };
      return { path: picked, canceled: false };
    } finally {
      identityPickerActive = false;
    }
  });
}
