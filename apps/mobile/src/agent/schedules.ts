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

export type Schedule = {
  id: string;
  title: string;
  prompt: string;
  /** Interval in minutes; the UI offers a fixed set. */
  minutes: number;
  /** The conversation this task writes into; created on first run. */
  sessionId: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
};

const KEY = "qn.schedules";
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
    (entry.lastRunAt === null || typeof entry.lastRunAt === "number")
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

/** When this task is next allowed to run. */
export function dueAt(schedule: Schedule): number {
  return (schedule.lastRunAt ?? schedule.createdAt) + schedule.minutes * MINUTE;
}

export function isDue(schedule: Schedule, now: number): boolean {
  return schedule.enabled && now >= dueAt(schedule);
}

/** Drops every stored task; used by the page and by tests. */
export function clearSchedules(): Schedule[] {
  return write([]);
}

/** Test seam: forget the cache so a fresh localStorage is re-read. */
export function resetSchedulesForTests(): void {
  cache = null;
}
