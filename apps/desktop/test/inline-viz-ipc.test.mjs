import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC, IPC_WHITELIST } = await import("@pi-desktop/shared");
const { registerInlineVizIpc } = await import("../electron/main/ipc/inline-viz-ipc.ts");

/**
 * A registrar double that captures the handlers so the test can drive the real
 * handler bodies with a stubbed host.
 */
function captureRegistrar(host) {
  const handlers = new Map();
  return {
    handlers,
    registrar: {
      ipcMain: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      handleWithEvent: (channel, fn) => handlers.set(channel, fn),
      assertMainWindowSender: () => undefined,
    },
    getHost: () => host,
  };
}

const INLINE_VIZ_CHANNELS = [IPC.invoke.inlineVizList, IPC.invoke.inlineVizRead];

const meta = {
  id: "viz-1",
  sessionId: "session-1",
  title: "Usage chart",
  kind: "svg",
  createdAt: "2026-10-25T00:00:00.000Z",
};

test("both inline-viz channels are exposed to the preload gate", () => {
  for (const channel of INLINE_VIZ_CHANNELS) {
    assert.equal(IPC_WHITELIST.has(channel), true, `${channel} must be in the IPC whitelist`);
  }
  // Read-only surface: no write channel exists (ADR 0327).
  assert.equal("inlineVizWrite" in IPC.invoke, false);
});

test("list forwards to host-core inlineViz.list and returns the metas", async () => {
  const calls = [];
  const host = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { visualizations: [meta] };
    },
  };
  const { handlers, registrar, getHost } = captureRegistrar(host);
  registerInlineVizIpc({ registrar, getHost });
  const handler = handlers.get(IPC.invoke.inlineVizList);
  assert.equal(typeof handler, "function");
  const result = await handler("session-1");
  assert.deepEqual(result, [meta]);
  assert.deepEqual(calls, [["inlineViz.list", { sessionId: "session-1" }]]);
});

test("read forwards to host-core inlineViz.read and returns the artifact", async () => {
  const calls = [];
  const host = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { visualization: { ...meta, content: "<svg/>" } };
    },
  };
  const { handlers, registrar, getHost } = captureRegistrar(host);
  registerInlineVizIpc({ registrar, getHost });
  const handler = handlers.get(IPC.invoke.inlineVizRead);
  assert.equal(typeof handler, "function");
  const result = await handler("session-1", "viz-1");
  assert.deepEqual(result, { ...meta, content: "<svg/>" });
  assert.deepEqual(calls, [
    ["inlineViz.read", { sessionId: "session-1", visualizationId: "viz-1" }],
  ]);
});

test("malformed arguments are rejected before the host is called", async () => {
  let called = false;
  const host = { call: async () => { called = true; return {}; } };
  const { handlers, registrar, getHost } = captureRegistrar(host);
  registerInlineVizIpc({ registrar, getHost });
  for (const [channel, args] of [
    [IPC.invoke.inlineVizList, [""]],
    [IPC.invoke.inlineVizList, [undefined]],
    [IPC.invoke.inlineVizRead, ["s", ""]],
    [IPC.invoke.inlineVizRead, ["", "viz"]],
  ]) {
    await assert.rejects(
      handlers.get(channel)(...args),
      (error) => error.errorCode === "INVALID_ARGUMENT",
      `${channel}(${JSON.stringify(args)}) must reject before the host call`,
    );
  }
  assert.equal(called, false);
});

test("a missing host refuses with HOST_UNAVAILABLE", async () => {
  const { handlers, registrar, getHost } = captureRegistrar(null);
  registerInlineVizIpc({ registrar, getHost });
  await assert.rejects(
    handlers.get(IPC.invoke.inlineVizList)("session-1"),
    (error) => error.errorCode === "HOST_UNAVAILABLE",
  );
});
