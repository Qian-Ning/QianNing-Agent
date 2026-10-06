#!/usr/bin/env node
/**
 * Run the `test` script of every workspace package, one package at a time, and
 * report every failure instead of stopping at the first one.
 *
 * `pnpm -r --if-present test` stops at the first failing package: the packages
 * after it never run, so a single flaky suite hides whatever else is broken.
 * This runner keeps going, collects each package's exit code, and prints one
 * summary table plus the tail of each failing package's output.
 *
 * Usage:
 *   node scripts/test-all-packages.mjs [options]
 *   pnpm test:all-packages [-- options]
 *
 * Options:
 *   --only <substring>   Run only packages whose name contains <substring>.
 *                        Repeatable. Matches the package name, e.g.
 *                        `--only agent-runtime --only shared`.
 *   --no-build           Skip the `pnpm build:js` step up front.
 *   --quiet              Print the summary only, not per-package progress.
 *   --tail <lines>       Lines of a failing package's output to show (40).
 *   --help               Show this text.
 *
 * Exit code is 0 only when every selected package passed, so the runner is safe
 * to use from scripts and CI.
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- arguments ----------

const USAGE = `Run every workspace package's test script and report all failures.

Usage:
  node scripts/test-all-packages.mjs [options]

Options:
  --only <substring>   Run only packages whose name contains <substring>.
                       Repeatable: --only agent-runtime --only shared
  --no-build           Skip the \`pnpm build:js\` step up front.
  --quiet              Print the summary only, not per-package progress.
  --tail <lines>       Lines of a failing package's output to show (40).
  --help               Show this text.`;

const argv = process.argv.slice(2);
const opts = { only: [], build: true, quiet: false, tail: 40 };

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--') {
    // `pnpm <script> -- <args>` forwards the separator verbatim; skip it so the
    // documented invocation works as written.
    continue;
  }
  if (a === '--help' || a === '-h') {
    // Written synchronously: `process.exit` discards unflushed stdout, and the
    // help text is the entire point of this invocation.
    writeSync(1, `${USAGE}\n`);
    process.exit(0);
  } else if (a === '--only') {
    const v = argv[++i];
    if (!v) fail('--only needs a value');
    opts.only.push(v);
  } else if (a === '--no-build') {
    opts.build = false;
  } else if (a === '--quiet') {
    opts.quiet = true;
  } else if (a === '--tail') {
    const v = Number(argv[++i]);
    if (!Number.isInteger(v) || v < 0) fail('--tail needs a non-negative integer');
    opts.tail = v;
  } else {
    fail(`unknown option: ${a}`);
  }
}

function fail(message) {
  writeSync(2, `test-all-packages: ${message}\nRun with --help for usage.\n`);
  process.exit(2);
}

// ---------- workspace discovery ----------

/**
 * Read the `packages:` list out of pnpm-workspace.yaml.
 *
 * The file is YAML, but the block we need is a plain list of globs, so a small
 * reader keeps this script dependency-free. It understands the shape pnpm
 * accepts here: `packages:`, then `- <glob>` lines. If the block ever grows
 * anchors or inline flow syntax, switch to a real YAML parser rather than
 * extending this.
 */
function workspaceGlobs() {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const lines = text.split(/\r?\n/);
  const globs = [];
  let inside = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const m = line.match(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/);
    if (m) globs.push(m[1]);
  }

  if (globs.length === 0) fail('no package globs found in pnpm-workspace.yaml');
  return globs;
}

/** Expand a single-level workspace glob such as `packages/*` into directories. */
function expandGlob(glob) {
  if (!glob.includes('*')) return [join(ROOT, glob)];

  const parts = glob.split('/');
  const starAt = parts.indexOf('*');
  if (starAt === -1 || parts.indexOf('*', starAt + 1) !== -1) {
    fail(`unsupported glob (only one "*" segment is handled): ${glob}`);
  }

  const base = join(ROOT, ...parts.slice(0, starAt));
  if (!existsSync(base)) return [];

  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name, ...parts.slice(starAt + 1)));
}

/** Every workspace package that declares a `test` script, in workspace order. */
function collectPackages() {
  const seen = new Set();
  const found = [];

  for (const glob of workspaceGlobs()) {
    for (const dir of expandGlob(glob)) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;

      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (seen.has(pkg.name)) continue;
      seen.add(pkg.name);

      const script = pkg.scripts?.test;
      if (!script) {
        found.push({ name: pkg.name, dir, script: null });
        continue;
      }
      found.push({ name: pkg.name, dir, script });
    }
  }

  return found;
}

// ---------- running ----------

const scratch = mkdtempSync(join(tmpdir(), 'qh-test-all-'));

function run(command, args, label) {
  const logPath = join(scratch, `${label.replace(/[^\w.-]/g, '_')}.log`);
  const fd = openSync(logPath, 'w');
  const started = Date.now();

  if (!opts.quiet) process.stdout.write(`  ${label} … `);

  let result;
  try {
    // Output goes to a file rather than a pipe: a suite that prints thousands
    // of lines should not be buffered in memory just to show a failure tail.
    //
    // stdin is inherited, not discarded: `node --test` refuses to run when its
    // stdin is not a tty, so closing it here would fail those suites for a
    // reason that has nothing to do with the code under test.
    result = spawnSync(command, args, {
      cwd: ROOT,
      stdio: [0, fd, fd],
      shell: process.platform === 'win32',
    });
  } finally {
    closeSync(fd);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { status: result.status ?? 1, seconds, logPath };
}

function readLog(logPath) {
  return readFileSync(logPath, 'utf8');
}

function tailOf(text, lines) {
  if (lines === 0) return '';
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** Pull the pass/fail counts a suite reports, when it reports any. */
function summaryLine(text) {
  const counts = {};
  for (const m of text.matchAll(/^#\s*(pass|fail|skip|todo)\s+(\d+)\s*$/gm)) {
    counts[m[1]] = Number(m[2]);
  }
  const tests = text.match(/(\d+)\s+passed/);
  const failed = text.match(/(\d+)\s+failed/);
  if (Object.keys(counts).length > 0) {
    return ['pass', 'fail', 'skip', 'todo']
      .filter((k) => counts[k] !== undefined)
      .map((k) => `${k}=${counts[k]}`)
      .join(' ');
  }
  if (tests) {
    return failed ? `passed=${tests[1]} failed=${failed[1]}` : `passed=${tests[1]}`;
  }
  return '';
}

/**
 * Lines naming the tests that actually failed.
 *
 * A tail of the output is useless for this: a TAP stream ends with the counters
 * and a vitest run ends with the file summary, so the one line that says *which*
 * test broke is thousands of lines above the end. Pull those out separately and
 * show them first.
 */
function failuresOf(text) {
  const found = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    const hit =
      /^not ok \d+/.test(line) || // node:test TAP
      /^\s*[✕×]\s/.test(line) || // vitest / mocha style per-test marker
      /^\s*FAIL\s+\S/.test(line) || // vitest failure header
      /^AssertionError:|^\s*AssertionError:/.test(line);
    if (hit) found.add(line.trim());
    if (found.size >= 25) break;
  }
  return [...found];
}

// ---------- main ----------

const selected = collectPackages().filter((p) => {
  if (opts.only.length === 0) return true;
  return opts.only.some((needle) => p.name.includes(needle));
});

const runnable = selected.filter((p) => p.script);
const withoutTest = selected.filter((p) => !p.script);

console.log(`\n=== test-all-packages ===`);
console.log(`workspace root : ${ROOT}`);
console.log(`packages       : ${runnable.length} with a test script`
  + (withoutTest.length ? `, ${withoutTest.length} without (skipped)` : ''));
if (opts.only.length) console.log(`filter         : ${opts.only.join(', ')}`);

// Suites driven by `node --test` and some package managers behave differently
// when stdin is not a terminal. Say so up front: a failure that comes from the
// runner's own plumbing is not a failure of the code under test, and the two
// look identical in the summary table.
if (!process.stdin.isTTY) {
  console.log('');
  console.log('note           : stdin is not a tty — suites that require a terminal');
  console.log('                 may fail for that reason alone. Run this from an');
  console.log('                 interactive shell when a failure looks unrelated.');
}

if (runnable.length === 0) {
  console.log('\nNothing to run.');
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

// `packages/shared/dist` is a build product. A fresh worktree does not have it,
// and every package that imports @pi-desktop/shared type-resolves against it,
// so build once unless the caller knows the tree is already built.
if (opts.build) {
  console.log('\n=== build ===');
  const built = run('pnpm', ['build:js'], 'build:js');
  if (built.status !== 0) {
    console.error('\nbuild:js failed — fixing that first, since every suite needs it.');
    console.error(tailOf(readLog(built.logPath), opts.tail));
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  }
  if (!opts.quiet) console.log('ok');
}

console.log('\n=== packages ===');

const results = [];
for (const pkg of runnable) {
  const r = run('pnpm', ['--filter', pkg.name, 'test'], pkg.name);
  const summary = summaryLine(readLog(r.logPath));
  results.push({ ...pkg, ...r, summary });

  if (!opts.quiet) {
    const verdict = r.status === 0 ? 'ok' : 'FAILED';
    console.log(`${verdict} (${r.seconds}s)${summary ? '  ' + summary : ''}`);
  }
}

// ---------- report ----------

const failures = results.filter((r) => r.status !== 0);

console.log('\n=== summary ===');
const width = Math.max(...results.map((r) => r.name.length), 12);
for (const r of results) {
  const verdict = r.status === 0 ? 'PASS' : 'FAIL';
  console.log(`  ${verdict}  ${r.name.padEnd(width)}  ${String(r.seconds).padStart(6)}s  ${r.summary}`);
}
for (const p of withoutTest) {
  console.log(`  ----  ${p.name.padEnd(width)}       -  (no test script)`);
}

if (failures.length > 0) {
  console.log(`\n=== ${failures.length} failing package(s) ===`);
  for (const f of failures) {
    const text = readLog(f.logPath);
    const named = failuresOf(text);

    console.log(`\n----- ${f.name} (exit ${f.status}) -----`);
    if (named.length > 0) {
      console.log('  failing tests:');
      for (const n of named) console.log(`    ${n}`);
    } else {
      console.log('  (no per-test failure marker found — see the tail below)');
    }
    console.log(`\n  last ${opts.tail} lines:`);
    console.log(tailOf(text, opts.tail));
  }
}

console.log(
  `\n${results.length - failures.length}/${results.length} packages passed`
  + (failures.length ? `; failing: ${failures.map((f) => f.name).join(', ')}` : ''),
);

rmSync(scratch, { recursive: true, force: true });

// `process.exit(code)` discards stdout that has not been flushed yet, which
// silently swallows the whole report when stdout is a file or a pipe. Set the
// code and let the process end on its own instead.
process.exitCode = failures.length > 0 ? 1 : 0;
