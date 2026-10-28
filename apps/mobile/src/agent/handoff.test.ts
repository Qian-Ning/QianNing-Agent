import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store";
import { mergeHeadlessResults, pruneForeignSessions } from "./handoff";
import type { StoredMessage, StoredSession } from "./store";

const session = (id: string, updatedAt: string, title = "夜间任务"): StoredSession => ({
  id,
  title,
  createdAt: "2026-10-28T01:00:00.000Z",
  updatedAt,
});

const message = (itemId: string, text: string): StoredMessage => ({
  itemId,
  role: "assistant",
  text,
  status: "done",
  createdAt: "2026-10-28T02:00:00.000Z",
});

describe("mergeHeadlessResults", () => {
  it("brings a run the app never saw into the transcript", () => {
    const store = new MemoryStore();
    store.writeSession(session("s1", "2026-10-28T01:00:00.000Z"));

    const report = mergeHeadlessResults(store, {
      sessions: [session("s1", "2026-10-28T03:00:00.000Z")],
      messages: { s1: [message("m1", "早上好"), message("m2", "今天三件事")] },
    });

    expect(report.messagesAdded).toBe(2);
    expect(store.readMessages("s1").map((m) => m.text)).toEqual(["早上好", "今天三件事"]);
  });

  it("is idempotent — draining the same file twice changes nothing", () => {
    const store = new MemoryStore();
    const drained = { sessions: [session("s1", "2026-10-28T03:00:00.000Z")], messages: { s1: [message("m1", "一")] } };

    mergeHeadlessResults(store, drained);
    const second = mergeHeadlessResults(store, drained);

    expect(second.messagesAdded).toBe(0);
    expect(store.readMessages("s1")).toHaveLength(1);
  });

  it("keeps a title the reader typed in the app", () => {
    const store = new MemoryStore();
    store.writeSession(session("s1", "2026-10-28T01:00:00.000Z", "我自己起的名字"));

    mergeHeadlessResults(store, { sessions: [session("s1", "2026-10-28T05:00:00.000Z", "自动标题")], messages: {} });

    expect(store.readSession("s1")?.title).toBe("我自己起的名字");
    expect(store.readSession("s1")?.updatedAt).toBe("2026-10-28T05:00:00.000Z");
  });

  it("does not let a stale headless copy overwrite newer app state", () => {
    const store = new MemoryStore();
    store.writeSession(session("s1", "2026-10-28T09:00:00.000Z"));

    const report = mergeHeadlessResults(store, { sessions: [session("s1", "2026-10-28T02:00:00.000Z")], messages: {} });

    expect(report.sessionsUpdated).toBe(0);
    expect(store.readSession("s1")?.updatedAt).toBe("2026-10-28T09:00:00.000Z");
  });

  it("only fills values the app has never written", () => {
    const store = new MemoryStore();
    store.writeValue("theme", "paper");

    mergeHeadlessResults(store, { sessions: [], messages: {}, values: { theme: "night", lastRun: "08:00" } });

    expect(store.readValue("theme")).toBe("paper");
    expect(store.readValue("lastRun")).toBe("08:00");
  });
});

describe("pruneForeignSessions", () => {
  it("drops a session the reader deleted while the run was in flight", () => {
    const store = new MemoryStore();
    store.writeSession(session("keep", "2026-10-28T01:00:00.000Z"));

    const pruned = pruneForeignSessions(store, {
      sessions: [session("keep", "2026-10-28T02:00:00.000Z"), session("gone", "2026-10-28T02:00:00.000Z")],
      messages: { keep: [message("m1", "留下")], gone: [message("m2", "不该回来")] },
    });

    expect(pruned.sessions.map((s) => s.id)).toEqual(["keep"]);
    expect(Object.keys(pruned.messages)).toEqual(["keep"]);
  });
});
