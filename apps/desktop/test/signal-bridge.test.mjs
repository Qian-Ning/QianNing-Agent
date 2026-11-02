import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/*
  The bridge is judged by one fact: does the port answer. These tests give it
  three worlds — a port already held, a daemon that comes up, and a daemon that
  dies because something else owns the port — and assert the snapshot each
  produces. A wrong answer here means the panel claims a channel works when it
  cannot receive anything.
*/

const sourcePath = path.resolve(
  import.meta.dirname,
  "../electron/main/messaging-signal-bridge.ts",
);

const PORT = 18931;

/*
  Node strips the module's types itself, so the test loads the source it is
  about instead of bundling a copy first. A bundler here would mean a build step
  in front of every assertion, and a stalled build would look like a suite that
  went quiet rather than a test that failed.

  The counter keeps each load a fresh module: the bridge holds process-wide
  state, and one test must not inherit the previous one's.
*/
let loads = 0;

async function loadModule() {
  process.env.PI_DESKTOP_SIGNAL_BRIDGE_PORT = String(PORT);
  loads += 1;
  return import(`${pathToFileURL(sourcePath).href}?load=${loads}`);
}


function fakeCli(dir, { listen }) {
  const script = path.join(dir, "fake-daemon.js");
  writeFileSync(
    script,
    listen
      ? [
          'const http = require("node:http");',
          "const port = Number(process.argv[process.argv.indexOf('--http') + 1].split(':')[1]);",
          "const server = http.createServer((_req, res) => res.end('ok'));",
          "server.listen(port, '127.0.0.1');",
          ""
        ].join("\n")
      : [
          'console.error("bind failed: address already in use");',
          "process.exit(1);",
          "",
        ].join("\n"),
  );
  if (process.platform === "win32") {
    const wrapper = path.join(dir, "fake-signal-daemon.cmd");
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(dir, "fake-signal-daemon.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function holdPort() {
  return new Promise((resolve) => {
    const server = createServer(() => undefined);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

function portAnswers() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/* A daemon killed in the previous test frees its port asynchronously. Waiting
   here keeps each case about its own setup instead of the previous one's
   teardown: a port that still answers reads as running, not as port-in-use. */
async function waitForPortFree(deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await portAnswers())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${PORT} never stopped answering`);
}

test("a port that already answers is reported as running, without spawning", async () => {
  const link = await loadModule();
  const server = await holdPort();
  try {
    const snapshot = await link.startSignalBridge({ account: "+15551234567" });
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.port, PORT);
    assert.equal(snapshot.reason, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    link.disposeSignalBridge();
  }
});

test("a daemon that opens the port is reported as running", async () => {
  const link = await loadModule();
  const dir = mkdtempSync(path.join(tmpdir(), "signal-cli-"));
  const cli = fakeCli(dir, { listen: true });

  const snapshot = await link.startSignalBridge({ account: "+15551234567", cliPath: cli });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.reason, null);

  link.stopSignalBridge();
  assert.equal(link.signalBridgeSnapshot().state, "idle");
});

test("a port already taken by another process fails as port-in-use", async () => {
  await waitForPortFree();
  const link = await loadModule();
  const dir = mkdtempSync(path.join(tmpdir(), "signal-cli-"));
  const cli = fakeCli(dir, { listen: false });

  const snapshot = await link.startSignalBridge({ account: "+15551234567", cliPath: cli });
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.reason, "port-in-use");
});

test("a missing binary is a fact, not a timeout", async () => {
  const link = await loadModule();
  const snapshot = await link.startSignalBridge({ cliPath: "definitely-not-signal-cli-77bd" });
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.reason, "missing-cli");
});

test("a daemon that dies while starting settles instead of waiting out the deadline", async () => {
  await waitForPortFree();
  const dir = mkdtempSync(path.join(tmpdir(), "signal-bridge-dying-"));
  const cli = fakeCli(dir, { listen: false });
  const link = await loadModule();
  const started = Date.now();
  const snapshot = await link.startSignalBridge({ cliPath: cli });
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.reason, "port-in-use");
  // The readiness deadline is far longer than this; landing on a reason proves
  // the close event reached the caller rather than the timer.
  assert.ok(Date.now() - started < 10_000);
});
