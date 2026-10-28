import { Capacitor, registerPlugin } from "@capacitor/core";
import { dueAt, loadSchedules, type Schedule } from "./schedules";

/**
 * System alarms for scheduled tasks.
 *
 * The client still owns the list; this module tells Android when to wake up and
 * post a reminder. The reminder is the point: this build cannot run an agent
 * turn without its WebView, so the alarm's job is to bring the reader back to
 * the app, where the ordinary runner takes over immediately.
 *
 * A sync replaces every alarm rather than diffing them. The list is tiny, and
 * "cancel all, place current" cannot drift after an edit, a delete, or a clock
 * change.
 */

type Bridge = {
  schedule(options: { id: string; at: number; title: string }): Promise<{ exact?: boolean }>;
  cancel(options: { id: string }): Promise<void>;
  cancelAll(): Promise<void>;
  info(): Promise<{ exact?: boolean; pending?: number }>;
};

const bridge = registerPlugin<Bridge>("ScheduleAlarms");

/**
 * When this task should next ring. A task that is already overdue rings at its
 * next period instead of instantly — the in-app runner is about to pick it up,
 * and two events for one window would double-run it.
 */
export function nextAlarmAt(schedule: Schedule, now: number = Date.now()): number {
  const base = dueAt(schedule);
  if (base > now) return base;
  const step = schedule.minutes * 60_000;
  return base + Math.ceil((now - base) / step) * step;
}

export async function syncAlarms(
  schedules: Schedule[] = loadSchedules(),
  now: number = Date.now(),
): Promise<{ scheduled: number; exact: boolean }> {
  if (!Capacitor.isNativePlatform()) return { scheduled: 0, exact: false };

  try {
    await bridge.cancelAll();
  } catch {
    return { scheduled: 0, exact: false };
  }

  let scheduled = 0;
  let exact = true;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    try {
      const result = await bridge.schedule({ id: schedule.id, at: nextAlarmAt(schedule, now), title: schedule.title });
      if (result?.exact === false) exact = false;
      scheduled += 1;
    } catch {
      // One refused alarm must not stop the others from being placed.
    }
  }

  return { scheduled, exact };
}

export async function alarmInfo(): Promise<{ exact: boolean; pending: number }> {
  if (!Capacitor.isNativePlatform()) return { exact: false, pending: 0 };
  try {
    const result = await bridge.info();
    return { exact: result?.exact === true, pending: result?.pending ?? 0 };
  } catch {
    return { exact: false, pending: 0 };
  }
}
