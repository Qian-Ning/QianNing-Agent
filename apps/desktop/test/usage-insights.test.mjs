import assert from "node:assert/strict";
import test from "node:test";
import {
  breakdownToCsv,
  buildCalendarHeatmap,
  detectAnomalies,
  forecastUsage,
  historyToCsv,
  toCsv,
  usageExportStem,
  usageToJson,
} from "../src/lib/usage-insights.ts";

/** A dense daily series ending on `date`, in the shape the host returns. */
function dailySeries(values, start = "2026-09-01") {
  const [y, m, d] = start.split("-").map(Number);
  return values.map((totalTokens, i) => {
    const at = new Date(Date.UTC(y, m - 1, d + i));
    const date = at.toISOString().slice(0, 10);
    return {
      date,
      timestamp: at.getTime(),
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      turnCount: totalTokens > 0 ? 1 : 0,
    };
  });
}

test("the heatmap is a dense weekday grid over the trailing weeks", () => {
  // 2026-09-01 is a Tuesday.
  const items = dailySeries([10, 20, 0, 40, 0, 0, 80]);
  const cells = buildCalendarHeatmap(items, 1);

  assert.equal(cells.length, 7, "one week of days");
  assert.equal(cells[0].date, "2026-09-01");
  assert.equal(cells[0].weekday, 2, "Tuesday");
  assert.equal(cells[6].weekday, 1, "the next Monday");
  assert.deepEqual(
    cells.map((c) => c.tokens),
    [10, 20, 0, 40, 0, 0, 80],
  );
});

test("heatmap levels are quartiles of the busiest day in view, and zero stays zero", () => {
  const items = dailySeries([0, 25, 50, 75, 100, 0, 0]);
  const cells = buildCalendarHeatmap(items, 1);
  assert.deepEqual(
    cells.map((c) => c.level),
    [0, 1, 2, 3, 4, 0, 0],
  );
});

test("an all-zero window produces no coloured cells rather than dividing by zero", () => {
  const cells = buildCalendarHeatmap(dailySeries([0, 0, 0, 0, 0, 0, 0]), 1);
  assert.equal(cells.length, 7);
  assert.ok(cells.every((c) => c.level === 0 && c.tokens === 0));
});

test("the heatmap keeps only the trailing weeks it was asked for", () => {
  const items = dailySeries(new Array(40).fill(1));
  assert.equal(buildCalendarHeatmap(items, 2).length, 14);
  assert.equal(buildCalendarHeatmap(items, 40).length, 40, "never invents days");
});

test("a rising baseline projects upward and a falling one declines", () => {
  const rising = forecastUsage(dailySeries([100, 200, 300, 400, 500]), 7);
  assert.ok(rising, "five points are enough to fit");
  assert.equal(rising.basisCount, 5);
  assert.equal(rising.horizon, 7);
  assert.equal(rising.declining, false);
  // Slope is 100/day from a 100 start, so the seven projected days are
  // 600…1200 — a mean of 900.
  assert.equal(rising.perBucket, 900);
  assert.equal(rising.totalTokens, 6300);

  const falling = forecastUsage(dailySeries([500, 400, 300, 200, 100]), 7);
  assert.ok(falling);
  assert.equal(falling.declining, true);
  assert.ok(falling.totalTokens >= 0, "a negative projection clamps at zero");
});

test("a projection never goes negative when the trend points below zero", () => {
  const forecast = forecastUsage(dailySeries([10, 5, 1, 0, 0, 0, 0, 0]), 7);
  assert.ok(forecast);
  assert.ok(forecast.totalTokens >= 0);
});

test("a single point (or none) is not a trend", () => {
  assert.equal(forecastUsage([], 7), null);
  assert.equal(forecastUsage(dailySeries([42]), 7), null);
  // Points with data collapse to < 2 when the window is all zeros.
  assert.equal(forecastUsage(dailySeries([0, 0, 0]), 7), null);
});

test("a spike is an anomaly against the median, not against the mean it inflates", () => {
  const items = dailySeries([10, 10, 12, 9, 11, 10, 10, 900, 10, 11]);
  const anomalies = detectAnomalies(items);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].tokens, 900);
  assert.equal(anomalies[0].date, items[7].date);
});

test("a steady window reports nothing", () => {
  assert.deepEqual(detectAnomalies(dailySeries([100, 100, 100, 100, 100, 100])), []);
  assert.deepEqual(detectAnomalies(dailySeries([0, 0, 0, 0, 0, 0])), []);
});

test("one spike over a flat baseline still surfaces when the MAD is zero", () => {
  const items = dailySeries([0, 0, 0, 0, 0, 0, 5000, 0, 0, 0]);
  const anomalies = detectAnomalies(items);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].tokens, 5000);
  assert.equal(anomalies[0].score, Number.POSITIVE_INFINITY);
});

test("a window too short to have a baseline reports nothing", () => {
  assert.deepEqual(detectAnomalies(dailySeries([1, 2, 3])), []);
});

test("anomalies are capped, worst first", () => {
  const items = dailySeries([10, 10, 10, 10, 500, 10, 10, 10, 900, 10, 300, 10]);
  const anomalies = detectAnomalies(items, 2);
  assert.equal(anomalies.length, 2);
  assert.deepEqual(
    anomalies.map((a) => a.tokens),
    [900, 500],
  );
});

test("CSV round-trips fields that need quoting, including non-ASCII", () => {
  const csv = toCsv([
    ["name", "note"],
    ["四合院", 'says "hi", then leaves'],
  ]);
  assert.ok(csv.startsWith("\uFEFF"), "a BOM so Excel reads UTF-8");
  assert.ok(csv.endsWith("\r\n"), "CRLF records");
  assert.ok(csv.includes('四合院,"says ""hi"", then leaves"\r\n'));
});

test("the trend export carries one row per bucket with its header", () => {
  const items = dailySeries([1, 2, 3]);
  const csv = historyToCsv({ bucket: "day", rangeStart: 0, rangeEnd: 0, items, totals: {} });
  const lines = csv.replace("\uFEFF", "").trimEnd().split("\r\n");
  assert.equal(lines.length, 4, "header plus three buckets");
  assert.ok(lines[0].startsWith("bucket,date,timestamp,inputTokens"));
  assert.ok(lines[1].startsWith("day,2026-09-01,"));
});

test("the breakdown export keeps provider, model, and project in named sections", () => {
  const csv = breakdownToCsv({
    rangeStart: 0,
    rangeEnd: 0,
    byProvider: [
      {
        providerId: "p1",
        turnCount: 2,
        successCount: 2,
        successRate: 1,
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 0.5,
        unpricedTurns: 0,
      },
    ],
    byModel: [],
    byProject: [
      {
        projectId: null,
        projectName: null,
        turnCount: 1,
        successCount: 1,
        totalTokens: 10,
        inputTokens: 6,
        outputTokens: 4,
        costUsd: 0.1,
        unpricedTurns: 0,
      },
    ],
    recent: [],
    totalCostUsd: 0.5,
    pricedTurns: 2,
    unpricedTurns: 0,
  });

  assert.equal(csv.replace("\uFEFF", "").split("group,id,name").length - 1, 3, "three sections");
  assert.ok(csv.includes("provider,p1,p1,"));
  assert.ok(csv.includes("project,,,"), "an unattributed project exports an empty id and name");
});

test("the JSON export is the whole payload, pretty-printed", () => {
  const json = usageToJson({
    rangeId: "7d",
    bucket: "day",
    history: null,
    breakdown: null,
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.rangeId, "7d");
  assert.equal(parsed.bucket, "day");
  assert.ok(json.endsWith("\n"));
});

test("the export filename is stable for a given day", () => {
  assert.equal(
    usageExportStem("30d", new Date(2026, 9, 4)),
    "qianning-usage-30d-2026-10-04",
  );
});
