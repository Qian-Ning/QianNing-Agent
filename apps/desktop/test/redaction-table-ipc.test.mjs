/**
 * The redaction table row has to answer before any turn has run.
 *
 * A settings page opens on a cold start, when no sidecar exists yet because
 * nothing has prompted. Throwing there would leave the row stuck on its loading
 * state forever; reporting "off, zero rows" is the truth.
 *
 * The second half pins the forward direction: when a sidecar is present, both
 * channels must reach it under the method names the runtime dispatches on, and
 * the status channel must not invent a count of its own.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerRedactionIpc } = await import("../electron/main/ipc/redaction-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

function harness(sidecar) {
  const handlers = new Map();
  registerRedactionIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      handleWithEvent: () => {},
      assertMainWindowSender: () => {},
    },
    getSidecar: () => sidecar,
  });
  return handlers;
}

test("reports an empty table when no sidecar has started", async () => {
  const handlers = harness(null);
  assert.deepEqual(await handlers.get(IPC.invoke.redactionStatus)(), {
    enabled: false,
    count: 0,
    oldest: null,
    newest: null,
  });
  assert.deepEqual(await handlers.get(IPC.invoke.redactionClear)(), { cleared: 0 });
});

test("forwards both channels to the sidecar that owns the table", async () => {
  const calls = [];
  const sidecar = {
    call: async (method) => {
      calls.push(method);
      if (method === "redaction.status") {
        return { enabled: true, count: 3, oldest: 1_000, newest: 2_000 };
      }
      return { cleared: 3 };
    },
  };
  const handlers = harness(sidecar);

  assert.deepEqual(await handlers.get(IPC.invoke.redactionStatus)(), {
    enabled: true,
    count: 3,
    oldest: 1_000,
    newest: 2_000,
  });
  assert.deepEqual(await handlers.get(IPC.invoke.redactionClear)(), { cleared: 3 });
  assert.deepEqual(calls, ["redaction.status", "redaction.clear"]);
});
