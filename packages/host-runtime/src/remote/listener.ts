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
import { hostname, networkInterfaces } from "node:os";
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
import { ensureCertificate } from "./tls.js";

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
  /**
   * Where the listener is reachable from. `loopback` (the default) keeps the
   * P1 behaviour; `lan` binds every interface and requires TLS, because a
   * phone on the same network is the reason this exists.
   */
  exposure?: "loopback" | "lan";
  /**
   * The client shell, when the host has one to serve. Passed through to the
   * binding untouched: this module knows how to listen, not what a page is.
   */
  serveStatic?: (pathname: string) => { body: string | Buffer; contentType: string } | null;
};

export type RemoteStatus = {
  running: boolean;
  host?: string;
  port?: number;
  /** `https` only in `lan` exposure; loopback listeners stay plaintext. */
  protocol?: "http" | "https";
  /** The URL a phone should open, when one can be derived. */
  url?: string;
  exposure?: "loopback" | "lan";
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
  /**
   * Opens the listener. `exposure` overrides the option for this start, because
   * the mode is the user's choice at the moment they turn it on, not a property
   * of the store that also holds the devices.
   */
  start(exposure?: "loopback" | "lan"): Promise<{ host: string; port: number; protocol: "http" | "https" }>;
  stop(): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  issueDevice(label: string, roles?: RacpRole[]): Promise<IssuedDevice>;
  revokeDevice(deviceId: string): Promise<boolean>;
  /** Removes a revoked device record. An active device must be revoked first. */
  deleteDevice(deviceId: string): Promise<boolean>;
  /** Clears every revoked device at once; returns how many were removed. */
  deleteRevokedDevices(): Promise<number>;
};

const LOOPBACK = "127.0.0.1";
const EVERY_INTERFACE = "0.0.0.0";

/**
 * A label for a device the user did not name.
 *
 * Every unnamed device used to be called "device", which turned the device list
 * into a column of identical rows: no way to tell one phone from another, and no
 * safe way to revoke the right one. Numbering makes the default label distinct
 * on its own, and a name the user typed is always kept as typed.
 */
function nextDeviceLabel(existing: readonly { label: string }[]): string {
  const used = new Set(existing.map((device) => device.label));
  for (let index = 1; ; index += 1) {
    const candidate = `Device ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Non-loopback IPv4 addresses this machine currently holds.
 *
 * A certificate names addresses, so this is also what the SAN is built from;
 * a phone that reaches the desktop under a different address than the one in
 * the SAN gets a handshake failure with no useful explanation.
 */
function lanAddresses(): string[] {
  type Entry = { address: string; family: string | number; internal: boolean };
  const interfaces = networkInterfaces() as unknown as Record<string, Entry[] | undefined>;
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (String(entry.family) === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses.sort();
}

export function createRemoteListener(options: RemoteListenerOptions): RemoteListener {
  const remoteDir = join(options.dataDir, "remote");
  const store = new FileCredentialStore(join(remoteDir, "devices.json"));
  const authenticator = new DeviceTokenAuthenticator(store);
  let binding: HttpBinding | null = null;
  let server: RacpServer | null = null;
  let publicUrl: string | null = null;
  /**
   * The mode the listener is actually serving. `options.exposure` is only the
   * default: `start(exposure)` overrides it, and a status that reported the
   * constructor's value would tell the settings card the wrong mode while a
   * LAN socket was open.
   */
  let activeExposure: "loopback" | "lan" | null = null;

  /**
   * The port this listener used last time.
   *
   * The OS hands out a new free port on every start, which silently breaks every
   * link and bookmark that pointed at the old one — the phone keeps a pairing
   * link, and that link stops working for a reason nothing on screen explains.
   * Remembering the port keeps a paired phone paired.
   */
  const readPort = async (): Promise<number> => {
    try {
      const raw = await readFile(join(remoteDir, "port.json"), "utf8");
      const parsed = JSON.parse(raw) as { port?: unknown };
      const port = parsed.port;
      if (typeof port === "number" && Number.isInteger(port) && port > 1023 && port < 65536) {
        return port;
      }
    } catch {
      // Missing or unreadable: no preference, which is not an error.
    }
    return 0;
  };

  const writePort = async (port: number): Promise<void> => {
    if (port <= 0) return;
    try {
      await mkdir(remoteDir, { recursive: true });
      await writeFile(join(remoteDir, "port.json"), JSON.stringify({ port }), "utf8");
    } catch (error) {
      // A listener that works but forgets its port is better than one that fails
      // to start because a preferences file could not be written.
      options.log("warn", "remote listener could not remember its port", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
        ...(binding
          ? {
              host: binding.address.host,
              port: binding.address.port,
              protocol: binding.address.protocol,
              url: publicUrl ?? undefined,
            }
          : {}),
        exposure: activeExposure ?? options.exposure ?? "loopback",
        pairedDevices: devices.filter((device) => !device.revokedAt).length,
      };
    },

    async start(requested) {
      if (binding) return binding.address;
      const exposure = requested ?? options.exposure ?? "loopback";
      const addresses = exposure === "lan" ? lanAddresses() : [];
      if (exposure === "lan" && addresses.length === 0) {
        throw Object.assign(new Error("this machine has no non-loopback IPv4 address to serve on"), {
          errorCode: "UNAVAILABLE",
        });
      }
      // A LAN bind is TLS-only (ADR 0333 §4): the certificate names the
      // addresses the phone will use, so it is minted from the same list the
      // listener will be reachable under.
      const tls =
        exposure === "lan"
          ? await ensureCertificate(join(remoteDir, "tls"), {
              hostnames: ["localhost", hostname()],
              addresses: [LOOPBACK, ...addresses],
            })
          : null;
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
      // Passed in rather than captured: a closure over the mutable `server` is
      // not narrowed by the assignment above, so the type would widen to null.
      const open = (port: number, srv: RacpServer) =>
        bindRacpHttp({
          server: srv,
          authenticator,
          host: exposure === "lan" ? EVERY_INTERFACE : LOOPBACK,
          port,
          ...(tls ? { tls, allowLan: true } : {}),
          ...(options.serveStatic ? { serveStatic: options.serveStatic } : {}),
          // The phone shell serves the client page from its own bundle, so its
          // requests arrive from a bundler origin rather than from this listener.
          // Only those origins are listed: a page on any other origin gets no
          // CORS headers and cannot read a reply, even with a stolen token.
          corsOrigins: ["https://localhost", "capacitor://localhost", "http://localhost"],
          log: options.log,
        });

      const preferred = options.port ?? (await readPort());
      try {
        binding = await open(preferred, server);
      } catch (error) {
        if (preferred === 0) throw error;
        // Something else holds the remembered port. Starting on a different one
        // is better than not starting, but it has to be visible: a phone holding
        // the old link will fail until it is re-paired.
        options.log("warn", "remote listener port busy, asking the OS", { port: preferred });
        binding = await open(0, server);
      }
      await writePort(binding.address.port);
      publicUrl = tls ? `https://${addresses[0]}:${binding.address.port}` : null;
      activeExposure = exposure;
      options.log("info", "remote listener started", { ...binding.address, exposure });
      return binding.address;
    },

    async stop() {
      if (binding) {
        await binding.close();
        binding = null;
      }
      server?.close();
      server = null;
      publicUrl = null;
      activeExposure = null;
      options.log("info", "remote listener stopped");
    },

    listDevices() {
      return store.listDevices();
    },

    async issueDevice(label, roles = ["owner"]) {
      const token = newDeviceToken();
      const trimmed = label.trim();
      const named = trimmed || nextDeviceLabel(await store.listDevices());
      const record: DeviceRecord = {
        deviceId: `dev_${randomUUID()}`,
        label: named,
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

    async deleteDevice(deviceId) {
      const removed = await store.deleteDevice(deviceId);
      if (removed) options.log("info", "remote device removed", { deviceId });
      return removed;
    },

    async deleteRevokedDevices() {
      const removed = await store.deleteRevokedDevices();
      if (removed > 0) options.log("info", "remote revoked devices cleared", { removed });
      return removed;
    },
  };
}
