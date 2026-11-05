// @vitest-environment jsdom
/**
 * First run is the only screen a reader sees before anything works, so these
 * checks pin the two things that matter: every permission row reports what
 * Android says (not what the tap hoped for), and the flow can be left at any
 * point without trapping the reader.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingView } from "./onboarding";
import { createTranslator } from "../lib/i18n";

const snapshot = {
  sdk: 34,
  notifications: false,
  notificationsRuntime: true,
  batteryOptimised: true,
  exactAlarms: false,
};

const read = vi.fn();
const askNotifications = vi.fn();
const askBattery = vi.fn();
const askAlarms = vi.fn();

vi.mock("../agent/system-permissions", () => ({
  systemPermissionsAvailable: () => true,
  readSystemPermissions: () => read(),
  askNotificationPermission: () => askNotifications(),
  askBatteryExemption: () => askBattery(),
  askExactAlarms: () => askAlarms(),
  openNotificationSettings: () => Promise.resolve(),
}));

const t = createTranslator("zh");

afterEach(() => {
  cleanup();
  read.mockReset();
  askNotifications.mockReset();
  askBattery.mockReset();
  askAlarms.mockReset();
});

describe("first run", () => {
  it("shows the product, then the notification the system is holding back", async () => {
    read.mockResolvedValue({ ...snapshot });
    askNotifications.mockResolvedValue({ ...snapshot, notifications: true, granted: true });

    render(<OnboardingView t={t} onDone={vi.fn()} />);
    expect(screen.getByText("欢迎使用千凝")).toBeTruthy();

    fireEvent.click(screen.getByText("开始"));
    await waitFor(() => expect(screen.getByText("任务与定时提醒")).toBeTruthy());
    expect(screen.getByText("安卓暂时拦住了通知。")).toBeTruthy();

    fireEvent.click(screen.getByText("允许"));
    await waitFor(() => expect(screen.getByText("已开启")).toBeTruthy());
  });

  it("asks for the two background settings from their own rows", async () => {
    read.mockResolvedValue({ ...snapshot });
    askBattery.mockResolvedValue({ ...snapshot, batteryOptimised: false });
    askAlarms.mockResolvedValue({ ...snapshot, batteryOptimised: false, exactAlarms: true });

    render(<OnboardingView t={t} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText("开始"));
    fireEvent.click(screen.getByText("下一步"));

    await waitFor(() => expect(screen.getByText("工作时保持唤醒")).toBeTruthy());
    fireEvent.click(screen.getAllByText("允许")[0]);
    await waitFor(() => expect(askBattery).toHaveBeenCalled());

    fireEvent.click(screen.getAllByText("允许")[0]);
    await waitFor(() => expect(askAlarms).toHaveBeenCalled());
  });

  it("can be left from the first screen", () => {
    read.mockResolvedValue({ ...snapshot });
    const done = vi.fn();

    render(<OnboardingView t={t} onDone={done} />);
    fireEvent.click(screen.getByText("稍后再说"));
    expect(done).toHaveBeenCalledOnce();
  });
});
