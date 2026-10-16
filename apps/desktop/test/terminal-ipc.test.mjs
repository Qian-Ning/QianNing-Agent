import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC, IPC_WHITELIST } = await import("@pi-desktop/shared");
const { registerTerminalIpc } = await import("../electron/main/ipc/terminal-ipc.ts");

/**
 * A registrar double that captures the handlers so the test can drive the real
 * handler bodies, not just observe that a channel was registered.
 */
function captureRegistrar() {
  const handlers = new Map();
  return {
    handlers,
    registrar: {
      ipcMain: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      handleWithEvent: (channel, fn) => handlers.set(channel, fn),
      assertMainWindowSender: () => undefined,
    },
  };
}

const TERMINAL_CHANNELS = [
  IPC.invoke.terminalOpen,
  IPC.invoke.terminalInput,
  IPC.invoke.terminalResize,
  IPC.invoke.terminalClose,
];

test("every terminal channel is exposed to the preload gate", () => {
  for (const channel of TERMINAL_CHANNELS) {
    assert.equal(IPC_WHITELIST.has(channel), true, `${channel} must be in the IPC whitelist`);
  }
});

test("a local terminal call is refused with CAPABILITY_UNAVAILABLE, not an unhandled channel", async () => {
  const { handlers, registrar } = captureRegistrar();
  registerTerminalIpc({ registrar });
  for (const channel of TERMINAL_CHANNELS) {
    const handler = handlers.get(channel);
    assert.equal(typeof handler, "function", `${channel} must have a local handler`);
    // Drive the real handler body; it must refuse before reading its arguments,
    // so an argument-free call is enough.
    await assert.rejects(
      handler(),
      (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
      `${channel} must refuse a local call with CAPABILITY_UNAVAILABLE`,
    );
  }
});
