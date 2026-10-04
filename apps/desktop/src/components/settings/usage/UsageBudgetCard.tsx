import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageBudgetSettings } from "@pi-desktop/shared";
import { formatUsd } from "../../../lib/usage-insights";
import { budgetState, monthLabel, parseBudgetInput } from "../../../lib/usage-budget";
import { Button, Input } from "../../ui";
import { IconTriangleAlert, IconWallet } from "../../icons";

type Props = {
  /** Estimated USD spent since the start of the current local month. */
  spentUsd: number;
  /** Turns inside that month whose model has no price, so `spentUsd` is a floor. */
  unpricedTurns: number;
  /** Local start of the current month, epoch ms; the host supplies it. */
  monthStart: number;
  /** The stored ceiling, or undefined when the user has never set one. */
  budget: UsageBudgetSettings | undefined;
  /** BCP-47 tag for the month name; comes from the active i18n language. */
  locale: string;
  /** Persist a new ceiling. Rejects on failure so the field can stay dirty. */
  onSave: (budget: UsageBudgetSettings) => Promise<void>;
};

/**
 * The monthly spend ceiling (D657): the amount, the month-to-date figure, and
 * how the two compare.
 *
 * The field is a draft until blur or Enter, so a half-typed `1` never persists a
 * one-dollar ceiling. Clearing the field removes the ceiling — that is the only
 * removal affordance a keyboard user has, so it must not read as invalid.
 */
export function UsageBudgetCard({
  spentUsd,
  unpricedTurns,
  monthStart,
  budget,
  locale,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const saved = budget?.monthlyUsd ?? null;
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // The stored value is the truth: a save from another surface, a settings
  // reload, or a normalization on read all arrive here and reset the field.
  useEffect(() => {
    setDraft(saved === null ? "" : String(saved));
    setFailed(false);
  }, [saved]);

  const state = useMemo(() => budgetState(spentUsd, saved), [spentUsd, saved]);
  const month = useMemo(() => monthLabel(monthStart, locale), [monthStart, locale]);

  const commit = async () => {
    const parsed = parseBudgetInput(draft);
    if (parsed.kind === "invalid") {
      setFailed(true);
      return;
    }
    const next = parsed.kind === "clear" ? null : parsed.usd;
    if (next === saved) {
      setDraft(saved === null ? "" : String(saved));
      setFailed(false);
      return;
    }
    setSaving(true);
    try {
      await onSave({ monthlyUsd: next });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const percent = Math.round(state.rawRatio * 100);
  const savedText = saved === null ? "" : String(saved);
  const dirty = draft !== savedText;

  return (
    <section className={`usage-budget is-${state.level}`}>
      <div className="usage-budget-head">
        <div className="usage-budget-title">
          <IconWallet size={16} />
          <span>{t("settings.usageStats.budgetTitle")}</span>
        </div>
        {month ? <div className="usage-budget-month">{month}</div> : null}
      </div>

      <div className="usage-budget-body">
        <div className="usage-budget-figures">
          <div>
            <div className="usage-budget-k">{t("settings.usageStats.budgetSpent")}</div>
            <div className="usage-budget-v">{formatUsd(state.spentUsd)}</div>
          </div>
          <div className="usage-budget-field">
            <label className="usage-budget-k" htmlFor="usage-budget-amount">
              {t("settings.usageStats.budgetCeiling")}
            </label>
            <Input
              id="usage-budget-amount"
              inputMode="decimal"
              placeholder={t("settings.usageStats.budgetPlaceholder")}
              value={draft}
              disabled={saving}
              aria-invalid={failed}
              onChange={(event) => {
                setDraft(event.target.value);
                setFailed(false);
              }}
              onBlur={() => void commit()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit();
                }
              }}
            />
          </div>
          {dirty ? (
            <Button variant="secondary" onClick={() => void commit()} disabled={saving}>
              {t("settings.usageStats.budgetSave")}
            </Button>
          ) : null}
        </div>

        {state.level === "none" ? (
          <p className="usage-budget-hint">{t("settings.usageStats.budgetHint")}</p>
        ) : (
          <>
            <div
              className="usage-budget-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, percent)}
              aria-label={t("settings.usageStats.budgetProgressLabel")}
            >
              <span className="usage-budget-fill" style={{ width: `${state.ratio * 100}%` }} />
            </div>
            <div className="usage-budget-note">
              {state.level === "over"
                ? t("settings.usageStats.budgetOver", {
                    amount: formatUsd(state.overspendUsd),
                    percent,
                  })
                : state.level === "approaching"
                  ? t("settings.usageStats.budgetApproaching", {
                      amount: formatUsd(state.remainingUsd ?? 0),
                      percent,
                    })
                  : t("settings.usageStats.budgetRemaining", {
                      amount: formatUsd(state.remainingUsd ?? 0),
                    })}
            </div>
          </>
        )}

        {state.level === "over" ? (
          <p className="usage-budget-alert" role="status">
            <IconTriangleAlert size={14} />
            {t("settings.usageStats.budgetAlert", { percent })}
          </p>
        ) : null}

        {/* An unpriced model makes the month figure a floor, so the reader is
            told before they read "under budget" as a fact. */}
        {unpricedTurns > 0 ? (
          <p className="usage-budget-caveat">
            {t("settings.usageStats.budgetUnpricedNote", { count: unpricedTurns })}
          </p>
        ) : null}

        {failed ? (
          <p className="usage-budget-error" role="alert">
            {t("settings.usageStats.budgetInvalid")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
