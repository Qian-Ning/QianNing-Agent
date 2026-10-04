import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ConnectionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
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
}
