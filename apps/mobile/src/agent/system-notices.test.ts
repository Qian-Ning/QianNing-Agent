import { describe, expect, it } from "vitest";

import {
  clearSystemNotice,
  postSystemNotice,
  requestNoticePermission,
  systemNoticesAvailable,
} from "./system-notices";

/**
 * Outside the packaged app there is no notification tray to talk to. Every
 * entry point has to answer without throwing, because the in-app centre calls
 * them on paths that must keep working in a browser and on the desktop host.
 */
describe("system notices", () => {
  it("reports the tray as unavailable off-device", () => {
    expect(systemNoticesAvailable()).toBe(false);
  });

  it("declines the permission instead of throwing", async () => {
    await expect(requestNoticePermission()).resolves.toBe(false);
  });

  it("skips the tray copy and reports it was not posted", async () => {
    await expect(
      postSystemNotice({ id: "notice_1", title: "对话完成", body: "可以看了" }),
    ).resolves.toBe(false);
  });

  it("cancels silently", async () => {
    await expect(clearSystemNotice("notice_1")).resolves.toBeUndefined();
  });
});
