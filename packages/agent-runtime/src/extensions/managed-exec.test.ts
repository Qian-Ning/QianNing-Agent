import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { managedExec } from "./managed-exec.js";

it("cancels an owned process tree after an explicit readiness signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-owned-exec-"));
  const ready = join(root, "ready.json");
  const owner = new AbortController();
  const childSource = `const fs=require('node:fs');const tmp=${JSON.stringify(ready)}+'.tmp';fs.writeFileSync(tmp,JSON.stringify([process.ppid,process.pid]));fs.renameSync(tmp,${JSON.stringify(ready)});setInterval(()=>{},1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const pending = managedExec(process.execPath, ["-e", parentSource], root, owner.signal);
  try {
    // Wait for a parseable payload rather than for the file to exist. Creating a
    // file and filling it are two steps, so an existence check can win the race
    // and read an empty or partial ready.json; the child now publishes it with a
    // rename, and this poll additionally refuses to settle for an incomplete read.
    let pids: number[] = [];
    await expect.poll(() => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(ready, "utf8"));
        if (Array.isArray(parsed) && parsed.every((pid): pid is number => typeof pid === "number")) {
          pids = parsed;
          return true;
        }
      } catch {
        // Not published yet — the rename has not completed.
      }
      return false;
    }, { timeout: 10_000, interval: 100 }).toBe(true);
    owner.abort();
    expect((await pending).killed).toBe(true);
    for (const pid of pids) await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }, { timeout: 10_000, interval: 100 }).toBe(false);
  } finally {
    owner.abort();
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("never starts an already-cancelled exec and keeps normal command output", async () => {
  const owner = new AbortController();
  expect(await managedExec(process.execPath, ["-e", "process.stdout.write('ok')"], tmpdir(), owner.signal))
    .toMatchObject({ stdout: "ok", code: 0, killed: false });
  owner.abort();
  expect(() => managedExec(process.execPath, ["-e", "process.exit(9)"], tmpdir(), owner.signal))
    .toThrow();
});
