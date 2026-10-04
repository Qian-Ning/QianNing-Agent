import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The record a running installation leaves for the next launch that loses the
 * single-instance lock.
 *
 * Electron scopes that lock to `userData`, so the record lives there too. A
 * data-directory copy would be the wrong place: a refused launch may be
 * pointing at a different data directory than the process that holds the lock
 * (the `PI_DESKTOP_DATA_DIR` override), and it is exactly that case where the
 * user has no way to see what happened.
 *
 * The record is advisory. A launch that holds the lock boots whether or not
 * the write succeeded; a launch that lost the lock treats a missing,
 * unreadable, or stale record as "no explanation available" rather than
 * inventing one.
 */
export const INSTALLATION_OWNER_FILE = "installation-owner.json";

export type InstallationOwner = {
  pid: number;
  version: string;
  startedAt: string;
};

export function installationOwnerPath(userDataDir: string): string {
  return join(userDataDir, INSTALLATION_OWNER_FILE);
}

export function serializeInstallationOwner(owner: InstallationOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

/**
 * All or nothing. A partially parsed record would let a refused launch name a
 * version that nobody is running, which is worse than naming nothing.
 *
 * The input is `unknown` on purpose: it arrives from `JSON.parse` of a file the
 * previous run wrote, so every field is narrowed here rather than trusted.
 */
export function parseInstallationOwner(raw: unknown): InstallationOwner | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { pid, version, startedAt } = raw as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof version !== "string" || version.length === 0) return undefined;
  if (typeof startedAt !== "string" || startedAt.length === 0) return undefined;
  return { pid, version, startedAt };
}

export function readInstallationOwner(userDataDir: string): InstallationOwner | undefined {
  try {
    return parseInstallationOwner(
      JSON.parse(readFileSync(installationOwnerPath(userDataDir), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/**
 * Best effort on purpose: the record only upgrades the next refusal's message,
 * so a read-only or full profile must not stop a launch that owns the lock.
 */
export function recordInstallationOwner(userDataDir: string, owner: InstallationOwner): void {
  try {
    writeFileSync(installationOwnerPath(userDataDir), serializeInstallationOwner(owner));
  } catch {
    // The next refused launch reports an unknown holder instead of a named one.
  }
}

/** What a launch that lost the lock can honestly say about the winner. */
export type RefusedLaunch = "unknown" | "same-version" | "other-version";

/**
 * `isAlive` is what keeps the record honest across an upgrade. The first build
 * that ships this file is not the first build a user runs, so a record can
 * outlive its process; naming that version would be a confident lie about a
 * process that is not there. A dead pid degrades to `unknown`, which is the
 * same answer as having no record at all.
 */
export function describeRefusedLaunch(
  owner: InstallationOwner | undefined,
  ownVersion: string,
  isAlive: (pid: number) => boolean,
): RefusedLaunch {
  if (!owner || !isAlive(owner.pid)) return "unknown";
  return owner.version === ownVersion ? "same-version" : "other-version";
}

export type InstallationClaim = {
  /** Whether this process may boot: it holds the profile, or owns its own. */
  held: boolean;
  /** The lock holder as it recorded itself; only meaningful when `held` is false. */
  owner: InstallationOwner | undefined;
  /** True when a different build holds the profile and the user must be told. */
  noticeDue: boolean;
};

export type InstallationClaimInput = {
  userDataDir: string;
  version: string;
  /**
   * False when this run owns its own data directory, which makes it its own
   * installation: the E2E harnesses, the capture rig, and side-by-side
   * profiles all point at their own root and must stay launchable while the
   * shipped app is running.
   */
  lockRequired: boolean;
  requestLock: () => boolean;
  pid?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
};

/**
 * Take the profile, or explain who has it.
 *
 * A run that owns its own data directory takes no lock and leaves no record:
 * it describes no installation, and writing its version into the shared
 * `userData` would make a later real refusal name a process that has nothing
 * to do with the collision.
 */
export function claimInstallation(input: InstallationClaimInput): InstallationClaim {
  if (!input.lockRequired) {
    return { held: true, owner: undefined, noticeDue: false };
  }
  if (!input.requestLock()) {
    const owner = readInstallationOwner(input.userDataDir);
    const isAlive = input.isAlive ?? isProcessAlive;
    return {
      held: false,
      owner,
      noticeDue: describeRefusedLaunch(owner, input.version, isAlive) !== "same-version",
    };
  }
  recordInstallationOwner(input.userDataDir, {
    pid: input.pid ?? process.pid,
    version: input.version,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  return { held: true, owner: undefined, noticeDue: false };
}

/**
 * Signal 0 asks the OS whether the pid exists without touching the process.
 * A permission error still means "there is something there".
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
