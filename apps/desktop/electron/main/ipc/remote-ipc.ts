/**
 * Settings surface for remote access (ADR 0333 P1).
 *
 * Five thin channels over the listener that `startup` constructs but does not
 * start: the entry point exists from boot so a device list can be read before
 * anyone enables it, and only `enable` opens the socket. Nothing here formats a
 * response — the renderer decides how to phrase "off" versus "listening on
 * 127.0.0.1:51234".
 *
 * `issueDevice` is the only channel that ever carries a token, and it is the
 * only moment the Host has one in plaintext. Every other answer is a summary.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  RemoteAccessStatus,
  RemoteDeviceSummary,
  RemoteIssuedDevice,
} from "@pi-desktop/shared";
import type { RemoteListener } from "@pi-desktop/host-runtime";
import type { IpcRegistrar } from "./types";

export type { RemoteAccessStatus, RemoteDeviceSummary, RemoteIssuedDevice };

export type RemoteIpcDependencies = {
  registrar: IpcRegistrar;
  /** Undefined when the listener could not be constructed (no data directory yet). */
  getListener: () => RemoteListener | null;
};

const EMPTY_STATUS: RemoteAccessStatus = {
  running: false,
  pairedDevices: 0,
  devices: [],
};

function summarize(
  devices: Awaited<ReturnType<RemoteListener["listDevices"]>>,
): RemoteDeviceSummary[] {
  return devices.map((device) => ({
    deviceId: device.deviceId,
    label: device.label,
    roles: [...device.roles],
    createdAt: device.createdAt,
    ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
  }));
}

export function registerRemoteIpc({ registrar, getListener }: RemoteIpcDependencies): void {
  const status = async (): Promise<RemoteAccessStatus> => {
    const listener = getListener();
    if (!listener) return EMPTY_STATUS;
    const current = await listener.status();
    return { ...current, devices: summarize(await listener.listDevices()) };
  };

  registrar.handle(IPC.invoke.remoteStatus, status);

  registrar.handle(IPC.invoke.remoteEnable, async (): Promise<RemoteAccessStatus> => {
    const listener = getListener();
    if (!listener) throw new Error("the remote listener is unavailable");
    await listener.start();
    return status();
  });

  registrar.handle(IPC.invoke.remoteDisable, async (): Promise<RemoteAccessStatus> => {
    const listener = getListener();
    if (!listener) return EMPTY_STATUS;
    await listener.stop();
    return status();
  });

  registrar.handle(
    IPC.invoke.remoteIssueDevice,
    async (input: { label: string } | undefined): Promise<RemoteIssuedDevice> => {
      const listener = getListener();
      if (!listener) throw new Error("the remote listener is unavailable");
      const label = (input?.label ?? "").trim();
      if (!label) throw new Error("a device label is required");
      return listener.issueDevice(label);
    },
  );

  registrar.handle(
    IPC.invoke.remoteRevokeDevice,
    async (input: { deviceId: string }): Promise<{ revoked: boolean }> => {
      const listener = getListener();
      if (!listener) return { revoked: false };
      return { revoked: await listener.revokeDevice(input.deviceId) };
    },
  );
}
