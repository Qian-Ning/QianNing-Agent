import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProviderPublic,
  TokenUsageHistoryResult,
  UsageBreakdownResult,
} from "@pi-desktop/shared";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { providerDisplayName } from "../../lib/provider-display";
import { Badge, Button, SegmentedControl } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { IconActivity, IconRefresh } from "../icons";

type RangeId = "today" | "7d" | "30d";

const DAY_MS = 86_400_000;

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

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Hand-drawn dual-series trend (input / output lines over a cache-read area),
 * grayscale to match the app theme. Drawn as inline SVG so no chart library is
 * pulled in. Renders a baseline when a range has a single bucket (e.g. today).
 */
function TrendChart({
  items,
  labels,
}: {
  items: TokenUsageHistoryResult["items"];
  labels: { input: string; output: string; cache: string };
}) {
  const W = 720;
  const H = 220;
  const PL = 8;
  const PR = 8;
  const PT = 14;
  const PB = 24;

  const n = items.length;
  const maxV = Math.max(
    1,
    ...items.map((it) => Math.max(it.inputTokens, it.outputTokens, it.cacheReadTokens)),
  );
  const ceil = maxV * 1.15;
  const sx = (i: number) => (n <= 1 ? W / 2 : PL + (W - PL - PR) * (i / (n - 1)));
  const sy = (v: number) => PT + (H - PT - PB) * (1 - v / ceil);
  const pts = (pick: (it: TokenUsageHistoryResult["items"][number]) => number) =>
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

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const y = PT + (H - PT - PB) * (i / 4);
    return (
      <line
        key={i}
        x1={PL}
        y1={y}
        x2={W - PR}
        y2={y}
        className="usage-chart-grid"
        strokeDasharray="3 4"
      />
    );
  });

  // Show at most ~8 x labels so a 30-day range does not crowd.
  const step = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="usage-chartwrap">
      <svg
        className="usage-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${labels.input} / ${labels.output}`}
      >
        {grid}
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
        {inputPts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={n <= 1 ? 3.4 : 2.6} className="usage-series-input-dot" />
        ))}
        {items.map((it, i) =>
          i % step === 0 || i === n - 1 ? (
            <text key={i} x={sx(i)} y={H - 6} className="usage-chart-xlabel" textAnchor="middle">
              {it.date.slice(5)}
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
          api.getTokenUsageHistory({ startDate, endDate, bucket: "day" }),
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
  }, [range, providerFilter, modelFilter, reloadNonce]);

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
  // local; otherwise a paid provider was involved and cost is simply unpriced.
  const allLocal = useMemo(() => {
    const rows = breakdown?.byProvider ?? [];
    return rows.length > 0 && rows.every((p) => isLocalProvider(providerById.get(p.providerId)));
  }, [breakdown, providerById]);

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

  const rangeLabel =
    range === "today"
      ? t("settings.usageStats.rangeToday")
      : range === "7d"
        ? t("settings.usageStats.range7d")
        : t("settings.usageStats.range30d");

  const nf = (value: number) => value.toLocaleString();

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
                    ) : (
                      <span className="usage-dim">{t("settings.usageStats.unpriced")}</span>
                    )}
                  </div>
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
                {rangeLabel} · {t("settings.usageStats.trendDaily")}
              </div>
            </div>
            <TrendChart
              items={history?.items ?? []}
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
                        <td className={local ? "usage-free" : "usage-dim"}>
                          {local
                            ? t("settings.usageStats.free")
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
                    <td colSpan={8} className="usage-dim">
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
