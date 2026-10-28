import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedule, clearSchedules, resetSchedulesForTests } from "./schedules";

const schedule = vi.fn(async () => ({ exact: true }));
const cancelAll = vi.fn(async () => {});
const cancel = vi.fn(async () => {});
let native = true;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
  registerPlugin: () => ({ schedule, cancelAll, cancel, info: async () => ({ exact: true, pending: 0 }) }),
}));

const alarms = await import("./alarms");

const MINUTE = 60_000;

beforeEach(() => {
  clearSchedules();
  resetSchedulesForTests();
  schedule.mockClear();
  cancelAll.mockClear();
  native = true;
});

describe("nextAlarmAt", () => {
  it("rings at the due moment when it is still ahead", () => {
    const task = createSchedule({ title: "a", prompt: "b", minutes: 30, now: 0 });
    expect(alarms.nextAlarmAt(task, 10 * MINUTE)).toBe(30 * MINUTE);
  });

  it("skips to the next period when the task is already overdue", () => {
    const task = createSchedule({ title: "a", prompt: "b", minutes: 30, now: 0 });
    // 40 minutes in: the 30-minute window has passed, next is 60.
    expect(alarms.nextAlarmAt(task, 40 * MINUTE)).toBe(60 * MINUTE);
    // Far later: it still lands on a period boundary, never in the past.
    expect(alarms.nextAlarmAt(task, 130 * MINUTE)).toBe(150 * MINUTE);
  });

  it("counts from the last run, not from creation", () => {
    const task = { ...createSchedule({ title: "a", prompt: "b", minutes: 15, now: 0 }), lastRunAt: 100 * MINUTE };
    expect(alarms.nextAlarmAt(task, 101 * MINUTE)).toBe(115 * MINUTE);
  });
});

describe("syncAlarms", () => {
  it("cancels everything, then places one alarm per enabled task", async () => {
    const first = createSchedule({ title: "一", prompt: "p", minutes: 30, now: 0 });
    const second = { ...createSchedule({ title: "二", prompt: "p", minutes: 60, now: 0 }), enabled: false };
    const { clearSchedules: clear, saveSchedule } = await import("./schedules");
    clear();
    saveSchedule(first);
    saveSchedule(second);

    const result = await alarms.syncAlarms(undefined, 5 * MINUTE);

    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith({ id: first.id, at: 30 * MINUTE, title: "一" });
    expect(result).toEqual({ scheduled: 1, exact: true });
  });

  it("reports an inexact alarm instead of pretending it is exact", async () => {
    schedule.mockResolvedValueOnce({ exact: false });
    const task = createSchedule({ title: "a", prompt: "b", minutes: 30, now: 0 });
    const result = await alarms.syncAlarms([task], 0);
    expect(result.exact).toBe(false);
  });

  it("keeps going when one alarm is refused", async () => {
    schedule.mockRejectedValueOnce(new Error("denied"));
    const one = createSchedule({ title: "a", prompt: "b", minutes: 30, now: 0 });
    const two = createSchedule({ title: "c", prompt: "d", minutes: 30, now: 0 });
    const result = await alarms.syncAlarms([one, two], 0);
    expect(result.scheduled).toBe(1);
  });

  it("does nothing off the phone", async () => {
    native = false;
    await alarms.syncAlarms([createSchedule({ title: "a", prompt: "b", minutes: 5 })], 0);
    expect(cancelAll).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});
