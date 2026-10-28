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
