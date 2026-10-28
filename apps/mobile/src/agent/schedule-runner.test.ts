import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "../lib/racp";
import { runDueSchedules } from "./schedule-runner";
import { clearSchedules, createSchedule, loadSchedules, resetSchedulesForTests, saveSchedule } from "./schedules";

function fakeClient(overrides: Partial<HostClient> = {}): HostClient {
  return {
    call: vi.fn(async () => ({ session: { id: "session_1" } })),
    stream: () => () => {},
    ...overrides,
  } as HostClient;
}

const MINUTE = 60_000;

beforeEach(() => {
  clearSchedules();
  resetSchedulesForTests();
});

describe("runDueSchedules", () => {
  it("creates a conversation on the first run and remembers it", async () => {
    const schedule = createSchedule({ title: "晨报", prompt: "总结昨天", minutes: 60, now: 0 });
    saveSchedule(schedule);
    const client = fakeClient();
    const notices: unknown[] = [];

    const ran = await runDueSchedules({ client, now: () => 61 * MINUTE, onNotice: (n) => notices.push(n) });

    expect(ran).toBe(1);
    const calls = (client.call as unknown as { mock: { calls: [string, { body: { input?: { text?: string } } }][] } }).mock.calls;
    expect(calls[0][0]).toBe("/v1/sessions");
    expect(calls[1][0]).toBe("/v1/sessions/session_1/turns");
    expect(calls[1][1].body.input?.text).toBe("总结昨天");
    expect(loadSchedules()[0]).toMatchObject({ sessionId: "session_1", lastRunAt: 61 * MINUTE });
    expect(notices).toHaveLength(1);
  });

  it("does not run twice inside one interval", async () => {
    saveSchedule(createSchedule({ title: "a", prompt: "b", minutes: 30, now: 0 }));
    const client = fakeClient();
    const first = await runDueSchedules({ client, now: () => 31 * MINUTE, onNotice: () => {} });
    const second = await runDueSchedules({ client, now: () => 40 * MINUTE, onNotice: () => {} });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("keeps a failed task due and reports it", async () => {
    saveSchedule(createSchedule({ title: "a", prompt: "b", minutes: 10, now: 0 }));
    const call = vi.fn(async (path: string) => {
      if (path === "/v1/sessions") return { session: { id: "s" } };
      throw new Error("provider offline");
    });
    const notices: { title: string; body: string }[] = [];

    const ran = await runDueSchedules({
      client: fakeClient({ call: call as unknown as HostClient["call"] }),
      now: () => 11 * MINUTE,
      onNotice: (n) => notices.push(n),
    });

    expect(ran).toBe(0);
    expect(loadSchedules()[0].lastRunAt).toBeNull();
    expect(notices[0].body).toContain("provider offline");
  });

  it("skips disabled tasks", async () => {
    saveSchedule({ ...createSchedule({ title: "a", prompt: "b", minutes: 1, now: 0 }), enabled: false });
    const client = fakeClient();
    expect(await runDueSchedules({ client, now: () => 100 * MINUTE, onNotice: () => {} })).toBe(0);
  });
});
