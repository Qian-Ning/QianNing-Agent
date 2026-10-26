/**
 * Every supported messaging channel must be able to persist its settings.
 *
 * The main process gates `messagingSetSection` with a hand-written allowlist of
 * section names. That allowlist drifted: Matrix and IRC shipped as supported
 * channels, with a panel, a transport and a receive loop, but the gate still
 * named only the four older channels (plus Home Assistant), so saving either
 * channel's form was refused with INVALID_PARAMS. A channel whose configuration
 * cannot be written is not a working channel, whatever its adapter does.
 *
 * The tests below therefore do not restate the allowlist — restating it is the
 * failure being fixed. They import the production handler and ask it to save the
 * section of every platform the renderer catalogue marks `supported`, deriving
 * both the platform list and the section keys from that catalogue. A channel
 * added to the catalogue is covered the moment it is marked supported, and the
 * day someone adds one without extending the gate the named test for that
 * channel goes red.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

// Lets `node --test` import the main-process TypeScript with its bundler-style
// specifiers, and stubs `electron` (which this process has no window for).
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { IPC } = await import("@pi-desktop/shared");
const agentHost = await import("@pi-desktop/agent-host");
const { registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts");
const { MESSAGING_PLATFORMS } = await import("../src/lib/messaging-platforms.ts");

const SUPPORTED = MESSAGING_PLATFORMS.filter((platform) => platform.support === "supported");
const SECTION_CHANNEL = IPC.invoke.messagingSetSection;

/** The handler as the desktop process registers it, over a recording host. */
function captureSetSectionHandler() {
  const handlers = new Map();
  const hostCalls = [];
  const host = {
    binaryPath: "fixture-host",
    call: async (method, payload) => {
      hostCalls.push({ method, payload });
      return { ok: true };
    },
  };
  registerSettingsIpc({
    registrar: {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
    },
    getHost: () => host,
    getSidecar: () => null,
    dataDir: "fixture-data",
    normalizeSettings: (settings) => settings,
    validateSettingsWrite: (settings) => settings,
    testNetworkProxy: async () => ({ ok: true }),
    applyNetworkProxyFromAppSettings: async () => undefined,
    currentNetworkProxy: () => null,
    applyApplicationMenuSettings: () => undefined,
    applyDeveloperMode: () => undefined,
    applyPreventScreenSleep: () => undefined,
    applyKeepAwakeWhileRunning: () => undefined,
    applyUpdatePreference: () => undefined,
    resolveEffectiveCommandShell: async () => ({ shell: "fixture" }),
  });
  const handler = handlers.get(SECTION_CHANNEL);
  assert.ok(handler, `no handler registered for ${SECTION_CHANNEL}`);
  return { handler, hostCalls };
}

test("the catalogue marks at least one platform supported", () => {
  // Guards the derivation itself: an empty filter would make every per-channel
  // test below vacuous.
  assert.ok(SUPPORTED.length > 0, "no platform is marked supported");
});

for (const platform of SUPPORTED) {
  test(`saving the ${platform.id} messaging section is accepted`, async () => {
    const { handler, hostCalls } = captureSetSectionHandler();
    const value = { format: platform.format, version: platform.version, endpoint: "" };

    const result = await handler({ section: platform.section, value });

    assert.deepEqual(result, { ok: true });
    // Accepted means written: the section reached `settings.set` under its own
    // key, unchanged, rather than being refused before the host was called.
    assert.deepEqual(hostCalls, [
      { method: "settings.set", payload: { [platform.section]: value } },
    ]);
  });
}

test("an unknown messaging settings section is still refused", async () => {
  const { handler, hostCalls } = captureSetSectionHandler();
  await assert.rejects(
    () => handler({ section: "messagingNotAChannel", value: {} }),
    (error) => error.errorCode === "INVALID_PARAMS",
  );
  assert.deepEqual(hostCalls, []);
});

test("the allowlist names exactly the sections the catalogue supports", () => {
  // Behaviour proves nothing is missing; this proves nothing is dead either —
  // a section the gate accepts that no supported platform writes is drift in the
  // other direction. The allowlist is read from the gate's own guard expression
  // and each identifier is resolved by importing the package it comes from, so
  // no section name is hard-coded here.
  const source = readFileSync(
    new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("IPC.invoke.messagingSetSection");
  assert.ok(start > 0, "the messagingSetSection handler is gone");
  const throwAt = source.indexOf("unknown messaging settings section", start);
  assert.ok(throwAt > start, "the section guard is gone");
  const guard = source.slice(start, throwAt);
  const identifiers = [
    // Any exported `*_SECTION` constant the guard names: the channels' own
    // `MESSAGING_*_SECTION`, and the shared receiver's
    // `INGRESS_WEBHOOK_RECEIVER_SECTION`, which is not a channel's name but is
    // accepted on the same path.
    ...new Set([...guard.matchAll(/[A-Z][A-Z0-9_]*_SECTION/g)].map((m) => m[0])),
  ];
  assert.ok(identifiers.length > 0, "the guard names no section constants");

  const accepted = identifiers.map((identifier) => {
    const section = agentHost[identifier];
    assert.equal(typeof section, "string", `${identifier} is not exported by @pi-desktop/agent-host`);
    return section;
  });

  assert.deepEqual(
    [...new Set(accepted)].sort(),
    SUPPORTED.map((platform) => platform.section).sort(),
  );
});
