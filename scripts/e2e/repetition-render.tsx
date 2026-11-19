import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { projectMessageEnd } from "../../apps/desktop/src/lib/session-transcript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/** Real transcript projection and rendering; no user profile or remote model. */
export async function repetitionRenderProbe() {
  const initial = useAppStore.getState();
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host);
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en }, "zh-CN": { translation: zhCN } } });
  const checks: string[] = [];
  const settle = () => new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close(); resolve();
    };
    channel.port2.postMessage(null);
  });
  const assert = (value: unknown, label: string) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const createdAt = "2026-11-19T00:00:00.000Z";
  const user: UiMessage = { id: "user", role: "user", content: "Inspect the workspace / 检查工作区", createdAt };
  const repeated = "REMOVED-REPEATED-FRAGMENT ".repeat(12);
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      for (const theme of ["light", "dark"]) {
        document.documentElement.dataset.theme = theme;
        for (const mode of ["detailed", "compact"] as const) {
          useAppStore.setState({
            settings: { ...initial.settings, smoothStreaming: false, thinkingDisplayMode: mode },
            agentStatuses: {}, pendingPlans: {}, dismissedAssistantErrorMessages: {},
          });
          for (const scenario of ["empty-reply", "empty-thinking", "retained-prefix"]) {
            const key = `${locale}/${theme}/${mode}/${scenario}`;
            const live: UiMessage = { id: "live", role: "assistant", content: scenario === "empty-thinking" ? "" : repeated,
              ...(scenario === "empty-thinking" ? { thinking: repeated } : {}), createdAt, status: "streaming" };
            const terminal: UiMessage = { ...live, id: "saved", content: scenario === "retained-prefix" ? "Valid result / 有效结果" : "",
              thinking: undefined, status: "error", error: { code: "OUTPUT_REPETITION", message: "The reply repeated itself and was stopped.", retriable: true } };
            const messages = projectMessageEnd([user, live], { type: "message_end", message: terminal, replacesMessageId: "live" });
            flushSync(() => root.render(<I18nextProvider i18n={i18n}><ChatTranscript sessionId="repetition-ui" messages={messages} isRunning={false} /></I18nextProvider>));
            const deadline = performance.now() + 3000;
            while (performance.now() < deadline) {
              await settle();
              const summary = host.querySelector(".message-error strong")?.textContent;
              const prefixReady = scenario !== "retained-prefix" || host.textContent?.includes("Valid result / 有效结果");
              if (summary === i18n.t("errors.OUTPUT_REPETITION") && prefixReady) break;
            }
            const error = host.querySelector<HTMLElement>(".message-error");
            assert(error, `${key}: error card visible`);
            assert(error.querySelector("strong")?.textContent === i18n.t("errors.OUTPUT_REPETITION"), `${key}: localized summary`);
            assert(!host.textContent?.includes("REMOVED-REPEATED-FRAGMENT"), `${key}: removed output stays removed`);
            assert(!host.querySelector(".transcript-runtime-status"), `${key}: settled status`);
            assert(!host.querySelector(".message-row.assistant .message-actions"), `${key}: no empty toolbar`);
            assert(scenario !== "retained-prefix" || host.textContent?.includes("Valid result / 有效结果"), `${key}: valid prefix retained`);
            const toggle = error.querySelector<HTMLButtonElement>(".message-error-toggle");
            flushSync(() => toggle?.click());
            assert(toggle?.getAttribute("aria-expanded") === "false", `${key}: details collapse`);
            flushSync(() => toggle?.click());
            assert(toggle?.getAttribute("aria-expanded") === "true", `${key}: details expand`);
            const box = error.getBoundingClientRect();
            assert(box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1, `${key}: card fits viewport`);
            for (const button of error.querySelectorAll("button")) {
              const rect = button.getBoundingClientRect();
              assert(rect.right <= innerWidth + 1 && rect.left >= -1, `${key}: action fits viewport`);
            }
          }
        }
      }
    }
    // Leave the last Chinese/dark/compact error visible for screenshot review.
    return { ok: true, scenarios: 24, checks: checks.length };
  } finally {
    // Keep this one fixture mounted until Electron captures its screenshot.
    globalThis.cleanupRepetitionProbe = () => {
      flushSync(() => root.unmount()); host.remove();
      useAppStore.setState(initial);
    };
  }
}

declare global { var cleanupRepetitionProbe: () => void; }
