import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ProviderPublic,
  TokenUsageBucket,
  TokenUsageHistoryItem,
  TokenUsageHistoryResult,
  UsageBreakdownResult,
} from "@pi-desktop/shared";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { providerDisplayName } from "../../lib/provider-display";
import { Badge, Button, SegmentedControl } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { ModelPricingEditor } from "./ModelPricingEditor";
import { IconActivity, IconRefresh } from "../icons";

type RangeId = "today" | "7d" | "30d";

const DAY_MS = 86_400_000;

/**
 * Approximate USD cost for display. Sub-cent figures keep more precision so a
 * genuinely tiny spend does not collapse to "$0.00".
 */
function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Local midnight `daysAgo` days before now, as an epoch-ms timestamp. */
function startOfDay(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * DAY_MS;
}

/** The [start, end] window a range selection covers, in local time. */
function rangeWindow(range: RangeId): { startDate: number; endDate: number } {
  const endDate = Date.now();
  switch (range) {
    case "7d":
      return { startDate: startOfDay(6), endDate };
    case "30d":
      return { startDate: startOfDay(29), endDate };
    default:
      return { startDate: startOfDay(0), endDate };
  }
}

/**
 * A provider is "local" (and therefore free) when it needs no credential or
 * points at a loopback endpoint. Matches the keyless local presets the fork
 * ships (Ollama, LM Studio, llama.cpp, vLLM) without hardcoding vendor names.
 */
function isLocalProvider(provider: ProviderPublic | undefined): boolean {
  if (!provider) return false;
  if (provider.authKind === "none") return true;
  const base = provider.baseUrl?.toLowerCase() ?? "";
  return (
    base.includes("localhost") ||
    base.includes("127.0.0.1") ||
    base.includes("0.0.0.0") ||
    base.includes("::1")
  );
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Thousands-separated exact count, for the numbers a user reads off a panel. */
function nf(value: number): string {
  return value.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Axis tick for a bucket key: `14:00` for an hour, `10-03` for a day. */
function bucketTick(date: string, bucket: TokenUsageBucket): string {
  if (bucket === "hour") return `${date.slice(11, 13)}:00`;
  return date.slice(5);
}

/**
 * One bucket's token mix as a single stacked bar.
 *
 * A range that resolves to one point has no trend to draw, and a lone dot in an
 * empty frame reads as a rendering bug rather than as a number. The composition
 * of that one slice is the honest thing to show.
 */
function BucketComposition({
  item,
  bucket,
  labels,
}: {
  item: TokenUsageHistoryItem;
  bucket: TokenUsageBucket;
  labels: { input: string; output: string; cache: string };
}) {
  const { t } = useTranslation();
  const total = item.totalTokens;
  const rows = [
    { key: "in", label: labels.input, value: item.inputTokens, cls: "usage-seg-input" },
    { key: "out", label: labels.output, value: item.outputTokens, cls: "usage-seg-output" },
    {
      key: "cw",
      label: t("settings.usageStats.miCacheWrite"),
      value: item.cacheWriteTokens,
      cls: "usage-seg-cache-write",
    },
    {
      key: "cr",
      label: labels.cache,
      value: item.cacheReadTokens,
      cls: "usage-seg-cache-read",
    },
  ];
  const shown = rows.filter((row) => row.value > 0);

  return (
    <div className="usage-compose">
      <div className="usage-compose-h">
        <span className="usage-compose-bucket">{bucketTick(item.date, bucket)}</span>
        <span className="usage-compose-total">
          {nf(total)}
          <small>≈ {formatCompactTokenCount(total)}</small>
        </span>
      </div>
      <div
        className="usage-compose-bar"
        role="img"
        aria-label={`${labels.input} / ${labels.output} / ${labels.cache}`}
      >
        {shown.length ? (
          shown.map((row) => (
            <span
              key={row.key}
              className={`usage-compose-seg ${row.cls}`}
              style={{ flexGrow: row.value }}
              title={`${row.label} ${nf(row.value)}`}
            />
          ))
        ) : (
          <span className="usage-compose-seg usage-compose-seg-empty" />
        )}
      </div>
      <div className="usage-compose-legend">
        {rows.map((row) => (
          <span key={row.key} className="usage-compose-item">
            <i className={`usage-swatch ${row.cls}`} />
            <span className="usage-compose-item-k">{row.label}</span>
            <b className="usage-compose-item-v">{nf(row.value)}</b>
            <em className="usage-compose-item-p">
              {total > 0 ? formatPercent(row.value / total) : "—"}
            </em>
          </span>
        ))}
      </div>
      <div className="usage-compose-foot">
        {t("settings.usageStats.singleBucketNote", { count: item.turnCount })}
      </div>
    </div>
  );
}

/**
 * Hand-drawn trend (input / output lines over a cache-read area), grayscale to
 * match the app theme. Drawn as inline SVG so no chart library is pulled in.
 *
 * The readout above the plot follows the pointer and falls back to the peak
 * bucket, so the panel names real numbers before anyone hovers. A range that
 * collapses to a single bucket renders as a composition bar instead.
 */
function TrendChart({
  items,
  bucket,
  labels,
}: {
  items: TokenUsageHistoryResult["items"];
  bucket: TokenUsageBucket;
  labels: { input: string; output: string; cache: string };
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);

  const W = 720;
  const H = 208;
  const PL = 46;
  const PR = 12;
  const PT = 12;
  const PB = 26;

  const n = items.length;
  const maxV = Math.max(
    1,
    ...items.map((it) => Math.max(it.inputTokens, it.outputTokens, it.cacheReadTokens)),
  );
  const ceil = maxV * 1.15;
  const sx = (i: number) =>
    n <= 1 ? PL + (W - PL - PR) / 2 : PL + (W - PL - PR) * (i / (n - 1));
  const sy = (v: number) => PT + (H - PT - PB) * (1 - v / ceil);
  const pts = (pick: (it: TokenUsageHistoryItem) => number) =>
    items.map((it, i) => [sx(i), sy(pick(it))] as const);
  const toLine = (p: readonly (readonly [number, number])[]) =>
    p.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const toArea = (p: readonly (readonly [number, number])[]) =>
    p.length
      ? `${toLine(p)} L${p[p.length - 1][0].toFixed(1)} ${H - PB} L${p[0][0].toFixed(1)} ${H - PB} Z`
      : "";

  const inputPts = pts((it) => it.inputTokens);
  const outputPts = pts((it) => it.outputTokens);
  const cachePts = pts((it) => it.cacheReadTokens);

  if (n === 0) {
    return <div className="usage-chart-empty">{t("settings.usageStats.empty")}</div>;
  }
  if (n === 1) {
    return <BucketComposition item={items[0]} bucket={bucket} labels={labels} />;
  }

  const peakIdx = items.reduce(
    (best, it, i) => (it.totalTokens > items[best].totalTokens ? i : best),
    0,
  );
  const focusIdx = hover ?? peakIdx;
  const focus = items[focusIdx];
  const activeCount = items.filter((it) => it.turnCount > 0).length;
  const peakTotal = items[peakIdx].totalTokens;
  const activeAvg =
    activeCount > 0
      ? items.reduce((sum, it) => sum + it.totalTokens, 0) / activeCount
      : 0;

  // Pointing at the plot selects the nearest bucket, so the readout always
  // describes something the reader is actually looking at.
  const onMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const x = ((event.clientX - rect.left) / rect.width) * W;
    const ratio = (x - PL) / (W - PL - PR);
    const idx = Math.round(ratio * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, idx)));
  };

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const y = PT + (H - PT - PB) * (i / 4);
    return { y, value: ceil * (1 - i / 4) };
  });

  // Show at most ~8 x labels so a 30-bucket range does not crowd.
  const step = Math.max(1, Math.ceil(n / 8));
  const peakX = sx(peakIdx);
  const peakY = sy(items[peakIdx].totalTokens);
  const peakAnchor = peakX < PL + 48 ? "start" : peakX > W - PR - 48 ? "end" : "middle";

  return (
    <div className="usage-chartwrap">
      <div className="usage-chart-readout">
        <span className="usage-chart-readout-k">{bucketTick(focus.date, bucket)}</span>
        <span className="usage-chart-readout-i">
          <i className="usage-swatch usage-swatch-input" />
          {nf(focus.inputTokens)}
        </span>
        <span className="usage-chart-readout-i">
          <i className="usage-swatch usage-swatch-output" />
          {nf(focus.outputTokens)}
        </span>
        <span className="usage-chart-readout-i">
          <i className="usage-swatch usage-swatch-cache" />
          {nf(focus.cacheReadTokens)}
        </span>
        <span className="usage-chart-readout-total">
          {t("settings.usageStats.readoutTotal")} {nf(focus.totalTokens)}
        </span>
        <span className="usage-chart-readout-turns">
          {t("settings.usageStats.readoutTurns", { count: focus.turnCount })}
        </span>
      </div>
      <svg
        className="usage-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${labels.input} / ${labels.output}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {grid.map(({ y, value }, i) => (
          <g key={i}>
            <line
              x1={PL}
              y1={y}
              x2={W - PR}
              y2={y}
              className="usage-chart-grid"
              strokeDasharray="3 4"
            />
            <text x={PL - 8} y={y + 3} className="usage-chart-ylabel" textAnchor="end">
              {formatCompactTokenCount(Math.round(value))}
            </text>
          </g>
        ))}
        {cachePts.length > 1 && <path d={toArea(cachePts)} className="usage-series-cache-fill" />}
        {cachePts.length > 1 && (
          <path d={toLine(cachePts)} className="usage-series-cache-line" fill="none" />
        )}
        {outputPts.length > 1 && (
          <path d={toLine(outputPts)} className="usage-series-output" fill="none" />
        )}
        {inputPts.length > 1 && (
          <path d={toLine(inputPts)} className="usage-series-input" fill="none" />
        )}
        {hover !== null && (
          <line
            x1={sx(hover)}
            y1={PT}
            x2={sx(hover)}
            y2={H - PB}
            className="usage-chart-guide"
          />
        )}
        {cachePts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2} className="usage-series-cache-dot" />
        ))}
        {outputPts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.2} className="usage-series-output-dot" />
        ))}
        {inputPts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={i === focusIdx ? 3.6 : 2.6}
            className="usage-series-input-dot"
          />
        ))}
        <text
          x={peakX}
          y={Math.max(PT + 9, peakY - 9)}
          className="usage-chart-peaklabel"
          textAnchor={peakAnchor}
        >
          {t("settings.usageStats.peakMarker", {
            value: formatCompactTokenCount(peakTotal),
          })}
        </text>
        {items.map((it, i) =>
          i % step === 0 || i === n - 1 ? (
            <text
              key={i}
              x={sx(i)}
              y={H - 8}
              className="usage-chart-xlabel"
              textAnchor="middle"
            >
              {bucketTick(it.date, bucket)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="usage-legend">
        <span>
          <i className="usage-swatch usage-swatch-input" />
          {labels.input}
        </span>
        <span>
          <i className="usage-swatch usage-swatch-output" />
          {labels.output}
        </span>
        <span>
          <i className="usage-swatch usage-swatch-cache" />
          {labels.cache}
        </span>
      </div>
      <div className="usage-chart-stats">
        <div className="usage-chart-stat">
          <span className="usage-chart-stat-k">{t("settings.usageStats.statPeak")}</span>
          <span className="usage-chart-stat-v">{formatCompactTokenCount(peakTotal)}</span>
          <span className="usage-chart-stat-s">{bucketTick(items[peakIdx].date, bucket)}</span>
        </div>
        <div className="usage-chart-stat">
          <span className="usage-chart-stat-k">{t("settings.usageStats.statAverage")}</span>
          <span className="usage-chart-stat-v">{formatCompactTokenCount(Math.round(activeAvg))}</span>
          <span className="usage-chart-stat-s">
            {t("settings.usageStats.statAverageNote")}
          </span>
        </div>
        <div className="usage-chart-stat">
          <span className="usage-chart-stat-k">{t("settings.usageStats.statActive")}</span>
          <span className="usage-chart-stat-v">
            {activeCount} / {n}
          </span>
          <span className="usage-chart-stat-s">{t("settings.usageStats.statActiveNote")}</span>
        </div>
      </div>
    </div>
  );
}

export function UsagePage() {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const [range, setRange] = useState<RangeId>("today");
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [history, setHistory] = useState<TokenUsageHistoryResult | null>(null);
  const [breakdown, setBreakdown] = useState<UsageBreakdownResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [showPricing, setShowPricing] = useState(false);

  // "Today" is an intraday question, and one daily bucket cannot show a trend —
  // it asks the host to bucket by hour instead. Wider windows stay daily.
  const bucket: TokenUsageBucket = range === "today" ? "hour" : "day";

  const providerById = useMemo(() => {
    const map = new Map<string, ProviderPublic>();
    for (const provider of providers) map.set(provider.id, provider);
    return map;
  }, [providers]);

  const nameFor = useCallback(
    (id: string | null) => {
      if (!id) return t("settings.usageStats.unknownProvider");
      const provider = providerById.get(id);
      return provider ? providerDisplayName(provider) : id;
    },
    [providerById, t],
  );

  // Reload both aggregates when the window, filters, or a manual refresh
  // changes. A cancelled flag drops results that arrive after the effect is
  // torn down, so a fast range switch cannot paint stale data (AGENTS §9).
  useEffect(() => {
    let cancelled = false;
    const { startDate, endDate } = rangeWindow(range);
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const query = {
          startDate,
          endDate,
          providerId: providerFilter || undefined,
          modelId: modelFilter || undefined,
        };
        const [hist, brk] = await Promise.all([
          api.getTokenUsageHistory({ startDate, endDate, bucket }),
          api.getUsageBreakdown({ ...query, recentLimit: 100 }),
        ]);
        if (cancelled) return;
        setHistory(hist);
        setBreakdown(brk);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, bucket, providerFilter, modelFilter, reloadNonce]);

  const totals = history?.totals;
  const totalTokens = totals?.totalTokens ?? 0;
  const requestCount = useMemo(
    () => (breakdown?.byProvider ?? []).reduce((sum, p) => sum + p.turnCount, 0),
    [breakdown],
  );
  const hitRate = useMemo(() => {
    const read = totals?.cacheReadTokens ?? 0;
    const write = totals?.cacheWriteTokens ?? 0;
    return read + write > 0 ? read / (read + write) : 0;
  }, [totals]);

  // The whole window is free only when every provider that produced usage is
  // local; otherwise a paid provider was involved and cost is estimated.
  const allLocal = useMemo(() => {
    const rows = breakdown?.byProvider ?? [];
    return rows.length > 0 && rows.every((p) => isLocalProvider(providerById.get(p.providerId)));
  }, [breakdown, providerById]);

  const totalCost = breakdown?.totalCostUsd ?? 0;
  const unpricedTurns = breakdown?.unpricedTurns ?? 0;

  const sourceOptions = useMemo(
    () => [
      { id: "", label: t("settings.usageStats.allSources") },
      ...providers.map((p) => ({ id: p.id, label: providerDisplayName(p) })),
    ],
    [providers, t],
  );
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts = [{ id: "", label: t("settings.usageStats.allModels") }];
    for (const row of breakdown?.byModel ?? []) {
      if (row.modelId && !seen.has(row.modelId)) {
        seen.add(row.modelId);
        opts.push({ id: row.modelId, label: row.modelId });
      }
    }
    return opts;
  }, [breakdown, t]);

  // A host that predates the hourly bucket normalises the request back to
  // `day`, so label and format the plot from the bucket it reports having
  // returned rather than from the one we asked for.
  const shownBucket: TokenUsageBucket = history?.bucket ?? bucket;

  const rangeLabel =
    range === "today"
      ? t("settings.usageStats.rangeToday")
      : range === "7d"
        ? t("settings.usageStats.range7d")
        : t("settings.usageStats.range30d");

  if (showPricing) {
    return <ModelPricingEditor onBack={() => {
      setShowPricing(false);
      setReloadNonce((n) => n + 1);
    }} />;
  }

  return (
    <div className="usage-page">
      <div className="usage-toolbar">
        <p className="usage-subtitle">{t("settings.usageStats.subtitle")}</p>
        <div className="usage-filters">
          <SettingsMenuSelect
            label={t("settings.usageStats.allSources")}
            value={providerFilter}
            options={sourceOptions}
            onChange={setProviderFilter}
          />
          <SettingsMenuSelect
            label={t("settings.usageStats.allModels")}
            value={modelFilter}
            options={modelOptions}
            onChange={setModelFilter}
          />
          <SegmentedControl<RangeId>
            label={t("settings.usage")}
            value={range}
            onChange={setRange}
            options={[
              { value: "today", label: t("settings.usageStats.rangeToday") },
              { value: "7d", label: t("settings.usageStats.range7d") },
              { value: "30d", label: t("settings.usageStats.range30d") },
            ]}
          />
          <Button
            variant="secondary"
            onClick={() => setShowPricing(true)}
          >
            {t("settings.usageStats.managePricing")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setReloadNonce((n) => n + 1)}
            aria-label={t("settings.usageStats.refresh")}
          >
            <IconRefresh size={14} />
          </Button>
        </div>
      </div>

      {failed ? (
        <div className="usage-empty">{t("settings.usageStats.empty")}</div>
      ) : (
        <>
          {/* Summary hero + five mini metrics */}
          <div className="usage-card">
            <div className="usage-hero">
              <div className="usage-hero-main">
                <div className="usage-hero-bolt">
                  <IconActivity size={22} />
                </div>
                <div>
                  <div className="usage-hero-k">{t("settings.usageStats.totalTokens")}</div>
                  <div className="usage-hero-v">
                    {nf(totalTokens)}
                    <small>≈ {formatCompactTokenCount(totalTokens)}</small>
                  </div>
                </div>
              </div>
              <div className="usage-hero-side">
                <div>
                  <div className="usage-hero-k">{t("settings.usageStats.totalRequests")}</div>
                  <div className="usage-hero-sv">{nf(requestCount)}</div>
                </div>
                <div>
                  <div className="usage-hero-k">{t("settings.usageStats.totalCost")}</div>
                  <div className="usage-hero-sv">
                    {allLocal ? (
                      <span className="usage-free">{t("settings.usageStats.costLocalFree")}</span>
                    ) : totalCost > 0 ? (
                      <span>
                        {formatCost(totalCost)}
                        <small className="usage-cost-est"> {t("settings.usageStats.costEstimated")}</small>
                      </span>
                    ) : (
                      <span className="usage-dim">{t("settings.usageStats.unpriced")}</span>
                    )}
                  </div>
                  {!allLocal && unpricedTurns > 0 && (
                    <div className="usage-cost-note">
                      {t("settings.usageStats.costPartialNote", { count: unpricedTurns })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="usage-mini">
              <div className="usage-m">
                <div className="usage-m-top">{t("settings.usageStats.miInput")}</div>
                <div className="usage-m-v">{nf(totals?.inputTokens ?? 0)}</div>
              </div>
              <div className="usage-m">
                <div className="usage-m-top">{t("settings.usageStats.miOutput")}</div>
                <div className="usage-m-v">{nf(totals?.outputTokens ?? 0)}</div>
              </div>
              <div className="usage-m">
                <div className="usage-m-top">{t("settings.usageStats.miCacheWrite")}</div>
                <div className="usage-m-v">{nf(totals?.cacheWriteTokens ?? 0)}</div>
              </div>
              <div className="usage-m">
                <div className="usage-m-top">{t("settings.usageStats.miCacheRead")}</div>
                <div className="usage-m-v">{nf(totals?.cacheReadTokens ?? 0)}</div>
              </div>
              <div className="usage-m">
                <div className="usage-m-top">{t("settings.usageStats.miCacheHitRate")}</div>
                <div className="usage-m-v usage-m-v-good">{formatPercent(hitRate)}</div>
              </div>
            </div>
          </div>

          {/* Trend */}
          <div className="usage-card">
            <div className="usage-card-h">
              <div className="usage-card-t">{t("settings.usageStats.trendTitle")}</div>
              <div className="usage-card-r">
                {rangeLabel} ·{" "}
                {shownBucket === "hour"
                  ? t("settings.usageStats.trendHourly")
                  : t("settings.usageStats.trendDaily")}
              </div>
            </div>
            <TrendChart
              items={history?.items ?? []}
              bucket={shownBucket}
              labels={{
                input: t("settings.usageStats.legendInput"),
                output: t("settings.usageStats.legendOutput"),
                cache: t("settings.usageStats.legendCache"),
              }}
            />
          </div>

          {/* Provider / model tables */}
          <div className="usage-grid">
            <div className="usage-card">
              <div className="usage-card-h">
                <div className="usage-card-t">{t("settings.usageStats.byProvider")}</div>
              </div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t("settings.usageStats.colProvider")}</th>
                    <th>{t("settings.usageStats.colRequests")}</th>
                    <th>{t("settings.usageStats.colTokens")}</th>
                    <th>{t("settings.usageStats.colSuccessRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byProvider ?? []).map((row) => {
                    const local = isLocalProvider(providerById.get(row.providerId));
                    return (
                      <tr key={row.providerId || "unknown"}>
                        <td>
                          <span className="usage-provider-cell">
                            {nameFor(row.providerId || null)}
                            {local && (
                              <Badge tone="success" className="usage-tag">
                                {t("settings.usageStats.tagLocal")}
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td>{nf(row.turnCount)}</td>
                        <td>{formatCompactTokenCount(row.totalTokens)}</td>
                        <td className={row.successRate >= 0.999 ? "usage-good" : "usage-dim"}>
                          {formatPercent(row.successRate)}
                        </td>
                      </tr>
                    );
                  })}
                  {(breakdown?.byProvider ?? []).length === 0 && (
                    <tr>
                      <td colSpan={4} className="usage-dim">
                        {t("settings.usageStats.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="usage-card">
              <div className="usage-card-h">
                <div className="usage-card-t">{t("settings.usageStats.byModel")}</div>
              </div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t("settings.usageStats.colModel")}</th>
                    <th>{t("settings.usageStats.colRequests")}</th>
                    <th>{t("settings.usageStats.colTokens")}</th>
                    <th>{t("settings.usageStats.colCost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byModel ?? []).map((row) => {
                    const local = isLocalProvider(providerById.get(row.providerId ?? ""));
                    return (
                      <tr key={row.modelId || "unknown"}>
                        <td>{row.modelId || t("settings.usageStats.unknownModel")}</td>
                        <td>{nf(row.turnCount)}</td>
                        <td>{formatCompactTokenCount(row.totalTokens)}</td>
                        <td className={local ? "usage-free" : row.costUsd > 0 ? "usage-good" : "usage-dim"}>
                          {local
                            ? t("settings.usageStats.free")
                            : row.costUsd > 0
                              ? formatCost(row.costUsd)
                              : t("settings.usageStats.unpriced")}
                        </td>
                      </tr>
                    );
                  })}
                  {(breakdown?.byModel ?? []).length === 0 && (
                    <tr>
                      <td colSpan={4} className="usage-dim">
                        {t("settings.usageStats.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Request detail */}
          <div className="usage-card">
            <div className="usage-card-h">
              <div className="usage-card-t">{t("settings.usageStats.detailTitle")}</div>
              <div className="usage-card-r">
                {t("settings.usageStats.detailCount", { count: requestCount })}
              </div>
            </div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t("settings.usageStats.colTime")}</th>
                  <th>{t("settings.usageStats.colProvider")}</th>
                  <th>{t("settings.usageStats.colModel")}</th>
                  <th>{t("settings.usageStats.colInput")}</th>
                  <th>{t("settings.usageStats.colOutput")}</th>
                  <th>{t("settings.usageStats.colCache")}</th>
                  <th>{t("settings.usageStats.colCost")}</th>
                  <th>{t("settings.usageStats.colDuration")}</th>
                  <th>{t("settings.usageStats.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {(breakdown?.recent ?? []).map((row, i) => (
                  <tr key={`${row.timestamp}-${i}`}>
                    <td>{new Date(row.timestamp).toLocaleString()}</td>
                    <td>{nameFor(row.providerId)}</td>
                    <td>{row.modelId || t("settings.usageStats.unknownModel")}</td>
                    <td>{nf(row.inputTokens)}</td>
                    <td>{nf(row.outputTokens)}</td>
                    <td>{nf(row.cacheTokens)}</td>
                    <td className={row.costUsd && row.costUsd > 0 ? "usage-good" : "usage-dim"}>
                      {row.costUsd == null
                        ? t("settings.usageStats.unpriced")
                        : row.costUsd > 0
                          ? formatCost(row.costUsd)
                          : t("settings.usageStats.free")}
                    </td>
                    <td>{formatDuration(row.durationMs)}</td>
                    <td className={row.status === "completed" ? "usage-good" : "usage-warn"}>
                      {row.status === "completed"
                        ? t("settings.usageStats.statusOk")
                        : t("settings.usageStats.statusError")}
                    </td>
                  </tr>
                ))}
                {(breakdown?.recent ?? []).length === 0 && !loading && (
                  <tr>
                    <td colSpan={9} className="usage-dim">
                      {t("settings.usageStats.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
