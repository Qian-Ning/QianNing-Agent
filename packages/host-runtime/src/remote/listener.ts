/**
 * The desktop's network entry point (ADR 0333 §2): a loopback `RACP-HTTP`
 * listener attached to the Agent Host that already exists in Electron Main.
 *
 * Off until asked for, and loopback-only when on. Sessions keep one owner — the
 * renderer keeps using IPC, and this listener reaches the same host-core through
 * the same proxy, so no second Host process appears on a user's machine.
 *
 * Device tokens are issued here rather than by a pairing flow: ADR 0333 ships
 * the pairing QR at P3, and issue-once-then-copy is the smallest thing that
 * still gives every client its own revocable credential.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentHost } from "@pi-desktop/agent-host";
import { createHostOperations, type HostRpc } from "@pi-desktop/host-runtime";
import {
  DeviceTokenAuthenticator,
  RacpServer,
  bindRacpHttp,
  hashToken,
  newDeviceToken,
  type DeviceRecord,
  type HttpBinding,
} from "@pi-desktop/racp";
import type { RacpRole } from "@pi-desktop/shared";

import { FileCredentialStore } from "./device-store.js";

export type RemoteListenerOptions = {
  /** `<dataDir>/remote` or the data directory itself; the store picks its file. */
  dataDir: string;
  agentHost: AgentHost;
  serverVersion: string;
  getHost: () => HostRpc | null;
  compact: (sessionId: string) => Promise<{ accepted: boolean }>;
  isBusy: (sessionId: string) => boolean;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** `0` asks the OS for a free port. */
  port?: number;
};

export type RemoteStatus = {
  running: boolean;
  host?: string;
  port?: number;
  pairedDevices: number;
};

export type IssuedDevice = {
  deviceId: string;
  label: string;
  roles: RacpRole[];
  /** Shown once; the Host keeps only its hash. */
  token: string;
};

export type RemoteListener = {
  status(): Promise<RemoteStatus>;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  issueDevice(label: string, roles?: RacpRole[]): Promise<IssuedDevice>;
  revokeDevice(deviceId: string): Promise<boolean>;
};

const LOOPBACK = "127.0.0.1";

export function createRemoteListener(options: RemoteListenerOptions): RemoteListener {
  const remoteDir = join(options.dataDir, "remote");
  const store = new FileCredentialStore(join(remoteDir, "devices.json"));
  const authenticator = new DeviceTokenAuthenticator(store);
  let binding: HttpBinding | null = null;
  let server: RacpServer | null = null;

  const hostId = async (): Promise<string> => {
    const path = join(remoteDir, "host-id");
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // First start.
    }
    const minted = `host_${randomUUID()}`;
    await mkdir(remoteDir, { recursive: true });
    await writeFile(path, `${minted}\n`, "utf8");
    return minted;
  };

  return {
    async status() {
      const devices = await store.listDevices();
      return {
        running: binding !== null,
        ...(binding ? { host: binding.address.host, port: binding.address.port } : {}),
        pairedDevices: devices.filter((device) => !device.revokedAt).length,
      };
    },

    async start() {
      if (binding) return binding.address;
      const operations = createHostOperations({
        getHost: options.getHost,
        runtime: { compact: options.compact, isBusy: options.isBusy },
      });
      server = new RacpServer({
        agentHost: options.agentHost,
        operations,
        authenticator,
        hostId: await hostId(),
        serverVersion: options.serverVersion,
        // Only the HTTP binding is served here; the WebSocket binding stays the
        // transport for machine-to-machine links, which the desktop does not host.
        bindings: ["RACP-HTTP"],
        log: options.log,
      });
      binding = await bindRacpHttp({
        server,
        authenticator,
        host: LOOPBACK,
        port: options.port ?? 0,
        log: options.log,
      });
      options.log("info", "remote listener started", binding.address);
      return binding.address;
    },

    async stop() {
      if (binding) {
        await binding.close();
        binding = null;
      }
      server?.close();
      server = null;
      options.log("info", "remote listener stopped");
    },

    listDevices() {
      return store.listDevices();
    },

    async issueDevice(label, roles = ["owner"]) {
      const token = newDeviceToken();
      const record: DeviceRecord = {
        deviceId: `dev_${randomUUID()}`,
        label: label.trim() || "device",
        roles,
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
      };
      await store.saveDevice(record);
      options.log("info", "remote device issued", { deviceId: record.deviceId, label: record.label });
      return { deviceId: record.deviceId, label: record.label, roles, token };
    },

    async revokeDevice(deviceId) {
      const revoked = await store.revokeDevice(deviceId, new Date().toISOString());
      if (revoked) options.log("info", "remote device revoked", { deviceId });
      return revoked;
    },
  };
}
