import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "../lib/i18n";
import { SchedulesPage } from "./schedules-page";
import { NotificationsPage } from "./notifications-page";
import { clearSchedules, createSchedule, resetSchedulesForTests, saveSchedule } from "../agent/schedules";
import { clearNotices, pushNotice, resetNoticesForTests } from "../agent/notifications";

const t = createTranslator("zh");

beforeEach(() => {
  clearSchedules();
  resetSchedulesForTests();
  clearNotices();
  resetNoticesForTests();
});

describe("settings pages", () => {
  it("an empty schedule list offers the one action it can take", () => {
    const html = renderToStaticMarkup(<SchedulesPage t={t} />);
    expect(html).toContain("还没有定时任务");
    expect(html).toContain("新建任务");
    expect(html).toContain("empty-state");
  });

  it("a schedule shows its interval, prompt and switch state", () => {
    saveSchedule(createSchedule({ title: "晨报", prompt: "总结昨天的工作", minutes: 30, now: 1_000 }));
    const html = renderToStaticMarkup(<SchedulesPage t={t} />);
    expect(html).toContain("晨报");
    expect(html).toContain("总结昨天的工作");
    expect(html).toContain("30 分钟");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("notifications render newest first and mark the unread ones", () => {
    pushNotice({ title: "旧的一条", body: "a" });
    pushNotice({ title: "新的一条", body: "b" });
    const html = renderToStaticMarkup(<NotificationsPage t={t} />);
    expect(html.indexOf("新的一条")).toBeLessThan(html.indexOf("旧的一条"));
    expect(html).toContain("notice unread");
    expect(html).toContain("全部已读");
  });

  it("an empty notification list explains where entries come from", () => {
    const html = renderToStaticMarkup(<NotificationsPage t={t} />);
    expect(html).toContain("还没有通知");
    expect(html).toContain("empty-note");
  });
});
