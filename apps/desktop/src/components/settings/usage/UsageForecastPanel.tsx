import { useTranslation } from "react-i18next";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import type { UsageAnomaly, UsageForecast } from "../../../lib/usage-insights";
import { IconActivity } from "../../icons";

/**
 * What the trend is about to do, and where it already jumped.
 *
 * Both readings come from the same dense series the chart plots, so this panel
 * never needs a second request: the projection is a least-squares fit over the
 * buckets that carry data, and the anomalies are the buckets that sit far above
 * their own median.
 */
export function UsageForecastPanel({
  forecast,
  anomalies,
}: {
  forecast: UsageForecast | null;
  anomalies: UsageAnomaly[];
}) {
  const { t } = useTranslation();
  if (!forecast && anomalies.length === 0) return null;

  return (
    <div className="usage-forecast">
      {forecast && (
        <div className="usage-forecast-main">
          <div className="usage-forecast-icon">
            <IconActivity size={16} />
          </div>
          <div className="usage-forecast-body">
            <div className="usage-forecast-k">
              {t("settings.usageStats.forecastTitle", { days: forecast.horizon })}
            </div>
            <div className="usage-forecast-v">
              {formatCompactTokenCount(Math.round(forecast.totalTokens))}
              <small
                className={
                  forecast.declining ? "usage-forecast-trend down" : "usage-forecast-trend up"
                }
              >
                {forecast.declining
                  ? t("settings.usageStats.forecastDown")
                  : t("settings.usageStats.forecastUp")}
              </small>
            </div>
            <div className="usage-forecast-note">
              {t("settings.usageStats.forecastNote", {
                count: forecast.basisCount,
                perBucket: formatCompactTokenCount(Math.round(forecast.perBucket)),
              })}
            </div>
          </div>
        </div>
      )}

      {anomalies.length > 0 && (
        <div className="usage-anomalies">
          <div className="usage-anomalies-h">
            {t("settings.usageStats.anomalyTitle", { count: anomalies.length })}
          </div>
          <ul className="usage-anomalies-list">
            {anomalies.map((anomaly) => (
              <li key={anomaly.date} className="usage-anomaly">
                <span className="usage-anomaly-date">{anomaly.date}</span>
                <span className="usage-anomaly-tokens">
                  {formatCompactTokenCount(anomaly.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
