import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentHost } from "@pi-desktop/agent-host";

import type { HostRpc } from "../host-process.js";
import { createRemoteListener, type RemoteListener } from "./listener.js";

const dirs: string[] = [];
const listeners: RemoteListener[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qn-remote-"));
  dirs.push(dir);
  return dir;
}

const agentHost = {
  publishSessionChange: () => undefined,
  describeSession: () => ({}),
  registerConnection: () => undefined,
  unregisterConnection: () => undefined,
} as unknown as AgentHost;

function fakeHost(): HostRpc {
  return {
    call: async (method: string) => {
      if (method === "session.list") return { sessions: [] };
      if (method === "projects.list") return { projects: [] };
      throw new Error(`unexpected host call ${method}`);
    },
  } as unknown as HostRpc;
}

async function start(port?: number) {
  const listener = createRemoteListener({
    dataDir: await dataDir(),
    agentHost,
    serverVersion: "2.1.0",
    getHost: () => fakeHost(),
    compact: async () => ({ accepted: true }),
    isBusy: () => false,
    log: () => undefined,
    ...(port === undefined ? {} : { port }),
  });
  listeners.push(listener);
  const address = await listener.start();
  return { listener, base: `http://127.0.0.1:${address.port}` };
}

describe("desktop remote listener", () => {
  it("serves an operation to a device token it issued", async () => {
    const { listener, base } = await start();
    const device = await listener.issueDevice("test laptop");
    expect(device.token.startsWith("pdt1.")).toBe(true);

    const response = await fetch(`${base}/v1/sessions`, {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { result?: { sessions?: unknown[] } }).toMatchObject({
      result: { sessions: [] },
    });
  });

  it("refuses an unknown token and a missing one", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);
    const wrong = await fetch(`${base}/v1/sessions`, {
      headers: { authorization: "Bearer race_00000000000000000000000000000000" },
    });
    expect(wrong.status).toBe(401);
  });

  it("refuses a token after the device is revoked", async () => {
    const { listener, base } = await start();
    const device = await listener.issueDevice("phone");
    const headers = { authorization: `Bearer ${device.token}` };
    expect((await fetch(`${base}/v1/sessions`, { headers })).status).toBe(200);

    expect(await listener.revokeDevice(device.deviceId)).toBe(true);
    expect((await fetch(`${base}/v1/sessions`, { headers })).status).toBe(401);
    expect(await listener.revokeDevice(device.deviceId)).toBe(false);
  });

  it("keeps the token but stores only its hash", async () => {
    const { listener } = await start();
    const device = await listener.issueDevice("desk");
    const [record] = await listener.listDevices();
    expect(record.deviceId).toBe(device.deviceId);
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(device.token);
  });

  it("stops answering once the listener is stopped", async () => {
    const { listener, base } = await start();
    const device = await listener.issueDevice("tablet");
    await listener.stop();
    await expect(fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${device.token}` } })).rejects.toThrow();
    expect((await listener.status()).running).toBe(false);
  });

  it("reports the mode it is serving, not the one it was constructed with", async () => {
    const listener = createRemoteListener({
      dataDir: await dataDir(),
      agentHost,
      serverVersion: "2.1.0",
      getHost: () => fakeHost(),
      compact: async () => ({ accepted: true }),
      isBusy: () => false,
      log: () => undefined,
      // Constructed for the network, started for loopback: status must follow
      // the socket, not the option, or the settings card names the wrong mode.
      exposure: "lan",
    });
    listeners.push(listener);

    await listener.start("loopback");
    expect((await listener.status()).exposure).toBe("loopback");
  });
});

describe("remote listener port memory", () => {
  it("keeps the port it used last time", async () => {
    const dir = await dataDir();
    const make = () => {
      const listener = createRemoteListener({
        dataDir: dir,
        agentHost,
        serverVersion: "2.1.0",
        getHost: () => fakeHost(),
        compact: async () => ({ accepted: true }),
        isBusy: () => false,
        log: () => undefined,
      });
      listeners.push(listener);
      return listener;
    };

    const first = make();
    const started = await first.start();
    await first.stop();

    const second = make();
    const restarted = await second.start();

    // Without the remembered port the OS hands out a different free one, and a
    // link a phone already holds stops resolving with nothing to explain it.
    expect(restarted.port).toBe(started.port);
  });

  it("ignores a remembered port that is out of range", async () => {
    const dir = await dataDir();
    await mkdir(join(dir, "remote"), { recursive: true });
    await writeFile(join(dir, "remote", "port.json"), JSON.stringify({ port: 80 }), "utf8");

    const listener = createRemoteListener({
      dataDir: dir,
      agentHost,
      serverVersion: "2.1.0",
      getHost: () => fakeHost(),
      compact: async () => ({ accepted: true }),
      isBusy: () => false,
      log: () => undefined,
    });
    listeners.push(listener);

    const address = await listener.start();
    // 80 is privileged; a corrupt or tampered file must not make startup fail.
    expect(address.port).toBeGreaterThan(1023);
  });
});

describe("device labels", () => {
  it("numbers a device the user did not name", async () => {
    const { listener } = await start();

    const first = await listener.issueDevice("");
    const second = await listener.issueDevice("   ");

    // Both used to be called "device", which is a list nobody can act on: two
    // identical rows and no way to tell which one to revoke.
    expect(first.label).toBe("Device 1");
    expect(second.label).toBe("Device 2");
  });

  it("keeps a name the user typed", async () => {
    const { listener } = await start();
    const issued = await listener.issueDevice("  我的手机  ");
    expect(issued.label).toBe("我的手机");
  });

  it("skips a number that is already taken", async () => {
    const { listener } = await start();
    await listener.issueDevice("Device 1");
    const next = await listener.issueDevice("");
    // A typed "Device 1" must not collide with the generated series.
    expect(next.label).toBe("Device 2");
  });
});
