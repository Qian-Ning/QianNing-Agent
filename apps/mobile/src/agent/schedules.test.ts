import { beforeEach, describe, expect, it } from "vitest";
import { appStorage } from "../lib/app-storage";
import {
  clearSchedules,
  createSchedule,
  dueAt,
  isDue,
  loadSchedules,
  removeSchedule,
  resetSchedulesForTests,
  saveSchedule,
  toggleSchedule,
} from "./schedules";

const MINUTE = 60_000;

beforeEach(() => {
  clearSchedules();
  resetSchedulesForTests();
});

describe("schedules", () => {
  it("is due one interval after creation, not before", () => {
    const schedule = createSchedule({ title: "晨报", prompt: "总结昨天", minutes: 30, now: 1_000 });
    expect(isDue(schedule, 1_000 + 29 * MINUTE)).toBe(false);
    expect(isDue(schedule, dueAt(schedule))).toBe(true);
  });

  it("is due one interval after the last run", () => {
    const schedule = { ...createSchedule({ title: "a", prompt: "b", minutes: 10, now: 0 }), lastRunAt: 5 * MINUTE };
    expect(isDue(schedule, 14 * MINUTE)).toBe(false);
    expect(isDue(schedule, 15 * MINUTE)).toBe(true);
  });

  it("never runs while disabled", () => {
    const schedule = { ...createSchedule({ title: "a", prompt: "b", minutes: 10, now: 0 }), enabled: false };
    expect(isDue(schedule, 10_000 * MINUTE)).toBe(false);
  });

  it("persists, updates in place, toggles and removes", () => {
    const first = createSchedule({ title: "a", prompt: "b", minutes: 10, now: 1 });
    const second = createSchedule({ title: "c", prompt: "d", minutes: 20, now: 2 });
    saveSchedule(first);
    saveSchedule(second);
    expect(loadSchedules()).toHaveLength(2);

    resetSchedulesForTests();
    expect(loadSchedules().map((entry) => entry.title)).toEqual(["a", "c"]);

    toggleSchedule(first.id, false);
    saveSchedule({ ...loadSchedules()[0], lastRunAt: 42 });
    const updated = loadSchedules()[0];
    expect(updated.enabled).toBe(false);
    expect(updated.lastRunAt).toBe(42);
    expect(loadSchedules()).toHaveLength(2);

    removeSchedule(first.id);
    expect(loadSchedules()).toHaveLength(1);
  });

  it("drops entries that no longer match the shape", () => {
    appStorage().set("qn.schedules", JSON.stringify([{ id: "x" }, { ...createSchedule({ title: "ok", prompt: "p", minutes: 5 }), id: "good" }]));
    expect(loadSchedules().map((entry) => entry.id)).toEqual(["good"]);
  });

  it("survives unreadable storage", () => {
    appStorage().set("qn.schedules", "{not json");
    expect(loadSchedules()).toEqual([]);
  });
});

describe("cadence", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("daily waits for its own clock time, then rolls a day", () => {
    const schedule = {
      ...createSchedule({ title: "d", prompt: "p", minutes: 1440, now: at("2026-03-01T06:00:00") }),
      cadence: "daily" as const,
      hour: 9,
      minute: 30,
    };
    expect(new Date(dueAt(schedule)).toISOString()).toBe(new Date(at("2026-03-01T09:30:00")).toISOString());
    const ran = { ...schedule, lastRunAt: at("2026-03-01T09:30:00") };
    expect(new Date(dueAt(ran)).toISOString()).toBe(new Date(at("2026-03-02T09:30:00")).toISOString());
  });

  it("weekly picks the next selected weekday, Monday = 0", () => {
    // 2026-03-02 is a Monday; ask for Friday 08:00.
    const schedule = {
      ...createSchedule({ title: "w", prompt: "p", minutes: 10080, now: at("2026-03-02T10:00:00") }),
      cadence: "weekly" as const,
      hour: 8,
      minute: 0,
      weekdays: [4],
    };
    expect(new Date(dueAt(schedule)).toISOString()).toBe(new Date(at("2026-03-06T08:00:00")).toISOString());
  });

  it("a weekly task with several days takes the nearest one", () => {
    const schedule = {
      ...createSchedule({ title: "w", prompt: "p", minutes: 10080, now: at("2026-03-02T10:00:00") }),
      cadence: "weekly" as const,
      hour: 9,
      minute: 0,
      weekdays: [4, 1],
    };
    expect(new Date(dueAt(schedule)).toISOString()).toBe(new Date(at("2026-03-03T09:00:00")).toISOString());
  });

  it("hourly anchors on the last run", () => {
    const schedule = {
      ...createSchedule({ title: "h", prompt: "p", minutes: 60, now: 0 }),
      cadence: "hourly" as const,
      lastRunAt: at("2026-03-02T10:15:00"),
    };
    expect(dueAt(schedule)).toBe(at("2026-03-02T11:15:00"));
  });

  it("manual never comes due on its own", () => {
    const schedule = {
      ...createSchedule({ title: "m", prompt: "p", minutes: 525600, now: 0 }),
      cadence: "manual" as const,
    };
    expect(Number.isFinite(dueAt(schedule))).toBe(false);
    expect(isDue(schedule, Date.now() + 10 * 365 * 24 * 60 * MINUTE)).toBe(false);
  });
});
