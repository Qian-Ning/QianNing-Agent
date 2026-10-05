/**
 * One installation owns a `userData`, and the record it leaves is the only
 * thing a refused launch can tell the user about.
 *
 * Behavioral: a claim writes the holder's identity; a refusal reads it back and
 * decides whether the situation deserves a dialog. A record whose process is
 * gone, a record that cannot be parsed, and no record at all are the same
 * answer — an unknown holder — because naming a version nobody is running is
 * worse than naming none.
 *
 * Contract: a run that owns its own data directory takes no lock and leaves no
 * record, so an E2E harness or capture-rig version can never be read back as
 * the shipped installation's holder.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModule } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  INSTALLATION_OWNER_FILE,
  claimInstallation,
  describeRefusedLaunch,
  installationOwnerPath,
  parseInstallationOwner,
  readInstallationOwner,
  recordInstallationOwner,
  serializeInstallationOwner,
} = await import("../electron/main/bootstrap/installation-owner.ts");

const alive = () => true;
const dead = () => false;

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "qn-installation-owner-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a claim records the holder so the next refused launch can name it", () => {
  withTempDir((dir) => {
    const claim = claimInstallation({
      userDataDir: dir,
      version: "0.16.0",
      lockRequired: true,
      requestLock: () => true,
      pid: 4242,
      now: () => new Date("2026-10-04T00:00:00.000Z"),
      isAlive: alive,
    });

    assert.equal(claim.held, true);
    assert.equal(claim.noticeDue, false);
    assert.deepEqual(readInstallationOwner(dir), {
      pid: 4242,
      version: "0.16.0",
      startedAt: "2026-10-04T00:00:00.000Z",
    });
    assert.ok(readFileSync(installationOwnerPath(dir), "utf8").endsWith("\n"));
  });
});

test("a refused launch reports the holder it read", () => {
  withTempDir((dir) => {
    recordInstallationOwner(dir, { pid: 7, version: "0.15.8", startedAt: "2026-10-01T00:00:00.000Z" });

    const claim = claimInstallation({
      userDataDir: dir,
      version: "0.16.0",
      lockRequired: true,
      requestLock: () => false,
      isAlive: alive,
    });

    assert.equal(claim.held, false);
    assert.equal(claim.noticeDue, true);
    assert.equal(claim.owner?.version, "0.15.8");
  });
});

test("an identical build raises no notice, because surfacing it is the answer", () => {
  withTempDir((dir) => {
    recordInstallationOwner(dir, { pid: 7, version: "0.16.0", startedAt: "2026-10-04T00:00:00.000Z" });

    const claim = claimInstallation({
      userDataDir: dir,
      version: "0.16.0",
      lockRequired: true,
      requestLock: () => false,
      isAlive: alive,
    });

    assert.equal(claim.held, false);
    assert.equal(claim.noticeDue, false);
  });
});

test("a run with its own data directory neither takes the lock nor records", () => {
  withTempDir((dir) => {
    let requested = false;
    const claim = claimInstallation({
      userDataDir: dir,
      version: "0.16.0",
      lockRequired: false,
      requestLock: () => {
        requested = true;
        return false;
      },
    });

    assert.equal(claim.held, true);
    assert.equal(claim.noticeDue, false);
    assert.equal(requested, false, "an own-directory run must not request the lock");
    assert.throws(
      () => readFileSync(installationOwnerPath(dir), "utf8"),
      "an own-directory run must leave no record of the installation",
    );
  });
});

test("a record from a process that is gone degrades to an unknown holder", () => {
  const owner = { pid: 7, version: "0.15.8", startedAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(describeRefusedLaunch(owner, "0.16.0", dead), "unknown");
});

test("no record and an unreadable record are the same answer", () => {
  withTempDir((dir) => {
    assert.equal(readInstallationOwner(dir), undefined);
    assert.equal(describeRefusedLaunch(undefined, "0.16.0", alive), "unknown");

    writeFileSync(installationOwnerPath(dir), "{ this is not json");
    assert.equal(readInstallationOwner(dir), undefined);
  });
});

test("a partial record is rejected rather than half-trusted", () => {
  assert.equal(parseInstallationOwner({}), undefined);
  assert.equal(parseInstallationOwner({ pid: 7 }), undefined);
  assert.equal(parseInstallationOwner({ pid: 7, version: "0.16.0" }), undefined);
  assert.equal(parseInstallationOwner({ pid: 0, version: "0.16.0", startedAt: "t" }), undefined);
  assert.equal(parseInstallationOwner({ pid: 7, version: "", startedAt: "t" }), undefined);
  assert.equal(parseInstallationOwner({ pid: 7.5, version: "0.16.0", startedAt: "t" }), undefined);
  assert.equal(parseInstallationOwner(null), undefined);
  assert.equal(parseInstallationOwner("0.16.0"), undefined);
});

test("the record round-trips through its own serializer", () => {
  const owner = { pid: 12, version: "0.16.0", startedAt: "2026-10-04T00:00:00.000Z" };
  assert.deepEqual(parseInstallationOwner(JSON.parse(serializeInstallationOwner(owner))), owner);
});

test("a record that cannot be written does not stop the launch that holds the lock", () => {
  const claim = claimInstallation({
    userDataDir: join(tmpdir(), "qn-installation-owner-does-not-exist", "nested"),
    version: "0.16.0",
    lockRequired: true,
    requestLock: () => true,
  });
  assert.equal(claim.held, true);
});

test("the refusal notice names the holder only from the catalog, never inline", async () => {
  const source = await readMainModule("bootstrap/installation-refusal.ts");
  assert.match(source, /catalogs\[resolveLocale\(/);
  assert.match(source, /strings\.alreadyRunningTitle/);
  assert.match(source, /strings\.alreadyRunningVersioned/);
  assert.match(source, /strings\.alreadyRunningUnversioned/);
  assert.match(source, /strings\.alreadyRunningDismiss/);
  // A refused launch owns no window, tray, host, or sidecar, and never took the
  // lock, so it must not run the shared quit sequence on its way out.
  assert.match(source, /app\.exit\(0\)/);
  assert.doesNotMatch(source, /app\.quit\(\)/);
});
