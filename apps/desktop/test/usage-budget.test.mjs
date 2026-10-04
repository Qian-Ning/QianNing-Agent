import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  APPROACHING_BUDGET_RATIO,
  BUDGET_EPSILON_USD,
  budgetState,
  monthLabel,
  parseBudgetInput,
} = await import("../src/lib/usage-budget.ts");
const {
  MAX_USAGE_BUDGET_USD,
  MIN_USAGE_BUDGET_USD,
  isValidUsageBudgetUsd,
  normalizeUsageBudget,
  usageBudgetCeiling,
} = await import("@pi-desktop/shared");
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import(
  "../electron/main/runtime/provider-catalog.ts"
);

/* ------------------------------------------------------------------ *
 * The accepted range — defined once in shared, enforced at all three
 * boundaries (renderer, Electron main, Rust host).
 * ------------------------------------------------------------------ */

test("the range accepts both ends and rejects just outside them", () => {
  assert.equal(isValidUsageBudgetUsd(MIN_USAGE_BUDGET_USD), true);
  assert.equal(isValidUsageBudgetUsd(MAX_USAGE_BUDGET_USD), true);
  assert.equal(isValidUsageBudgetUsd(MIN_USAGE_BUDGET_USD / 2), false);
  assert.equal(isValidUsageBudgetUsd(MAX_USAGE_BUDGET_USD + 1), false);
  assert.equal(isValidUsageBudgetUsd(0), false, "a ceiling of zero is instantly broken");
  assert.equal(isValidUsageBudgetUsd(-5), false);
});

test("no ceiling is a valid value, and it is the only valid non-number", () => {
  assert.equal(isValidUsageBudgetUsd(null), true);
  for (const value of [undefined, "10", NaN, Infinity, -Infinity, {}, [], true]) {
    assert.equal(isValidUsageBudgetUsd(value), false, `accepted ${JSON.stringify(value)}`);
  }
});

test("normalizing keeps a usable amount and decays everything else", () => {
  assert.deepEqual(normalizeUsageBudget({ monthlyUsd: 25 }), { monthlyUsd: 25 });
  assert.deepEqual(normalizeUsageBudget({ monthlyUsd: null }), { monthlyUsd: null });
  assert.deepEqual(normalizeUsageBudget({}), { monthlyUsd: null });
  assert.deepEqual(normalizeUsageBudget(null), { monthlyUsd: null });
  assert.deepEqual(normalizeUsageBudget(7), { monthlyUsd: null });
  for (const bad of [{ monthlyUsd: 0 }, { monthlyUsd: -1 }, { monthlyUsd: "x" }, { monthlyUsd: NaN }]) {
    assert.deepEqual(normalizeUsageBudget(bad), { monthlyUsd: null }, `kept ${JSON.stringify(bad)}`);
  }
});

test("an absent section stays absent rather than being invented", () => {
  assert.equal(normalizeUsageBudget(undefined), undefined);
  assert.equal(usageBudgetCeiling(undefined), null);
});

test("the ceiling reads the same from every shape a stored section can take", () => {
  assert.equal(usageBudgetCeiling({ monthlyUsd: 12.5 }), 12.5);
  assert.equal(usageBudgetCeiling({ monthlyUsd: null }), null);
  assert.equal(usageBudgetCeiling({}), null);
  assert.equal(usageBudgetCeiling({ monthlyUsd: "12.5" }), null);
});

/* ------------------------------------------------------------------ *
 * The typed field -> the stored value.
 * ------------------------------------------------------------------ */

test("an empty field clears the ceiling — the only way a keyboard removes one", () => {
  assert.deepEqual(parseBudgetInput(""), { kind: "clear" });
  assert.deepEqual(parseBudgetInput("   "), { kind: "clear" });
});

test("a number in range parses, with a comma read as the decimal mark", () => {
  assert.deepEqual(parseBudgetInput("25"), { kind: "amount", usd: 25 });
  assert.deepEqual(parseBudgetInput("25.5"), { kind: "amount", usd: 25.5 });
  assert.deepEqual(parseBudgetInput(" 0.01 "), { kind: "amount", usd: MIN_USAGE_BUDGET_USD });
  assert.deepEqual(parseBudgetInput("12,50"), { kind: "amount", usd: 12.5 });
});

test("anything the store would reject is reported invalid, not silently dropped", () => {
  for (const raw of ["0", "-3", "abc", "$25", "1.2.3", "1e3", "0.001", "100000001"]) {
    assert.deepEqual(parseBudgetInput(raw), { kind: "invalid" }, `accepted ${raw}`);
  }
});

test("a comma is a decimal mark, so a thousands-style entry reads as a fraction", () => {
  // Documented consequence of supporting `12,50` for the half of the shipped
  // locales that write decimals that way: the first comma is the decimal mark,
  // never a thousands separator. The field echoes the parsed amount back, so a
  // mistyped `1,000` shows as `1.00` where the user can see and fix it.
  assert.deepEqual(parseBudgetInput("12,50"), { kind: "amount", usd: 12.5 });
  assert.deepEqual(parseBudgetInput("1,000"), { kind: "amount", usd: 1 });
  assert.deepEqual(parseBudgetInput("1,00,0"), { kind: "invalid" });
});

/* ------------------------------------------------------------------ *
 * Spend against ceiling.
 * ------------------------------------------------------------------ */

test("with no ceiling the state is inert and carries no ratio", () => {
  const state = budgetState(42, null);
  assert.equal(state.level, "none");
  assert.equal(state.ratio, 0);
  assert.equal(state.rawRatio, 0);
  assert.equal(state.spentUsd, 42, "spend is still reported without a ceiling");
  assert.equal(state.ceilingUsd, null);
  assert.equal(state.remainingUsd, null);
  assert.equal(state.overspendUsd, 0);
});

test("below the approach threshold the bar tracks spend", () => {
  const state = budgetState(4, 10);
  assert.equal(state.level, "ok");
  assert.equal(state.ratio, 0.4);
  assert.equal(state.rawRatio, 0.4);
  assert.equal(state.remainingUsd, 6);
  assert.equal(state.overspendUsd, 0);
});

test("the approach threshold is inclusive", () => {
  assert.equal(budgetState(APPROACHING_BUDGET_RATIO * 10 - 0.01, 10).level, "ok");
  assert.equal(budgetState(APPROACHING_BUDGET_RATIO * 10, 10).level, "approaching");
  assert.equal(budgetState(9.99, 10).level, "approaching");
});

test("spending the ceiling exactly is not over; a cent beyond it is", () => {
  const at = budgetState(10, 10);
  assert.equal(at.level, "approaching", "spending it all is not spending too much");
  assert.equal(at.remainingUsd, 0);
  assert.equal(at.overspendUsd, 0);

  const over = budgetState(10.01, 10);
  assert.equal(over.level, "over");
  assert.equal(over.remainingUsd, 0);
  assert.ok(Math.abs(over.overspendUsd - 0.01) < 1e-9);
});

test("past the ceiling the bar clamps while the numbers keep growing", () => {
  const state = budgetState(25, 10);
  assert.equal(state.ratio, 1, "the bar has nowhere left to go");
  assert.equal(state.rawRatio, 2.5, "the label still needs the truth");
  assert.equal(state.overspendUsd, 15);
});

test("floating point noise cannot fake an overrun", () => {
  const spent = 0.1 + 0.2;
  assert.ok(spent > 0.3, "precondition: the naive sum really does overshoot");
  const state = budgetState(spent, 0.3);
  assert.equal(state.level, "approaching", "exact spend must not read as over");
  assert.equal(state.overspendUsd, 0);
  assert.ok(BUDGET_EPSILON_USD > spent - 0.3, "the tolerance has to cover the drift");
});

test("nonsense spend reads as nothing spent rather than poisoning the ratio", () => {
  for (const spent of [NaN, Infinity, -Infinity, -1]) {
    const state = budgetState(spent, 10);
    assert.equal(state.spentUsd, 0, `spent ${spent}`);
    assert.equal(state.level, "ok");
  }
});

/* ------------------------------------------------------------------ *
 * The month label.
 * ------------------------------------------------------------------ */

test("the label names the month the ceiling applies to", () => {
  const october = Date.UTC(2026, 9, 4);
  assert.equal(monthLabel(october, "en-US"), "October 2026");
  assert.equal(monthLabel(october, "zh-CN"), "2026年10月");
  assert.ok(monthLabel(october, "de-DE").includes("2026"));
});

test("a bad locale or timestamp degrades instead of throwing", () => {
  assert.ok(monthLabel(Date.UTC(2026, 9, 4), "not-a-locale").includes("2026"));
  assert.equal(monthLabel(Number.NaN, "en-US"), "");
});

/* ------------------------------------------------------------------ *
 * The write path: both boundaries must agree about the same value.
 * ------------------------------------------------------------------ */

function withWindow(run) {
  const previous = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    return run(createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} }));
  } finally {
    globalThis.window = previous;
  }
}

test("a ceiling read through either boundary comes out the same", () => {
  withWindow((main) => {
    for (const stored of [
      { usageBudget: { monthlyUsd: 25 } },
      { usageBudget: { monthlyUsd: null } },
      { usageBudget: {} },
      { usageBudget: { monthlyUsd: 0 } },
      {},
    ]) {
      const read = renderer.normalizeSettings(stored);
      assert.deepEqual(read.usageBudget, main.normalizeSettings(stored).usageBudget);
      assert.deepEqual(read.usageBudget, normalizeUsageBudget(stored.usageBudget));
    }
  });
});

test("a ceiling outside the range is rejected on both boundaries", () => {
  withWindow((main) => {
    const value = { usageBudget: { monthlyUsd: 0.001 } };
    assert.throws(() => renderer.validateSettingsWrite(value), /usageBudget/);
    assert.throws(() => main.validateSettingsWrite(value), /usageBudget/);
  });
});

test("a ceiling write leaves unrelated preferences alone on both boundaries", () => {
  withWindow((main) => {
    const value = {
      defaultMode: "agent",
      theme: "dark",
      usageBudget: { monthlyUsd: 40 },
      infiniteProviderRetry: true,
    };
    for (const read of [renderer.normalizeSettings(value), main.normalizeSettings(value)]) {
      assert.equal(read.defaultMode, "agent");
      assert.equal(read.theme, "dark");
      assert.equal(read.infiniteProviderRetry, true);
      assert.deepEqual(read.usageBudget, { monthlyUsd: 40 });
    }
  });
});

test("a valid ceiling survives the renderer -> main round trip unchanged", () => {
  withWindow((main) => {
    const outgoing = renderer.validateSettingsWrite({ usageBudget: { monthlyUsd: 12.34 } });
    const persisted = main.validateSettingsWrite(structuredClone(outgoing));
    assert.deepEqual(persisted.usageBudget, { monthlyUsd: 12.34 });
    assert.equal(renderer.normalizeSettings(persisted).usageBudget.monthlyUsd, 12.34);
  });
});
