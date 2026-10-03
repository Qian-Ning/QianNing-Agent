import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

const readRoot = (path) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
const readUsagePage = () =>
  readFile(
    new URL("../src/components/settings/UsagePage.tsx", import.meta.url),
    "utf8",
  );

// QianNing fork (D631): a usage-statistics destination is added under Settings,
// reading the host-owned completed-turn token history (ADR 0171) plus a
// read-only per-provider/per-model breakdown. This deliberately reverses the
// upstream decision to keep that history host-only with no settings surface.
test("settings exposes the usage destination wired to host token history", () => {
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.nav\.usage/);
  assert.match(settingsPage, /tab === "usage"/);
  assert.match(settingsPage, /UsagePage/);
  assert.match(api, /getTokenUsageHistory/);
  assert.match(api, /getUsageBreakdown/);
});

// QianNing fork: the usage page estimates cost from an editable model pricing
// table. The renderer reaches it through four typed stats.* IPC methods; assert
// they exist so the UI's cost/pricing wiring cannot silently lose its backend.
test("api exposes the editable model-pricing surface", () => {
  assert.match(api, /getModelPricing/);
  assert.match(api, /updateModelPricing/);
  assert.match(api, /deleteModelPricing/);
  assert.match(api, /resetModelPricing/);
});

test("model pricing editor component exists", async () => {
  await access(
    new URL("../src/components/settings/ModelPricingEditor.tsx", import.meta.url),
    constants.F_OK,
  );
});

test("settings usage page component exists", async () => {
  await access(
    new URL("../src/components/settings/UsagePage.tsx", import.meta.url),
    constants.F_OK,
  );
});

// QianNing fork (D647): "today" is one daily bucket, so its trend rendered as a
// lone point in an empty frame. The page now asks the host to bucket that range
// by hour, and labels the card from the bucket the host reports having returned
// so an older host that normalises "hour" back to "day" still reads correctly.
test("the usage trend asks for intraday buckets on the today range", async () => {
  const page = await readUsagePage();
  assert.match(page, /range === "today" \? "hour" : "day"/);
  assert.match(page, /api\.getTokenUsageHistory\(\{ startDate, endDate, bucket \}\)/);
  assert.match(page, /\[range, bucket, providerFilter, modelFilter, reloadNonce\]/);
  assert.match(page, /history\?\.bucket \?\? bucket/);
  assert.match(page, /settings\.usageStats\.trendHourly/);
});

// The bug's whole surface was one point drawn at a fixed radius. A one-bucket
// range now describes that bucket instead, so the regression is assertable: the
// composition component must exist, must be what `n === 1` returns, and the
// lone-dot branch must be gone.
test("a single-bucket range renders its composition instead of one dot", async () => {
  const page = await readUsagePage();
  assert.match(page, /function BucketComposition\(/);
  assert.match(page, /if \(n === 1\) \{\s*return <BucketComposition item=\{items\[0\]\}/);
  assert.match(page, /usage-compose-bar/);
  assert.doesNotMatch(page, /n <= 1 \? 3\.4 : 2\.6/);
});

// The chart is only as good as the buckets behind it: the host has to accept the
// new bucket and key it, or "today" silently falls back to a single day again.
test("the host buckets usage by local hour", async () => {
  const rust = await readRoot("crates/host-core/src/sessions.rs");
  assert.match(rust, /"hour" => "hour"/);
  assert.match(rust, /"hour" => dt\.format\("%Y-%m-%dT%H"\)\.to_string\(\)/);
  assert.match(rust, /"hour" => end - chrono::Duration::hours\(24\)/);
  const shared = await readRoot("packages/shared/src/types/filesystem.ts");
  assert.match(shared, /TokenUsageBucket = "hour" \| "day" \| "week" \| "month"/);
});

// D648: the trend was grayscale, so the three series were told apart by stroke
// weight alone. Each series now reads its own hue, and every hue is defined on
// all three theme surfaces — a token defined only on the dark base would leave
// the light and QianNing appearances painting a fallback. The chart also must
// consume the tokens rather than re-inlining literals.
test("every theme surface defines the chart series palette", async () => {
  const tokens = await readRoot("apps/desktop/src/styles/tokens.css");
  const surfaces = [
    /:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/,
    /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/,
    /:root\[data-appearance="fox"\]\s*\{([\s\S]*?)\n\}/,
  ];
  const names = [
    "--ds-chart-input",
    "--ds-chart-output",
    "--ds-chart-cache",
    "--ds-chart-cache-write",
    "--ds-chart-grid",
  ];
  for (const surface of surfaces) {
    const block = tokens.match(surface);
    assert.ok(block, `theme surface not found: ${surface}`);
    for (const name of names) {
      assert.match(
        block[1],
        new RegExp(`${name}\\s*:`),
        `${name} is missing from a theme surface`,
      );
    }
  }
});

test("the usage charts paint from the series tokens, not literals", async () => {
  const css = await readRoot("apps/desktop/src/styles/usage.css");
  for (const name of [
    "--ds-chart-input",
    "--ds-chart-output",
    "--ds-chart-cache",
    "--ds-chart-cache-write",
  ]) {
    assert.match(css, new RegExp(`var\\(${name}\\)`), `usage.css never reads ${name}`);
  }
  // The swatch and the composition segment must share a rule, or the legend and
  // the bar it names can drift to different colours.
  assert.match(css, /\.usage-swatch-input\s*\{\s*background: var\(--ds-chart-input\)/);
  assert.match(css, /\.usage-seg-input\s*\{\s*background: var\(--ds-chart-input\)/);
});

// Every new label the trend panel reads, in every shipped locale. A missing key
// renders as the raw dotted path, which is worse than the bug this fixes.
test("every locale ships the intraday trend labels", async () => {
  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  const keys = [
    "trendHourly",
    "readoutTotal",
    "readoutTurns",
    "peakMarker",
    "statPeak",
    "statAverage",
    "statAverageNote",
    "statActive",
    "statActiveNote",
    "singleBucketNote",
  ];
  await Promise.all(
    locales.map(async (locale) => {
      const source = await readRoot(`packages/i18n/src/locales/${locale}/index.ts`);
      for (const key of keys) {
        assert.match(
          source,
          new RegExp(`"?${key}"?:`),
          `${locale} is missing settings.usageStats.${key}`,
        );
      }
    }),
  );
});
