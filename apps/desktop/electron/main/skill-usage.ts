import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Load counts for the bundled skills, kept beside the rest of the app's data.
 *
 * The point is evidence, not telemetry: after a few weeks of real use, the
 * counts answer which of the eighty-odd documents the model actually reaches
 * for, so pruning and merging stop being guesswork. Nothing is sent anywhere.
 *
 * The writer is best-effort by design. A usage counter must never fail a turn,
 * so an unwritable file or a corrupt one loses a batch of counts and nothing
 * else; the next load starts from a clean sheet.
 */

export const SKILL_USAGE_FILE = "skill-usage.json";
const FLUSH_DELAY_MS = 2_000;

export type SkillUsageRecord = {
  loads: number;
  lastLoadedAt: string;
};

export type SkillUsageFile = {
  version: 1;
  skills: Record<string, SkillUsageRecord>;
};

function emptyUsage(): SkillUsageFile {
  return { version: 1, skills: {} };
}

export function skillUsagePath(dataDir: string): string {
  return join(dataDir, SKILL_USAGE_FILE);
}

/** Read the file, discarding anything that does not match the known shape. */
export function readSkillUsage(dataDir: string): SkillUsageFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(skillUsagePath(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyUsage();
    const candidate = parsed as { version?: unknown; skills?: unknown };
    if (candidate.version !== 1 || !candidate.skills || typeof candidate.skills !== "object") {
      return emptyUsage();
    }
    const skills: Record<string, SkillUsageRecord> = {};
    for (const [id, value] of Object.entries(candidate.skills as Record<string, unknown>)) {
      if (!id || !value || typeof value !== "object") continue;
      const record = value as { loads?: unknown; lastLoadedAt?: unknown };
      const loads = Number(record.loads);
      if (!Number.isFinite(loads) || loads < 0) continue;
      skills[id] = {
        loads: Math.floor(loads),
        lastLoadedAt:
          typeof record.lastLoadedAt === "string" ? record.lastLoadedAt : new Date(0).toISOString(),
      };
    }
    return { version: 1, skills };
  } catch {
    return emptyUsage();
  }
}

type PendingUsage = {
  usage: SkillUsageFile;
  timer: NodeJS.Timeout | null;
};

const pendingByPath = new Map<string, PendingUsage>();

function flush(path: string): void {
  const pending = pendingByPath.get(path);
  if (!pending) return;
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(pending.usage, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch {
    // Deliberately swallowed: see the module note.
  }
  pendingByPath.delete(path);
}

/** Count one successful load. Flushed on a short delay to avoid a write per tool call. */
export function recordSkillLoad(dataDir: string, id: string, now: Date = new Date()): void {
  const path = skillUsagePath(dataDir);
  const pending = pendingByPath.get(path) ?? { usage: readSkillUsage(dataDir), timer: null };
  const previous = pending.usage.skills[id];
  pending.usage.skills[id] = {
    loads: (previous?.loads ?? 0) + 1,
    lastLoadedAt: now.toISOString(),
  };
  if (!pending.timer) {
    pending.timer = setTimeout(() => flush(path), FLUSH_DELAY_MS);
    pending.timer.unref?.();
  }
  pendingByPath.set(path, pending);
}

/** Write every pending count now. Tests and shutdown paths use this. */
export function flushSkillUsage(): void {
  for (const path of [...pendingByPath.keys()]) flush(path);
}
