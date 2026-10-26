import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

test("the AppImage the workflow uploads is the one the audit declares", () => {
  // One file, three names: electron-builder writes `${productName}-${version}`
  // with a space, GitHub publishes that as a dot, and the updater feed carries
  // electron-builder's hyphenated safe form. The release workflow renames the
  // file, so its target has to be exactly what this audit expects — otherwise a
  // release with every artifact present fails its own asset check.
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const match = /dotted="([^"]+)"/.exec(workflow);
  assert.ok(match, "the release workflow should rename the AppImage");
  const produced = match[1].replace("${version}", VERSION);
  assert.ok(
    expectedAssets(VERSION).includes(produced),
    `${produced} is what the workflow uploads, and the audit does not declare it`,
  );
});

test("every build.linux key is one electron-builder accepts", () => {
  // electron-builder validates the whole `build` field before it starts any
  // platform job. An unknown key therefore fails every job at once — a
  // `linux.appImage` block that the schema never had turned four green platform
  // builds into four red ones. Unit tests are the only place this can be caught
  // before a tag, so the schema is read from the installed package.
  const pkg = JSON.parse(
    readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  const schemePath = createRequire(new URL("../apps/desktop/package.json", import.meta.url))
    .resolve("app-builder-lib/scheme.json");
  const scheme = JSON.parse(readFileSync(schemePath, "utf8"));
  const allowed = new Set(
    Object.keys(scheme.definitions.LinuxConfiguration.properties ?? {}),
  );
  const unknown = Object.keys(pkg.build?.linux ?? {}).filter((key) => !allowed.has(key));
  assert.deepEqual(
    unknown,
    [],
    `electron-builder would reject these linux keys: ${unknown.join(", ")}`,
  );
});
