import { useTranslation } from "react-i18next";
import type { UsageProjectStat } from "@pi-desktop/shared";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import { formatUsd } from "../../../lib/usage-insights";

/**
 * Which project the tokens went to.
 *
 * A session carries at most one project (the folder its agent works in), so the
 * rows are disjoint and the column sums to the window's total. Turns whose
 * session has no project are their own row rather than folded into any of them,
 * because "nothing was attributed" is a fact the reader needs, not an omission.
 */
export function UsageProjectTable({ rows }: { rows: UsageProjectStat[] }) {
  const { t } = useTranslation();

  return (
    <div className="usage-card">
      <div className="usage-card-h">
        <div className="usage-card-t">{t("settings.usageStats.byProject")}</div>
      </div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t("settings.usageStats.colProject")}</th>
            <th>{t("settings.usageStats.colRequests")}</th>
            <th>{t("settings.usageStats.colTokens")}</th>
            <th>{t("settings.usageStats.colCost")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.projectId ?? "unattributed"}>
              <td>
                {row.projectName ?? (
                  <span className="usage-dim">{t("settings.usageStats.projectUnattributed")}</span>
                )}
              </td>
              <td>{row.turnCount.toLocaleString()}</td>
              <td>{formatCompactTokenCount(row.totalTokens)}</td>
              <td className={row.costUsd > 0 ? "usage-good" : "usage-dim"}>
                {row.costUsd > 0 ? formatUsd(row.costUsd) : t("settings.usageStats.unpriced")}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="usage-dim">
                {t("settings.usageStats.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
