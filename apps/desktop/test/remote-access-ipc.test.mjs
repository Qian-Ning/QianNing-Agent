/**
 * The remote-access settings channels (ADR 0333 P1).
 *
 * Two things these pin that a UI test would not: a cold start has no listener
 * yet and must still answer — the settings page renders before anything has
 * been enabled — and every answer is a summary. Only `issueDevice` may carry a
 * token, and only because the Host has no second copy to read back later.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerRemoteIpc } = await import("../electron/main/ipc/remote-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

function harness(listener) {
  const handlers = new Map();
  registerRemoteIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      handleWithEvent: () => {},
      assertMainWindowSender: () => {},
    },
    getListener: () => listener,
  });
  return handlers;
}

function fakeListener({ running = false } = {}) {
  const devices = [
    {
      deviceId: "dev_1",
      label: "laptop",
      roles: ["owner"],
      tokenHash: "a".repeat(64),
      createdAt: "2026-10-27T00:00:00.000Z",
    },
  ];
  let started = running;
  let exposure = "loopback";
  const calls = [];
  return {
    devices,
    calls,
    async status() {
      return {
        running: started,
        ...(started ? { host: exposure === "lan" ? "0.0.0.0" : "127.0.0.1", port: 51234 } : {}),
        exposure,
        pairedDevices: 1,
      };
    },
    async start(requested) {
      calls.push(["start", requested]);
      started = true;
      exposure = requested;
      return { host: "127.0.0.1", port: 51234, protocol: requested === "lan" ? "https" : "http" };
    },
    async stop() {
      calls.push(["stop"]);
      started = false;
    },
    async listDevices() {
      return devices;
    },
    async issueDevice(label) {
      return { deviceId: "dev_2", label, roles: ["owner"], token: "pdt1.secret" };
    },
    async revokeDevice(deviceId) {
      return devices.some((device) => device.deviceId === deviceId);
    },
  };
}

test("answers off with no devices when the listener was never constructed", async () => {
  const handlers = harness(null);
  assert.deepEqual(await handlers.get(IPC.invoke.remoteStatus)(), {
    running: false,
    pairedDevices: 0,
    devices: [],
  });
  assert.deepEqual(await handlers.get(IPC.invoke.remoteDisable)(), {
    running: false,
    pairedDevices: 0,
    devices: [],
  });
  assert.deepEqual(await handlers.get(IPC.invoke.remoteRevokeDevice)({ deviceId: "dev_1" }), {
    revoked: false,
  });
  await assert.rejects(handlers.get(IPC.invoke.remoteEnable)());
});

test("reports the address once enabled and lists devices without their hashes", async () => {
  const handlers = harness(fakeListener());
  const status = await handlers.get(IPC.invoke.remoteEnable)();
  assert.equal(status.running, true);
  assert.equal(status.port, 51234);
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].label, "laptop");
  assert.equal("tokenHash" in status.devices[0], false);

  const stopped = await handlers.get(IPC.invoke.remoteDisable)();
  assert.equal(stopped.running, false);
});

test("a token comes back only from the issue channel", async () => {
  const handlers = harness(fakeListener());
  const issued = await handlers.get(IPC.invoke.remoteIssueDevice)({ label: "phone" });
  assert.equal(issued.token, "pdt1.secret");
  assert.equal(issued.label, "phone");

  const status = await handlers.get(IPC.invoke.remoteStatus)();
  assert.equal(JSON.stringify(status).includes("pdt1.secret"), false);

  // An empty label is a valid request now: the listener numbers the device, so a
  // user who does not want to invent names still gets a list they can read. The
  // channel passes the blank through untouched — trimming and numbering are the
  // listener's job, and one place deciding both is why they stay consistent.
  const unnamed = await handlers.get(IPC.invoke.remoteIssueDevice)({ label: "   " });
  assert.equal(unnamed.label, "   ");
});

test("choosing the local network starts a LAN listener, not a loopback one", async () => {
  const listener = fakeListener();
  const handlers = harness(listener);
  const status = await handlers.get(IPC.invoke.remoteEnable)({ exposure: "lan" });

  assert.deepEqual(listener.calls, [["start", "lan"]]);
  assert.equal(status.exposure, "lan");
});

test("switching modes stops the old bind first", async () => {
  const listener = fakeListener({ running: true });
  const handlers = harness(listener);
  await handlers.get(IPC.invoke.remoteEnable)({ exposure: "lan" });

  assert.deepEqual(listener.calls, [["stop"], ["start", "lan"]]);
});

test("enabling with no argument keeps today's loopback behaviour", async () => {
  const listener = fakeListener();
  const handlers = harness(listener);
  await handlers.get(IPC.invoke.remoteEnable)(undefined);

  assert.deepEqual(listener.calls, [["start", "loopback"]]);
});
