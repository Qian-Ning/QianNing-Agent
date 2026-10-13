#!/usr/bin/env node
/**
 * Upstream synchronization audit.
 *
 * This repository is a distribution of PI-Desktop. The tree is an upstream
 * base plus a local layer: brand identity (product name, application id, data
 * directory, publisher, repository URLs), the fork's own subsystems, and edits
 * to shared files.
 *
 * The two histories share no ancestor, so the sync state can only be judged by
 * comparing trees — never by version numbers, which run on independent lines.
 * This script makes that comparison reproducible and keeps the brand layer a
 * rule set instead of a set of hand edits.
 *
 * Usage:
 *   node scripts/upstream-sync-audit.mjs --apply
 *   node scripts/upstream-sync-audit.mjs --verify <upstream-ref>
 *   node scripts/upstream-sync-audit.mjs --inventory <upstream-base-ref> [--out <dir>]
 *   node scripts/upstream-sync-audit.mjs --self-test
 *
 * Modes:
 *   --apply      Read an upstream file on stdin, write the branded file to
 *                stdout. This is the replay primitive: a new upstream file is
 *                branded by running it through here, not by editing it by hand.
 *   --verify     For every path that exists both here and at <ref> with
 *                different content, report how many are explained by the rule
 *                set alone. `identity` means the brand rules are enough;
 *                `identity+version` also normalizes version strings, which
 *                legitimately differ between the two lines.
 *   --inventory  Attribute every path to who changed it since <upstream-base-ref>:
 *                ours alone, upstream alone, both, or neither. This is the
 *                measurement behind docs/project/upstream-sync-assessment.md.
 *   --self-test  Run the rule set against its inline fixtures.
 *
 * Exit codes: 0 on success, 1 on a failed check or a usage error. `--verify`
 * and `--inventory` are reports, not gates: they exit 0 whenever they ran.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Ordered identity substitutions, applied to upstream text.
 *
 * Order matters: the repository URL is replaced before the bare publisher
 * account, and the Linux desktop entry before the data-directory form.
 */
export const BRAND_RULES = [
  {
    from: "net.aiuo.pi-desktop",
    to: "com.qianning.agent",
    why: "application id",
  },
  {
    from: "github.com/vastsa/PI-Desktop",
    to: "github.com/Qian-Ning/QianNing-Agent",
    why: "repository url",
  },
  {
    from: "PI-Desktop",
    to: "QianNing Agent",
    why: "product name",
  },
  {
    from: "PI Desktop",
    to: "QianNing Agent",
    why: "product name, spaced",
  },
  {
    from: "pi-desktop.desktop",
    to: "qianning-agent.desktop",
    why: "Linux desktop entry",
  },
  {
    from: ".pi-desktop-dev",
    to: ".qianning-agent-dev",
    why: "development data directory",
  },
  {
    from: ".pi-desktop",
    to: ".qianning-agent",
    why: "installed data directory",
  },
  {
    from: "hhxk666@gmail.com",
    to: "qian-ning@foxmail.com",
    why: "publisher email",
  },
  {
    from: "vastsa",
    to: "QianNing",
    why: "publisher account",
  },
];

/**
 * Identifiers the brand contract deliberately keeps from upstream. A brand
 * rule that rewrites any of these is a bug: they are npm scopes, IPC channel
 * prefixes, and environment variables that other processes depend on.
 * See CONTRIBUTING.md, "Brand and compatibility".
 *
 * These are patterns rather than plain strings because the data directory is
 * `.pi-desktop`, whose path form would otherwise match the IPC channel prefix
 * `pi-desktop/` as a substring. Only a channel prefix that stands on its own
 * counts — one preceded by a dot or an identifier character does not.
 */
export const COMPATIBILITY_IDENTIFIERS = [
  { name: "@pi-desktop/ npm scope", pattern: /@pi-desktop\//g },
  { name: "pi-desktop/ IPC channel prefix", pattern: /(?<![.\w-])pi-desktop\//g },
  { name: "PI_DESKTOP_ environment variable prefix", pattern: /PI_DESKTOP_/g },
];

/** Apply the identity rules to upstream text. */
export function brandify(text, rules = BRAND_RULES) {
  let out = text;
  for (const rule of rules) {
    out = out.split(rule.from).join(rule.to);
  }
  return out;
}

function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

/**
 * Throw when a rule set rewrote a compatibility identifier.
 *
 * `before` is the upstream text and `after` the branded text; an identifier
 * occurring fewer times afterwards is a contract break. The data directory is
 * exempt by construction — see COMPATIBILITY_IDENTIFIERS.
 */
export function assertCompatibilityIdentifiers(
  before,
  after,
  identifiers = COMPATIBILITY_IDENTIFIERS,
) {
  for (const { name, pattern } of identifiers) {
    const kept = countMatches(after, pattern);
    const had = countMatches(before, pattern);
    if (kept < had) {
      throw new Error(
        `the brand rules rewrote the compatibility identifier ${name} ` +
          `(${had} before, ${kept} after); it must survive branding ` +
          "(CONTRIBUTING.md, Brand and compatibility)",
      );
    }
  }
}

/** Replace version strings with a placeholder, for like-for-like comparison. */
export function normalizeVersions(text) {
  return text.replace(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/g, "<version>");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBuffer(args, input) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Map every tracked path at `ref` to its blob object id. */
function tree(ref) {
  const out = git(["ls-tree", "-r", ref]);
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [meta, path] = line.split("\t");
    const sha = meta.split(" ")[2];
    map.set(path, sha);
  }
  return map;
}

/** Read many blobs in one `git cat-file --batch` call. */
function readBlobs(shas) {
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) return new Map();
  const buf = gitBuffer(["cat-file", "--batch"], Buffer.from(`${wanted.join("\n")}\n`));
  const blobs = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString("utf8").split(" ");
    if (header.length !== 3) break;
    const [, , size] = header;
    const start = nl + 1;
    const end = start + Number(size);
    blobs.set(header[0], buf.subarray(start, end));
    pos = end + 1;
  }
  return blobs;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0x00);
}

function verify(ref) {
  const ours = tree("HEAD");
  const theirs = tree(ref);
  const shared = [...ours.keys()].filter((path) => theirs.has(path));
  const differing = shared.filter((path) => ours.get(path) !== theirs.get(path));
  const blobs = readBlobs([
    ...differing.map((path) => ours.get(path)),
    ...differing.map((path) => theirs.get(path)),
  ]);

  let identity = 0;
  let identityVersion = 0;
  let binary = 0;
  let neither = 0;
  const unexplained = [];
  for (const path of differing) {
    const mine = blobs.get(ours.get(path));
    const upstream = blobs.get(theirs.get(path));
    if (isBinary(mine) || isBinary(upstream)) {
      binary += 1;
      continue;
    }
    const oursText = mine.toString("utf8");
    const theirsText = upstream.toString("utf8");
    const branded = brandify(theirsText);
    assertCompatibilityIdentifiers(theirsText, branded);
    if (branded === oursText) {
      identity += 1;
      continue;
    }
    if (normalizeVersions(branded) === normalizeVersions(oursText)) {
      identityVersion += 1;
      continue;
    }
    neither += 1;
    if (unexplained.length < 15) unexplained.push(path);
  }

  console.log(`upstream ref: ${ref}`);
  console.log(`shared paths: ${shared.length}`);
  console.log(`content differs: ${differing.length}`);
  console.log(`  identity rules alone:  ${identity}`);
  console.log(`  identity + version:    ${identityVersion}`);
  console.log(`  binary:                ${binary}`);
  console.log(`  not explained by rules: ${neither}`);
  if (unexplained.length > 0) {
    console.log("  first unexplained paths:");
    for (const path of unexplained) console.log(`    ${path}`);
  }
}

const ATTRIBUTIONS = [
  "ours-new",
  "theirs-new",
  "both-changed",
  "ours-only-changed",
  "theirs-only",
  "both-added",
  "same",
];

function inventory(base, outDir) {
  const ours = tree("HEAD");
  const theirs = tree("upstream/main");
  const basis = tree(base);
  const paths = new Set([...ours.keys(), ...theirs.keys(), ...basis.keys()]);
  const blobs = readBlobs([
    ...[...paths].flatMap((path) => [ours.get(path), theirs.get(path), basis.get(path)]),
  ].filter(Boolean));

  const buckets = new Map(ATTRIBUTIONS.map((name) => [name, []]));
  for (const path of [...paths].sort()) {
    const a = ours.get(path);
    const b = theirs.get(path);
    const c = basis.get(path);
    let name;
    if (a && !b) name = "ours-new";
    else if (b && !a) name = "theirs-new";
    else if (a && b && !c) name = a === b ? "same" : "both-added";
    else if (a === b) name = "same";
    else if (a !== c && b !== c) name = "both-changed";
    else if (a !== c) name = "ours-only-changed";
    else name = "theirs-only";
    buckets.get(name).push(path);
  }

  console.log(`upstream base: ${base}`);
  console.log(`paths: ${paths.size}`);
  for (const name of ATTRIBUTIONS) {
    const list = buckets.get(name);
    if (list.length > 0) console.log(`  ${name.padEnd(18)} ${list.length}`);
  }

  // A path both sides changed is the replay conflict zone; its size is the
  // number the assessment document quotes.
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const name of ATTRIBUTIONS) {
      writeFileSync(`${outDir}/${name}.txt`, `${buckets.get(name).join("\n")}\n`, "utf8");
    }
    console.log(`wrote ${ATTRIBUTIONS.length} lists to ${outDir}`);
  }
  // Confirms blobs were actually read, so a quiet run cannot hide a parse bug.
  console.log(`blobs read: ${blobs.size}`);
}

function selfTest() {
  const checks = [
    ["product name", brandify("PI-Desktop"), "QianNing Agent"],
    ["application id", brandify("net.aiuo.pi-desktop"), "com.qianning.agent"],
    ["data directory", brandify("~/.pi-desktop"), "~/.qianning-agent"],
    ["dev data directory", brandify(".pi-desktop-dev"), ".qianning-agent-dev"],
    ["linux entry", brandify("pi-desktop.desktop"), "qianning-agent.desktop"],
    [
      "repository url",
      brandify("https://github.com/vastsa/PI-Desktop"),
      "https://github.com/Qian-Ning/QianNing-Agent",
    ],
    ["publisher", brandify("author: vastsa"), "author: QianNing"],
    ["npm scope kept", brandify("@pi-desktop/shared"), "@pi-desktop/shared"],
    ["ipc channel kept", brandify("pi-desktop/storage/get"), "pi-desktop/storage/get"],
    ["env variable kept", brandify("PI_DESKTOP_DATA_DIR"), "PI_DESKTOP_DATA_DIR"],
  ];
  let failed = 0;
  for (const [name, got, want] of checks) {
    if (got !== want) {
      failed += 1;
      console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  // The guard must fire when a rule eats a compatibility identifier, otherwise
  // it proves nothing about the rules actually shipped above. It must not fire
  // for the data directory, which branding is free to rename.
  let guardChecks = 0;
  try {
    assertCompatibilityIdentifiers("net.aiuo.pi-desktop @pi-desktop/x", "com.qianning.agent x");
    failed += 1;
    console.error("FAIL the compatibility guard did not fire on a rewritten identifier");
  } catch {
    guardChecks += 1;
  }
  try {
    assertCompatibilityIdentifiers(".pi-desktop/config", ".qianning-agent/config");
    guardChecks += 1;
  } catch {
    failed += 1;
    console.error("FAIL the guard fired on the data directory, which branding may rename");
  }
  if (failed > 0) {
    console.error(`${failed} self-test check(s) failed`);
    process.exit(1);
  }
  console.log(`self-test: ${checks.length + guardChecks} checks passed`);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const USAGE = `usage:
  node scripts/upstream-sync-audit.mjs --apply
  node scripts/upstream-sync-audit.mjs --verify <upstream-ref>
  node scripts/upstream-sync-audit.mjs --inventory <upstream-base-ref> [--out <dir>]
  node scripts/upstream-sync-audit.mjs --self-test`;

async function main(argv) {
  if (argv.includes("--self-test")) {
    selfTest();
    return 0;
  }
  if (argv.includes("--apply")) {
    const text = await readStdin();
    const branded = brandify(text);
    assertCompatibilityIdentifiers(text, branded);
    process.stdout.write(branded);
    return 0;
  }
  const verifyIndex = argv.indexOf("--verify");
  if (verifyIndex !== -1) {
    const ref = argv[verifyIndex + 1];
    if (!ref) throw new Error("--verify needs an upstream ref");
    verify(ref);
    return 0;
  }
  const inventoryIndex = argv.indexOf("--inventory");
  if (inventoryIndex !== -1) {
    const ref = argv[inventoryIndex + 1];
    if (!ref) throw new Error("--inventory needs an upstream base ref");
    const outIndex = argv.indexOf("--out");
    inventory(ref, outIndex === -1 ? undefined : argv[outIndex + 1]);
    return 0;
  }
  console.log(USAGE);
  return argv.length > 2 ? 1 : 0;
}

// Only run when invoked as a program: importing this module for its rules must
// have no side effects, and must never call process.exit on its importer.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
