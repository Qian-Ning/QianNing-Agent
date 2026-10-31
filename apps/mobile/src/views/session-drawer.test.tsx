// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionDrawer } from "./session-drawer";
import { createTranslator } from "../lib/i18n";
import type { HostClient } from "../lib/racp";

const t = createTranslator("zh");

afterEach(cleanup);

function clientReturning(sessions: unknown[]): HostClient {
  return {
    call: vi.fn(async () => ({ sessions })),
  } as unknown as HostClient;
}

const now = new Date();
const today = now.toISOString();
const longAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

describe("session drawer", () => {
  it("groups sessions the way the desktop sidebar does", async () => {
    const client = clientReturning([
      { id: "a", title: "今天的活", updatedAt: today },
      { id: "b", title: "上个月", updatedAt: longAgo },
    ]);
    render(
      <SessionDrawer
        client={client}
        t={t}
        lang="zh"
        onSelect={() => {}}
        onNew={() => {}}
        onSettings={() => {}}
        onTerminal={() => {}}
        onBrowser={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("今天的活")).toBeTruthy());
    expect(screen.getByText("今天")).toBeTruthy();
    expect(screen.getByText("更早")).toBeTruthy();
  });

  it("marks the session being read and hands the picked one back", async () => {
    const client = clientReturning([
      { id: "a", title: "第一", updatedAt: today },
      { id: "b", title: "第二", updatedAt: today },
    ]);
    const onSelect = vi.fn();
    render(
      <SessionDrawer
        client={client}
        t={t}
        lang="zh"
        currentId="a"
        onSelect={onSelect}
        onNew={() => {}}
        onSettings={() => {}}
        onTerminal={() => {}}
        onBrowser={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("第二")).toBeTruthy());
    const current = screen.getByText("第一").closest("button");
    expect(current?.className).toContain("current");
    fireEvent.click(screen.getByText("第二"));
    expect(onSelect).toHaveBeenCalledWith({ id: "b", title: "第二" });
  });

  it("filters by title and says when nothing matches", async () => {
    const client = clientReturning([{ id: "a", title: "会议纪要", updatedAt: today }]);
    render(
      <SessionDrawer
        client={client}
        t={t}
        lang="zh"
        onSelect={() => {}}
        onNew={() => {}}
        onSettings={() => {}}
        onTerminal={() => {}}
        onBrowser={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("会议纪要")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("搜索会话"), { target: { value: "zzz" } });
    expect(screen.queryByText("会议纪要")).toBeNull();
  });
});
