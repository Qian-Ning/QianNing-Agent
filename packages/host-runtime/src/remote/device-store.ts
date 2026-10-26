/**
 * Durable device credentials for the desktop listener (ADR 0333 §4).
 *
 * Only the SHA-256 of a device token is written; the token itself is shown once
 * when it is issued and never stored, so a copy of this file cannot be replayed
 * against the Host. Writes are serialized and go through a temp file plus a
 * rename, because a half-written credential file costs the user every paired
 * device.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DeviceCredentialStore, DeviceRecord, PairingRecord } from "@pi-desktop/racp";

type FileShape = {
  version: 1;
  devices: DeviceRecord[];
  pairings: PairingRecord[];
};

const EMPTY: FileShape = { version: 1, devices: [], pairings: [] };

export class FileCredentialStore implements DeviceCredentialStore {
  private cache: FileShape | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    if (this.cache) return this.cache;
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as Partial<FileShape>;
      this.cache = {
        version: 1,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [],
      };
    } catch {
      // Missing, unreadable or corrupt: start from empty rather than refusing to
      // serve. A revoked token cannot come back this way, because a missing file
      // revokes everything at once.
      this.cache = { ...EMPTY, devices: [], pairings: [] };
    }
    return this.cache;
  }

  /** One writer at a time; readers see the previous file until the rename lands. */
  private persist(mutate: (state: FileShape) => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      const state = await this.load();
      mutate(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temp, this.path);
    });
    return this.queue.then(() => undefined);
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    const state = await this.load();
    return state.devices.find((device) => device.tokenHash === tokenHash) ?? null;
  }

  async saveDevice(record: DeviceRecord): Promise<void> {
    await this.persist((state) => {
      const index = state.devices.findIndex((device) => device.deviceId === record.deviceId);
      if (index >= 0) state.devices[index] = record;
      else state.devices.push(record);
    });
  }

  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    await this.persist((state) => {
      const device = state.devices.find((entry) => entry.deviceId === deviceId);
      if (device) device.lastSeenAt = seenAt;
    });
  }

  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    let found = false;
    await this.persist((state) => {
      const device = state.devices.find((entry) => entry.deviceId === deviceId);
      if (!device || device.revokedAt) return;
      device.revokedAt = revokedAt;
      found = true;
    });
    return found;
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const state = await this.load();
    return [...state.devices];
  }

  async findPairing(tokenHash: string): Promise<PairingRecord | null> {
    const state = await this.load();
    return state.pairings.find((pairing) => pairing.tokenHash === tokenHash) ?? null;
  }

  async savePairing(record: PairingRecord): Promise<void> {
    await this.persist((state) => {
      const index = state.pairings.findIndex((pairing) => pairing.tokenHash === record.tokenHash);
      if (index >= 0) state.pairings[index] = record;
      else state.pairings.push(record);
    });
  }

  async consumePairing(tokenHash: string, consumedAt: string): Promise<boolean> {
    let consumed = false;
    await this.persist((state) => {
      const pairing = state.pairings.find((entry) => entry.tokenHash === tokenHash);
      if (!pairing || pairing.consumedAt) return;
      pairing.consumedAt = consumedAt;
      consumed = true;
    });
    return consumed;
  }
}
