import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelPricingRow } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Input } from "../ui";
import { IconChevronLeft, IconPlus, IconRefresh, IconTrash } from "../icons";

/** A blank row for the "add model" form. */
const EMPTY_DRAFT: ModelPricingRow = {
  modelId: "",
  displayName: "",
  inputCostPerMillion: "0",
  outputCostPerMillion: "0",
  cacheReadCostPerMillion: "0",
  cacheWriteCostPerMillion: "0",
};

/**
 * cc-switch-style editable pricing table. Rates are per-million USD, stored as
 * strings so a typed value round-trips exactly. Every mutation goes through the
 * host RPC and replaces the local list with the authoritative result, so the
 * table can never drift from what is persisted.
 */
export function ModelPricingEditor({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ModelPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelPricingRow>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<ModelPricingRow>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getModelPricing();
      setRows(result.models);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.modelId.toLowerCase().includes(q) ||
        r.displayName.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const beginEdit = (row: ModelPricingRow) => {
    setEditing(row.modelId);
    setDraft({ ...row });
  };

  const saveEdit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateModelPricing(draft);
      setRows(result.models);
      setEditing(null);
    } catch {
      // Keep the editor open on a rejected value so the user can correct it.
    } finally {
      setBusy(false);
    }
  };

  const saveAdd = async () => {
    if (busy || !addDraft.modelId.trim()) return;
    setBusy(true);
    try {
      const result = await api.updateModelPricing(addDraft);
      setRows(result.models);
      setAdding(false);
      setAddDraft(EMPTY_DRAFT);
    } catch {
      // Leave the add form populated so the user can fix the model id / rate.
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: ModelPricingRow) => {
    if (busy) return;
    if (!window.confirm(t("settings.usageStats.pricing.removeConfirm", { model: row.displayName || row.modelId }))) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.deleteModelPricing(row.modelId);
      setRows(result.models);
    } finally {
      setBusy(false);
    }
  };

  const resetDefaults = async () => {
    if (busy) return;
    if (!window.confirm(t("settings.usageStats.pricing.resetConfirm"))) return;
    setBusy(true);
    try {
      const result = await api.resetModelPricing();
      setRows(result.models);
    } finally {
      setBusy(false);
    }
  };

  const rateInputs = (
    value: ModelPricingRow,
    set: (next: ModelPricingRow) => void,
  ) => (
    <>
      <td>
        <Input
          className="usage-price-input"
          inputMode="decimal"
          value={value.inputCostPerMillion}
          onChange={(e) => set({ ...value, inputCostPerMillion: e.target.value })}
        />
      </td>
      <td>
        <Input
          className="usage-price-input"
          inputMode="decimal"
          value={value.outputCostPerMillion}
          onChange={(e) => set({ ...value, outputCostPerMillion: e.target.value })}
        />
      </td>
      <td>
        <Input
          className="usage-price-input"
          inputMode="decimal"
          value={value.cacheReadCostPerMillion}
          onChange={(e) => set({ ...value, cacheReadCostPerMillion: e.target.value })}
        />
      </td>
      <td>
        <Input
          className="usage-price-input"
          inputMode="decimal"
          value={value.cacheWriteCostPerMillion}
          onChange={(e) => set({ ...value, cacheWriteCostPerMillion: e.target.value })}
        />
      </td>
    </>
  );

  return (
    <div className="usage-page">
      <div className="usage-toolbar">
        <div className="usage-pricing-head">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <IconChevronLeft size={14} />
            {t("settings.usageStats.pricing.back")}
          </Button>
          <p className="usage-subtitle">{t("settings.usageStats.pricing.subtitle")}</p>
        </div>
        <div className="usage-filters">
          <Input
            className="usage-pricing-search"
            placeholder={t("settings.usageStats.pricing.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || adding}
            onClick={() => {
              setAdding(true);
              setAddDraft(EMPTY_DRAFT);
            }}
          >
            <IconPlus size={14} />
            {t("settings.usageStats.pricing.add")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={resetDefaults}>
            <IconRefresh size={14} />
            {t("settings.usageStats.pricing.reset")}
          </Button>
        </div>
      </div>

      <div className="usage-card">
        <div className="usage-card-h">
          <div className="usage-card-t">{t("settings.usageStats.pricing.title")}</div>
          <div className="usage-card-r">{t("settings.usageStats.pricing.unit")}</div>
        </div>
        <table className="usage-table usage-pricing-table">
          <thead>
            <tr>
              <th>{t("settings.usageStats.pricing.colModel")}</th>
              <th>{t("settings.usageStats.pricing.colInput")}</th>
              <th>{t("settings.usageStats.pricing.colOutput")}</th>
              <th>{t("settings.usageStats.pricing.colCacheRead")}</th>
              <th>{t("settings.usageStats.pricing.colCacheWrite")}</th>
              <th>{t("settings.usageStats.pricing.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {adding && (
              <tr className="usage-pricing-editrow">
                <td>
                  <Input
                    className="usage-price-id"
                    placeholder={t("settings.usageStats.pricing.modelIdPlaceholder")}
                    value={addDraft.modelId}
                    onChange={(e) => setAddDraft({ ...addDraft, modelId: e.target.value })}
                  />
                </td>
                {rateInputs(addDraft, setAddDraft)}
                <td>
                  <div className="usage-price-actions">
                    <Button variant="primary" size="sm" disabled={busy || !addDraft.modelId.trim()} onClick={saveAdd}>
                      {t("settings.usageStats.pricing.save")}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(false)}>
                      {t("settings.usageStats.pricing.cancel")}
                    </Button>
                  </div>
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const isEditing = editing === row.modelId;
              if (isEditing) {
                return (
                  <tr key={row.modelId} className="usage-pricing-editrow">
                    <td>
                      <span className="usage-price-modelname">{row.modelId}</span>
                    </td>
                    {rateInputs(draft, setDraft)}
                    <td>
                      <div className="usage-price-actions">
                        <Button variant="primary" size="sm" disabled={busy} onClick={saveEdit}>
                          {t("settings.usageStats.pricing.save")}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                          {t("settings.usageStats.pricing.cancel")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.modelId}>
                  <td>
                    <span className="usage-price-modelname">
                      {row.displayName || row.modelId}
                      {row.displayName && row.displayName !== row.modelId && (
                        <Badge tone="neutral" className="usage-tag usage-price-idtag">
                          {row.modelId}
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td>{row.inputCostPerMillion}</td>
                  <td>{row.outputCostPerMillion}</td>
                  <td>{row.cacheReadCostPerMillion}</td>
                  <td>{row.cacheWriteCostPerMillion}</td>
                  <td>
                    <div className="usage-price-actions">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => beginEdit(row)}>
                        {t("settings.usageStats.pricing.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={t("settings.usageStats.pricing.remove")}
                        onClick={() => remove(row)}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && filtered.length === 0 && !adding && (
              <tr>
                <td colSpan={6} className="usage-dim">
                  {t("settings.usageStats.pricing.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
