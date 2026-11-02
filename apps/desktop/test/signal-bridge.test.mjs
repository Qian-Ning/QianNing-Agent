import { after, test } from "node:test";
import assert from "node:assert/strict";
import { build, stop } from "esbuild";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
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
  The esbuild JS API keeps a service child process alive until `stop()` is
  called. A file that leaves it running never lets its own process exit, and
  node's runner waits on that process before it reports the file — on CI this
  reads as a suite that goes silent rather than a test that failed.
*/
after(() => stop());

/// A build that never settles would stall the whole file; fail it instead.
const BUILD_DEADLINE_MS = 30_000;

async function safeBuild(options) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`esbuild did not finish within ${BUILD_DEADLINE_MS}ms`)),
      BUILD_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([build(options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadModule() {
  process.env.PI_DESKTOP_SIGNAL_BRIDGE_PORT = String(PORT);
  const { outputFiles } = await safeBuild({
    entryPoints: [sourcePath],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "signal-bridge-"));
  const file = path.join(dir, "module.mjs");
  writeFileSync(file, outputFiles[0].text);
  return import(pathToFileURL(file).href);
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
