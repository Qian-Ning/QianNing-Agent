/**
 * Recurring tasks: a prompt the phone sends on a schedule.
 *
 * The interval is stored, not the cron string. A phone is asleep most of the
 * day, so "every 30 minutes" means "the first moment the app is awake after
 * that much time has passed", not "at :00 and :30". Two consequences follow and
 * are deliberate:
 *
 *   - a missed window is not replayed; the next tick simply runs once;
 *   - `lastRunAt` only advances on a successful send, so a provider failure
 *     leaves the task due instead of silently skipping a period.
 */

import { appStorage } from "../lib/app-storage";

/**
 * How a task repeats. The desktop page speaks clock times, not intervals, so a
 * task created there carries a cadence; the interval stays as the fallback for
 * a task created before this existed.
 */
export type ScheduleCadence = "manual" | "hourly" | "daily" | "weekly";

export type Schedule = {
  id: string;
  title: string;
  prompt: string;
  /** Interval in minutes; used when `cadence` is absent. */
  minutes: number;
  cadence?: ScheduleCadence;
  /** Clock time for `daily` and `weekly`. */
  hour?: number;
  minute?: number;
  /** Monday = 0, matching the desktop's weekly picker. */
  weekdays?: number[];
  /** The conversation this task writes into; created on first run. */
  sessionId: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
};

const KEY = "qn.schedules";
const RUNS_KEY = "qn.schedule.runs";
const MAX_RUNS = 50;
const MINUTE = 60_000;

let cache: Schedule[] | null = null;

function isSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.prompt === "string" &&
    typeof entry.minutes === "number" &&
    entry.minutes > 0 &&
    typeof entry.enabled === "boolean" &&
    typeof entry.createdAt === "number" &&
    (entry.sessionId === null || typeof entry.sessionId === "string") &&
    (entry.lastRunAt === null || typeof entry.lastRunAt === "number") &&
    (entry.cadence === undefined ||
      entry.cadence === "manual" ||
      entry.cadence === "hourly" ||
      entry.cadence === "daily" ||
      entry.cadence === "weekly")
  );
}

export function loadSchedules(): Schedule[] {
  if (cache) return cache;
  try {
    const raw = appStorage().get(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isSchedule) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: Schedule[]): Schedule[] {
  cache = next;
  try {
    appStorage().set(KEY, JSON.stringify(next));
  } catch {
    // The in-memory list still works for this session.
  }
  return next;
}

export function saveSchedule(schedule: Schedule): Schedule[] {
  const current = loadSchedules();
  const exists = current.some((entry) => entry.id === schedule.id);
  return write(exists ? current.map((entry) => (entry.id === schedule.id ? schedule : entry)) : current.concat(schedule));
}

export function createSchedule(input: { title: string; prompt: string; minutes: number; now?: number }): Schedule {
  const now = input.now ?? Date.now();
  return {
    id: "sched_" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    minutes: input.minutes,
    sessionId: null,
    enabled: true,
    createdAt: now,
    lastRunAt: null,
  };
}

export function removeSchedule(id: string): Schedule[] {
  return write(loadSchedules().filter((entry) => entry.id !== id));
}

export function toggleSchedule(id: string, enabled: boolean): Schedule[] {
  return write(loadSchedules().map((entry) => (entry.id === id ? { ...entry, enabled } : entry)));
}

/** Midnight-anchored clock time on a given offset from the anchor day. */
function clockAt(dayStart: number, hour: number, minute: number): number {
  const date = new Date(dayStart);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

/** Monday = 0, the way the desktop's weekly picker counts. */
function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** The next moment this task is allowed to run, in epoch milliseconds. */
export function dueAt(schedule: Schedule): number {
  const anchor = schedule.lastRunAt ?? schedule.createdAt;
  const cadence = schedule.cadence;
  if (!cadence) return anchor + schedule.minutes * MINUTE;
  if (cadence === "manual") return Number.POSITIVE_INFINITY;
  if (cadence === "hourly") return anchor + 60 * MINUTE;

  const hour = schedule.hour ?? 9;
  const minute = schedule.minute ?? 0;
  const at = clockAt(anchor, hour, minute);
  if (cadence === "daily") {
    // Same day when the clock time is still ahead of the anchor, else tomorrow.
    return at > anchor ? at : at + 24 * 60 * MINUTE;
  }

  // weekly: walk forward from the anchor's own day to the first selected
  // weekday whose clock time is still ahead of it.
  const days = new Set(
    schedule.weekdays?.length ? schedule.weekdays : [weekdayIndex(new Date(anchor))],
  );
  const startOfAnchorDay = new Date(anchor);
  startOfAnchorDay.setHours(0, 0, 0, 0);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = clockAt(startOfAnchorDay.getTime(), hour, minute) + offset * 24 * 60 * MINUTE;
    if (candidate <= anchor) continue;
    if (!days.has(weekdayIndex(new Date(candidate)))) continue;
    return candidate;
  }
  return clockAt(startOfAnchorDay.getTime(), hour, minute) + 7 * 24 * 60 * MINUTE;
}

export function isDue(schedule: Schedule, now: number): boolean {
  if (!schedule.enabled) return false;
  const next = dueAt(schedule);
  return Number.isFinite(next) && now >= next;
}

export type ScheduleRun = {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: "running" | "completed" | "aborted" | "error";
  errorCode: string | null;
  startedAt: string;
  endedAt: string | null;
};

let runCache: ScheduleRun[] | null = null;

export function loadRuns(): ScheduleRun[] {
  if (runCache) return runCache;
  try {
    const raw = appStorage().get(RUNS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    runCache = Array.isArray(parsed) ? (parsed as ScheduleRun[]) : [];
  } catch {
    runCache = [];
  }
  return runCache;
}

function writeRuns(next: ScheduleRun[]): ScheduleRun[] {
  runCache = next.slice(0, MAX_RUNS);
  try {
    appStorage().set(RUNS_KEY, JSON.stringify(runCache));
  } catch {
    // Keep the in-memory list for this session.
  }
  return runCache;
}

/** The most recent run for a task, so the page can show how it went last time. */
export function lastRunFor(taskId: string): ScheduleRun | null {
  return loadRuns().find((run) => run.taskId === taskId) ?? null;
}

export function startRun(input: { taskId: string; sessionId: string | null; at?: number }): ScheduleRun {
  const at = input.at ?? Date.now();
  const run: ScheduleRun = {
    id: "run_" + at.toString(36) + Math.random().toString(36).slice(2, 6),
    taskId: input.taskId,
    sessionId: input.sessionId,
    status: "running",
    errorCode: null,
    startedAt: new Date(at).toISOString(),
    endedAt: null,
  };
  writeRuns([run, ...loadRuns()]);
  return run;
}

export function finishRun(
  id: string,
  status: ScheduleRun["status"],
  options: { sessionId?: string | null; errorCode?: string | null; at?: number } = {},
): ScheduleRun[] {
  const at = options.at ?? Date.now();
  return writeRuns(
    loadRuns().map((run) =>
      run.id === id
        ? {
            ...run,
            status,
            endedAt: new Date(at).toISOString(),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
          }
        : run,
    ),
  );
}

/** Drops every stored task; used by the page and by tests. */
export function clearSchedules(): Schedule[] {
  return write([]);
}

/** Test seam: forget the cache so a fresh localStorage is re-read. */
export function resetSchedulesForTests(): void {
  cache = null;
  runCache = null;
}
