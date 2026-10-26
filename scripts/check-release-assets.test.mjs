import assert from "node:assert/strict";
import test from "node:test";
import { auditAssets, expectedAssets, feedVersion } from "./check-release-assets.mjs";

const VERSION = "2.0.0";
const COMPLETE = expectedAssets(VERSION);

test("a complete declared set passes", () => {
  const result = auditAssets(VERSION, COMPLETE);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.feedMismatches, []);
  assert.equal(result.ok, true);
});

test("the declared set covers every platform the build matrix publishes", () => {
  for (const name of [
    "QianNing-Agent-Setup-2.0.0.exe",
    "QianNing-Agent-Portable-2.0.0.exe",
    "QianNing-Agent-2.0.0-arm64.dmg",
    "QianNing-Agent-2.0.0-x64-mac.zip",
    "QianNing.Agent-2.0.0.AppImage",
    "qianning-agent_2.0.0_amd64.deb",
    "qianning-agent-2.0.0-x86_64.rpm",
    "pi-host-2.0.0-linux-x64.tar.gz",
    "pi-host-2.0.0-linux-x64.tar.gz.sha256",
  ]) {
    assert.ok(COMPLETE.includes(name), `${name} should be declared`);
  }
});

test("one missing macOS architecture fails the audit", () => {
  const actual = COMPLETE.filter((name) => name !== "QianNing-Agent-2.0.0-arm64.dmg");
  const result = auditAssets(VERSION, actual);
  assert.deepEqual(result.missing, ["QianNing-Agent-2.0.0-arm64.dmg"]);
  assert.equal(result.ok, false);
});

test("a missing updater feed fails the audit", () => {
  const actual = COMPLETE.filter((name) => name !== "latest-linux.yml");
  const result = auditAssets(VERSION, actual);
  assert.deepEqual(result.missing, ["latest-linux.yml"]);
  assert.equal(result.ok, false);
});

test("a missing pi-host checksum fails the audit", () => {
  const actual = COMPLETE.filter((name) => name !== "pi-host-2.0.0-linux-x64.tar.gz.sha256");
  const result = auditAssets(VERSION, actual);
  assert.deepEqual(result.missing, ["pi-host-2.0.0-linux-x64.tar.gz.sha256"]);
});

test("extra intermediates do not fail the audit", () => {
  const result = auditAssets(VERSION, [...COMPLETE, "latest-mac-arm64.yml", "latest-mac-x64.yml"]);
  assert.equal(result.ok, true);
});

test("a feed declaring another version fails the audit", () => {
  const result = auditAssets(VERSION, COMPLETE, {
    "latest.yml": VERSION,
    "latest-mac.yml": "1.0.0",
    "latest-linux.yml": VERSION,
  });
  assert.deepEqual(result.feedMismatches, [{ feed: "latest-mac.yml", declared: "1.0.0", expected: VERSION }]);
  assert.equal(result.ok, false);
});

test("a missing feed is reported as missing rather than as a version mismatch", () => {
  const actual = COMPLETE.filter((name) => name !== "latest-mac.yml");
  const result = auditAssets(VERSION, actual, {});
  assert.deepEqual(result.feedMismatches, []);
  assert.ok(result.missing.includes("latest-mac.yml"));
});

test("feed parsing reads quoted and unquoted version lines", () => {
  assert.equal(feedVersion("version: 2.0.0\nfiles:\n  - url: x\n"), "2.0.0");
  assert.equal(feedVersion('version: "2.0.0"\n'), "2.0.0");
  assert.equal(feedVersion("files: []\n"), undefined);
});
