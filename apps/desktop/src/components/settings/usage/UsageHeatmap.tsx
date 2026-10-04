import { useTranslation } from "react-i18next";
import type { HeatmapCell } from "../../../lib/usage-insights";
import { formatCompactTokenCount } from "@pi-desktop/shared";

/**
 * A year-in-review calendar of token spend: one cell per day, one column per
 * week, Monday-through-Sunday rows.
 *
 * The host returns a dense series for `day` buckets, so a gap in the grid means
 * a day with no usage rather than a day with no data — the two are the same
 * thing here and the empty cell is the honest mark for it.
 */
export function UsageHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const { t } = useTranslation();
  const empty = t("settings.usageStats.heatmapEmpty");
  if (cells.length === 0) {
    return <div className="usage-heat-empty">{empty}</div>;
  }

  // The grid fills column-by-column, Sunday first, so the leading days of the
  // first week are blanks rather than a diagonal start.
  const pad = cells[0]?.weekday ?? 0;
  const slots: Array<HeatmapCell | null> = [
    ...new Array<null>(pad).fill(null),
    ...cells,
  ];

  return (
    <div className="usage-heat">
      <div className="usage-heat-grid" role="img" aria-label={t("settings.usageStats.heatmapTitle")}>
        {slots.map((cell, index) =>
          cell === null ? (
            <div key={`pad-${index}`} className="usage-heat-cell usage-heat-pad" aria-hidden="true" />
          ) : (
            <div
              key={cell.date}
              className={`usage-heat-cell usage-heat-l${cell.level}`}
              title={`${cell.date} · ${formatCompactTokenCount(cell.tokens)}`}
            />
          ),
        )}
      </div>
      <div className="usage-heat-legend">
        <span>{t("settings.usageStats.heatmapLess")}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`usage-heat-swatch usage-heat-l${level}`} />
        ))}
        <span>{t("settings.usageStats.heatmapMore")}</span>
      </div>
    </div>
  );
}
