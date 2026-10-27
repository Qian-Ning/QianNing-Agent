// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsView } from "./settings";
import { createTranslator } from "../lib/i18n";

const t = createTranslator("zh");

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.style.removeProperty("--font-scale");
});

function renderSettings(overrides: Partial<React.ComponentProps<typeof SettingsView>> = {}) {
  const props: React.ComponentProps<typeof SettingsView> = {
    t,
    modelLabel: "agnes-3.0-flash",
    thinking: "off",
    onApplyModel: vi.fn(),
    onConnectRemote: vi.fn(async () => {}),
    onDisconnect: vi.fn(),
    stats: { sessions: 3, messages: 40 },
    onClose: vi.fn(),
    ...overrides,
  };
  return render(<SettingsView {...props} />);
}

describe("settings", () => {
  it("offers the desktop's destinations as one list", () => {
    renderSettings();
    for (const label of ["通用", "模型", "外观与皮肤", "连接", "远程访问", "用量", "关于"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("agnes-3.0-flash")).toBeTruthy();
  });

  it("keeps pairing on the connection page, away from model setup", () => {
    renderSettings();
    fireEvent.click(screen.getByText("连接"));
    expect(screen.getByText("连接电脑")).toBeTruthy();
    expect(screen.getByPlaceholderText("访问令牌")).toBeTruthy();
    // Remote access is a separate page, not the same thing as pairing.
    fireEvent.click(screen.getByLabelText("返回"));
    fireEvent.click(screen.getByText("远程访问"));
    expect(screen.getByText(/远程访问是指从别的设备/)).toBeTruthy();
  });

  it("applies the desktop skin the reader picks", () => {
    renderSettings();
    fireEvent.click(screen.getByText("外观与皮肤"));
    fireEvent.click(screen.getByText("森绿"));
    expect(localStorage.getItem("qn.mobile.skin")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBeTruthy();
  });

  it("scales type through the desktop's --font-scale token", () => {
    renderSettings();
    fireEvent.click(screen.getByText("通用"));
    fireEvent.click(screen.getByRole("button", { name: "大" }));
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.06");
  });
});
