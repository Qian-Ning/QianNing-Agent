// @vitest-environment jsdom
/**
 * The entry screen offers two equal ways to have an agent. These checks keep the
 * local path honest: three fields, a normalized URL, and a provider handed upward
 * — no silent fallback to the desktop.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectView } from "./connect";
import { createTranslator } from "../lib/i18n";

const t = createTranslator("zh");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the connect screen", () => {
  it("starts on the on-device agent and can switch to pairing", () => {
    render(<ConnectView t={t} onConnected={vi.fn()} onLocal={vi.fn()} onSkip={vi.fn()} />);

    const local = screen.getByRole("tab", { name: "本机运行" });
    const remote = screen.getByRole("tab", { name: "连接电脑" });
    expect(local.getAttribute("aria-selected")).toBe("true");
    expect(remote.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(remote);
    expect(remote.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("配对链接或地址")).toBeTruthy();
  });

  it("hands a complete provider to the app", () => {
    const onLocal = vi.fn();
    render(<ConnectView t={t} onConnected={vi.fn()} onLocal={onLocal} onSkip={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("接口地址"), {
      target: { value: "api.deepseek.com/v1/" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "deepseek-chat" } });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));

    expect(onLocal).toHaveBeenCalledWith({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      modelId: "deepseek-chat",
    });
  });

  it("says what is missing instead of starting with half a provider", () => {
    const onLocal = vi.fn();
    render(<ConnectView t={t} onConnected={vi.fn()} onLocal={onLocal} onSkip={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("接口地址"), { target: { value: "api.deepseek.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));

    expect(onLocal).not.toHaveBeenCalled();
    expect(screen.getByText("三项都要填。")).toBeTruthy();
  });
});
