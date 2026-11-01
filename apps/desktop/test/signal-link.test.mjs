import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/*
  The Signal link flow is the only channel that has a process to drive, so it
  gets a behavioural test rather than a source-level one: a stand-in CLI prints
  the real `sgnl://` shape, waits, then reports the account the way signal-cli
  does. What is asserted is the module's contract — a snapshot that moves
  starting → waiting → linked, and a missing binary that stays a fact.
*/

const sourcePath = path.resolve(
  import.meta.dirname,
  "../electron/main/messaging-signal-link.ts",
);

async function loadModule() {
  const { outputFiles } = await build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "signal-link-"));
  const file = path.join(dir, "module.mjs");
  writeFileSync(file, outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

function fakeCli(dir) {
  const script = path.join(dir, "fake-link.js");
  writeFileSync(
    script,
    [
      'console.log("sgnl://linkdevice?uuid=8f14e45f-ceea-467a-9c3f-0a1b2c3d4e5f&pub_key=Zm9vYmFy");',
      "setTimeout(() => {",
      '  console.log("Associated with: +15551234567");',
      "  process.exit(0);",
      "}, 400);",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    const wrapper = path.join(dir, "fake-signal-cli.cmd");
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(dir, "fake-signal-cli.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a scanned link reports the account the phone bound to", async () => {
  const link = await loadModule();
  const dir = mkdtempSync(path.join(tmpdir(), "signal-cli-"));
  const cli = fakeCli(dir);

  const started = await link.startSignalLink(cli);
  assert.equal(started.state, "waiting");
  assert.match(started.url, /^sgnl:\/\/linkdevice\?uuid=/);

  let snapshot = started;
  for (let attempt = 0; attempt < 40 && snapshot.state === "waiting"; attempt += 1) {
    await sleep(100);
    snapshot = link.signalLinkSnapshot();
  }

  assert.equal(snapshot.state, "linked");
  assert.equal(snapshot.account, "+15551234567");
});

test("a missing binary is reported, not inferred from an exit code", async () => {
  const link = await loadModule();
  const started = await link.startSignalLink("definitely-not-signal-cli-9f3a");
  assert.equal(started.state, "failed");
  assert.equal(started.reason, "missing-cli");
});

test("cancelling ends an attempt nobody scanned", async () => {
  const link = await loadModule();
  const dir = mkdtempSync(path.join(tmpdir(), "signal-cli-"));
  const cli = fakeCli(dir);

  const started = await link.startSignalLink(cli);
  assert.equal(started.state, "waiting");

  const cancelled = link.cancelSignalLink();
  assert.equal(cancelled.state, "failed");
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(link.signalLinkSnapshot().state, "failed");
});

test("the module owns its own source contract", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /sgnl:\\\/\\\/linkdevice/);
  assert.match(source, /process\.once\("exit"/);
});
