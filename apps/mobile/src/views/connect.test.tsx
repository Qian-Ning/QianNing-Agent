// @vitest-environment jsdom
/**
 * The entry screen is where a wrong Base URL used to cost someone an afternoon.
 * These checks pin the new order: pick a known service, paste a key, pick from
 * the models that service actually lists — and the phone never asks for a model
 * id it already knows how to discover.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectView } from "./connect";
import { createTranslator } from "../lib/i18n";

const probe = vi.fn();
vi.mock("../agent/host", async (original) => {
  const actual = await original<typeof import("../agent/host")>();
  return { ...actual, probeModels: (base: string, key: string) => probe(base, key) };
});

const t = createTranslator("zh");

afterEach(() => {
  cleanup();
  localStorage.clear();
  probe.mockReset();
});

describe("the connect screen", () => {
  it("offers the known services so nobody types a base URL", () => {
    render(<ConnectView t={t} onLocal={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("Moonshot AI (China)")).toBeTruthy();
    // OpenAI's preset speaks the Responses API, which this phone does not, so the
    // list must not offer it.
    expect(screen.queryByText("OpenAI")).toBeNull();
    expect(screen.getByText("自定义接口")).toBeTruthy();
  });

  it("asks the service for its models and starts with the chosen one", async () => {
    probe.mockResolvedValue(["deepseek-chat", "deepseek-reasoner"]);
    const onLocal = vi.fn();
    render(<ConnectView t={t} onLocal={onLocal} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByText("DeepSeek"));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByText("deepseek-chat");

    expect(probe).toHaveBeenCalledWith("https://api.deepseek.com", "sk-test");

    fireEvent.click(screen.getByText("deepseek-reasoner"));
    fireEvent.click(screen.getByRole("button", { name: "开始" }));

    expect(onLocal).toHaveBeenCalledWith({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelId: "deepseek-reasoner",
    });
  });

  it("cannot start without a model, and says so when the endpoint lists none", async () => {
    probe.mockResolvedValue([]);
    const onLocal = vi.fn();
    render(<ConnectView t={t} onLocal={onLocal} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByText("DeepSeek"));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));

    await screen.findByText("接口通了，但没有返回模型列表。");
    expect(screen.getByRole("button", { name: "开始" })).toHaveProperty("disabled", true);
    expect(onLocal).not.toHaveBeenCalled();
  });
});
