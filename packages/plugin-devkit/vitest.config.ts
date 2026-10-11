import { defineConfig } from "vitest/config";

// The scaffolding cases here build real template trees on disk, so the per-case
// budget is plumbing, not a behavioural claim. Measured 2026-10-10 on the
// 16-core dev host: in a full `pnpm -r` run `reports an empty skill file` hit
// the 5s default and timed out while `pnpm --filter @pi-desktop/plugin-devkit
// test` passed 49/49 alone a minute later. Raise the budget (a real hang still
// trips it); do not widen any assertion to make a red go away.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
