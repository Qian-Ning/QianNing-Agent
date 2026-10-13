import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertCompatibilityIdentifiers,
  brandify,
  BRAND_RULES,
  COMPATIBILITY_IDENTIFIERS,
  normalizeVersions,
} from "./upstream-sync-audit.mjs";

const script = fileURLToPath(new URL("./upstream-sync-audit.mjs", import.meta.url));

function run(args, input) {
  try {
    const stdout = execFileSync("node", [script, ...args], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

test("the brand rules rename the product identity", () => {
  const cases = [
    ["PI-Desktop", "QianNing Agent"],
    ["PI Desktop", "QianNing Agent"],
    ["net.aiuo.pi-desktop", "com.qianning.agent"],
    ["~/.pi-desktop", "~/.qianning-agent"],
    [".pi-desktop-dev", ".qianning-agent-dev"],
    ["pi-desktop.desktop", "qianning-agent.desktop"],
    ["https://github.com/vastsa/PI-Desktop", "https://github.com/Qian-Ning/QianNing-Agent"],
    ["publisher: vastsa", "publisher: QianNing"],
    ["contact hhxk666@gmail.com", "contact qian-ning@foxmail.com"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(brandify(input), expected, input);
  }
});

test("the brand rules keep every compatibility identifier intact", () => {
  // These are the npm scope, the IPC channel prefix, and the environment
  // variable prefix the brand contract deliberately keeps from upstream.
  const upstream = [
    'import { PROTOCOL_VERSION } from "@pi-desktop/shared";',
    '  storageGet: "pi-desktop/storage/get",',
    "export const DATA_DIR = process.env.PI_DESKTOP_DATA_DIR;",
    "a PI-Desktop install under ~/.pi-desktop",
  ].join("\n");
  const branded = brandify(upstream);
  for (const { name, pattern } of COMPATIBILITY_IDENTIFIERS) {
    const kept = branded.match(pattern)?.length ?? 0;
    assert.ok(kept > 0, `${name} must survive branding`);
  }
  assert.ok(branded.includes("QianNing Agent"));
  assert.ok(branded.includes("~/.qianning-agent"));
  assert.doesNotThrow(() => assertCompatibilityIdentifiers(upstream, branded));
});

test("the data directory is branded even though it contains the channel prefix", () => {
  // `.pi-desktop/config` contains `pi-desktop/` as a substring; the channel
  // prefix is only protected when it stands on its own, so this must not throw
  // and must still rename the directory.
  assert.equal(brandify(".pi-desktop/config"), ".qianning-agent/config");
  assert.doesNotThrow(() =>
    assertCompatibilityIdentifiers(".pi-desktop/config", brandify(".pi-desktop/config")),
  );
});

test("a rule that eats a compatibility identifier is rejected", () => {
  const before = "pi-desktop/storage/get and PI_DESKTOP_DATA_DIR";
  const after = "qianning/storage/get and QIANNING_DATA_DIR";
  assert.throws(() => assertCompatibilityIdentifiers(before, after), /compatibility identifier/);
});

test("version normalization makes the two release lines comparable", () => {
  const ours = 'export const APP_VERSION = "0.20.0";';
  const theirs = 'export const APP_VERSION = "0.18.0-beta.7";';
  assert.equal(normalizeVersions(ours), normalizeVersions(theirs));
  assert.equal(normalizeVersions(ours), 'export const APP_VERSION = "<version>";');
  // A path or a sentence without a version keeps its text.
  assert.equal(normalizeVersions("apps/desktop/electron/main"), "apps/desktop/electron/main");
});

test("every rule is ordered and non-empty", () => {
  assert.ok(BRAND_RULES.length > 0);
  for (const rule of BRAND_RULES) {
    assert.ok(rule.from.length > 0 && rule.to.length > 0, JSON.stringify(rule));
    assert.ok(rule.why.length > 0, JSON.stringify(rule));
  }
  // The repository URL must be replaced before the bare publisher account,
  // otherwise "github.com/vastsa/PI-Desktop" would lose its path.
  const urlRule = BRAND_RULES.findIndex((rule) => rule.from === "github.com/vastsa/PI-Desktop");
  const accountRule = BRAND_RULES.findIndex((rule) => rule.from === "vastsa");
  assert.ok(urlRule !== -1 && accountRule !== -1 && urlRule < accountRule);
});

test("--self-test passes", () => {
  const result = run(["--self-test"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /self-test: \d+ checks passed/);
});

test("--apply brands stdin", () => {
  const result = run(["--apply"], "A PI-Desktop build\n");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "A QianNing Agent build\n");
});

test("--apply passes a compatibility identifier through unchanged", () => {
  // The shipped rules satisfy the guard, so the CLI must emit the identifier
  // as-is rather than refusing the file.
  const result = run(["--apply"], "@pi-desktop/shared\n");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "@pi-desktop/shared\n");
});

test("no mode prints usage and an unknown argument fails", () => {
  const usage = run([]);
  assert.equal(usage.code, 0);
  assert.match(usage.stdout, /usage:/);
  const bad = run(["--verify"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--verify needs an upstream ref/);
});

test("--verify and --inventory run against the upstream refs when they exist", (t) => {
  if (!refExists("upstream/main")) {
    t.skip("the upstream remote is not fetched in this checkout");
    return;
  }
  const verified = run(["--verify", "upstream/main"]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /identity rules alone:  \d+/);
  assert.match(verified.stdout, /not explained by rules: \d+/);

  const inventory = run(["--inventory", "upstream/main"]);
  assert.equal(inventory.code, 0, inventory.stderr);
  assert.match(inventory.stdout, /paths: \d+/);
  // Blobs must actually have been read; a parsed-nothing run would print 0.
  const blobs = Number(/blobs read: (\d+)/.exec(inventory.stdout)?.[1] ?? "0");
  assert.ok(blobs > 1000, `expected blobs to be read, got ${blobs}`);
});
