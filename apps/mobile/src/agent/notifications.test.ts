import { beforeEach, describe, expect, it } from "vitest";
import { appStorage } from "../lib/app-storage";
import {
  clearNotices,
  loadNotices,
  markAllRead,
  pushNotice,
  resetNoticesForTests,
  subscribeNotices,
  unreadCount,
} from "./notifications";

beforeEach(() => {
  clearNotices();
  resetNoticesForTests();
});

describe("notifications", () => {
  it("keeps the newest first and counts the unread", () => {
    pushNotice({ title: "first" });
    pushNotice({ title: "second" });
    expect(loadNotices().map((entry) => entry.title)).toEqual(["second", "first"]);
    expect(unreadCount()).toBe(2);
  });

  it("marks everything read once, without duplicating entries", () => {
    pushNotice({ title: "a" });
    pushNotice({ title: "b" });
    markAllRead();
    expect(unreadCount()).toBe(0);
    expect(loadNotices()).toHaveLength(2);
  });

  it("caps the list at fifty entries", () => {
    for (let index = 0; index < 55; index += 1) pushNotice({ title: "n" + index });
    expect(loadNotices()).toHaveLength(50);
    expect(loadNotices()[0].title).toBe("n54");
  });

  it("persists across a reload and clears on request", () => {
    pushNotice({ title: "kept", body: "body", sessionId: "s1" });
    resetNoticesForTests();
    expect(loadNotices()[0]).toMatchObject({ title: "kept", body: "body", sessionId: "s1", read: false });
    clearNotices();
    expect(loadNotices()).toEqual([]);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    let seen = 0;
    const stop = subscribeNotices(() => {
      seen += 1;
    });
    pushNotice({ title: "a" });
    expect(seen).toBe(1);
    stop();
    pushNotice({ title: "b" });
    expect(seen).toBe(1);
  });

  it("ignores a corrupt store", () => {
    appStorage().set("qn.notices", "[{]");
    resetNoticesForTests();
    expect(loadNotices()).toEqual([]);
  });
});
