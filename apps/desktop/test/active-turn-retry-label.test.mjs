/**
 * The retry row has two states, and the boundary between them is the whole
 * point: while the announced backoff is still running it counts down, and once
 * that backoff elapses the next attempt is already in flight. Leaving the row
 * on "0s" for the length of an attempt (which a throttled free tier can stretch
 * to minutes) is what made a retrying turn look hung, so the label must switch.
 *
 * `runActivityLabel` is a pure function, loaded through the same Vite SSR
 * harness the transcript rendering tests use so the assertions read the real
 * module. The catalogs come from this worktree's own source rather than the
 * built `@pi-desktop/i18n` package: node_modules is shared with the primary
 * checkout by link, so the package resolves to that checkout's older dist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");
const { zhCN } = await import("../../../packages/i18n/src/locales/zh-CN/index.ts");

const retry = (overrides = {}) => ({
  phase: "retrying",
  since: 1_000,
  attempt: 3,
  retryDelayMs: 30_000,
  error: { code: "PROVIDER_RATE_LIMITED", message: "429 status code (no body)" },
  ...overrides,
});

test("the retry row counts down, then reports the attempt already in flight", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { runActivityLabel } = await server.ssrLoadModule(
      "/src/features/chat/transcript/ActivityGroup.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: {
        en: { translation: en },
        "zh-CN": { translation: zhCN },
      },
    });
    const t = (key, options) => i18n.t(key, options);

    // Mid-backoff: 10s of the announced 30s left.
    assert.equal(
      runActivityLabel(retry(), t, 21_000),
      "Retrying in 10s · attempt 3/10",
    );
    // The backoff just elapsed; the attempt is starting now.
    assert.equal(runActivityLabel(retry(), t, 31_000), "Retrying · attempt 3/10");
    // Deep into an attempt that will not report back until it fails.
    assert.equal(
      runActivityLabel(retry(), t, 1_000 + 9 * 60_000),
      "Retrying · attempt 3/10",
    );
    // A retry with no announced delay never counts down at all.
    assert.equal(
      runActivityLabel(retry({ retryDelayMs: undefined }), t, 1_500),
      "Retrying · attempt 3/10",
    );
    // An unbounded budget still names the attempt, and the row stays honest.
    assert.equal(
      runActivityLabel(retry({ attempt: 12, infinite: true }), t, 31_000),
      "Retrying · attempt 12/∞",
    );

    await i18n.changeLanguage("zh-CN");
    const zh = (key, options) => i18n.t(key, options);
    assert.equal(runActivityLabel(retry(), zh, 21_000), "将在 10 秒后重试 · 第 3/10 次");
    assert.equal(runActivityLabel(retry(), zh, 31_000), "正在重试 · 第 3/10 次");
  } finally {
    await server.close();
  }
});

test("every shipped locale carries both retry labels", () => {
  for (const [locale, catalog] of Object.entries({
    en,
    "zh-CN": zhCN,
  })) {
    assert.match(
      String(catalog.chat.retryingModel),
      /\{\{delaySeconds\}\}/,
      `${locale} retryingModel`,
    );
    assert.match(
      String(catalog.chat.retryingAttempt),
      /\{\{attempt\}\}\/\{\{maxAttempts\}\}/,
      `${locale} retryingAttempt`,
    );
    assert.doesNotMatch(
      String(catalog.chat.retryingAttempt),
      /\{\{delaySeconds\}\}/,
      `${locale} retryingAttempt must not offer a countdown it no longer has`,
    );
  }
});
