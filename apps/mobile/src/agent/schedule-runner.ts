import type { HostClient } from "../lib/racp";
import { pushNotice } from "./notifications";
import {
  dueAt,
  finishRun,
  isDue,
  loadSchedules,
  saveSchedule,
  startRun,
  type Schedule,
} from "./schedules";

/**
 * One pass over the schedule list: run whatever is due, in order.
 *
 * Runs while the app is open. Waking a sleeping phone needs Android's alarm
 * manager and is not part of this pass; the page says so plainly instead of
 * pretending the schedule fires in the background.
 */
export type NoticeInput = {
  title: string;
  body: string;
  sessionId: string | null;
  at: number;
};

export async function runDueSchedules(options: {
  client: HostClient;
  now?: () => number;
  onNotice?: (notice: NoticeInput) => unknown;
}): Promise<number> {
  const now = options.now ?? Date.now;
  const notify = options.onNotice ?? pushNotice;
  let ran = 0;

  for (const schedule of loadSchedules()) {
    if (!isDue(schedule, now())) continue;
    const run = startRun({ taskId: schedule.id, sessionId: schedule.sessionId, at: now() });
    try {
      const sessionId = schedule.sessionId ?? (await createSession(options.client, schedule));
      await sendTurn(options.client, sessionId, schedule);
      saveSchedule({ ...schedule, sessionId, lastRunAt: now() });
      finishRun(run.id, "completed", { sessionId, at: now() });
      notify({
        title: schedule.title,
        body: schedule.prompt.slice(0, 120),
        sessionId,
        at: now(),
      });
      ran += 1;
    } catch (cause) {
      // Leave it due: a failed provider call should retry on the next tick, not
      // skip a whole period. The failure is visible in the notification list.
      finishRun(run.id, "error", {
        at: now(),
        errorCode: cause instanceof Error ? cause.message.slice(0, 120) : "SCHEDULE_FAILED",
      });
      notify({
        title: schedule.title,
        body: cause instanceof Error ? cause.message : String(cause),
        sessionId: schedule.sessionId,
        at: now(),
      });
    }
  }

  return ran;
}

/**
 * Run one task right now, from the page's own button.
 *
 * Shares the send path with the due pass, so a manual run writes the same
 * record and lands in the same conversation the schedule would use.
 */
export async function runScheduleNow(options: {
  client: HostClient;
  schedule: Schedule;
  now?: () => number;
  onNotice?: (notice: NoticeInput) => unknown;
}): Promise<string> {
  const now = options.now ?? Date.now;
  const notify = options.onNotice ?? pushNotice;
  const { schedule } = options;
  const run = startRun({ taskId: schedule.id, sessionId: schedule.sessionId, at: now() });
  try {
    const sessionId = schedule.sessionId ?? (await createSession(options.client, schedule));
    await sendTurn(options.client, sessionId, schedule);
    saveSchedule({ ...schedule, sessionId, lastRunAt: now() });
    finishRun(run.id, "completed", { sessionId, at: now() });
    notify({
      title: schedule.title,
      body: schedule.prompt.slice(0, 120),
      sessionId,
      at: now(),
    });
    return sessionId;
  } catch (cause) {
    finishRun(run.id, "error", {
      at: now(),
      errorCode: cause instanceof Error ? cause.message.slice(0, 120) : "SCHEDULE_FAILED",
    });
    throw cause;
  }
}

async function createSession(client: HostClient, schedule: Schedule): Promise<string> {
  const created = await client.call<{ session?: { id?: string } }>("/v1/sessions", {
    method: "POST",
    body: { mode: "agent", title: schedule.title },
  });
  const id = created.session?.id;
  if (!id) throw new Error("the host did not return a session id");
  return id;
}

async function sendTurn(client: HostClient, sessionId: string, schedule: Schedule): Promise<void> {
  await client.call(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    body: {
      input: { text: schedule.prompt },
      context: { requestId: "schedule_" + schedule.id + "_" + dueAt(schedule) },
    },
  });
}
