/**
 * The workbench's model menu.
 *
 * A generation model is not a conversation model: the workbench must offer the
 * rows that can actually render — enabled providers that carry a credential (or
 * need none) — because an OAuth-only provider has no video or image endpoint to
 * call. Following the same anchored-menu pattern as the subagent and default
 * model pickers keeps one control definition across the app: local filtering,
 * a scroll-bounded grouped list, and keyboard movement.
 *
 * The first row is not a model: it means "use the binding the settings own",
 * which is what the Agent tools use too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx, Input } from "../../components/ui";
import { IconCheck, IconChevronDown, IconSearch } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";

export type WorkbenchModelChoice = { providerId: string; modelId: string };

export type WorkbenchModelOption = WorkbenchModelChoice & {
  providerName: string;
  /** Display label: a model alias when the provider set one, else the wire id. */
  label: string;
  /** True for the binding host settings currently hold. */
  isDefault: boolean;
  /** True when the provider runs on this machine or the local network. */
  local?: boolean;
  /** True when the model is one of the capability's configured candidates. */
  isCandidate: boolean;
};

type Row = WorkbenchModelOption & { key: string; startsGroup: boolean; divided: boolean };

export function WorkbenchModelPicker({
  value,
  options,
  disabled = false,
  onChange,
}: {
  /** Null means the configured binding. */
  value: WorkbenchModelChoice | null;
  options: readonly WorkbenchModelOption[];
  disabled?: boolean;
  onChange: (next: WorkbenchModelChoice | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState("__default__");
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const keyOf = (choice: WorkbenchModelChoice | null) =>
    choice ? `${choice.providerId}\u0000${choice.modelId}` : "__default__";

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    options.forEach((option, index) => {
      const previous = options[index - 1];
      list.push({
        ...option,
        key: `${option.providerId}\u0000${option.modelId}`,
        startsGroup: !previous || previous.providerId !== option.providerId,
        divided: Boolean(previous) && previous.providerId !== option.providerId,
      });
    });
    return list;
  }, [options]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    // The provider name is part of the haystack so a provider narrows to its
    // own models without the user knowing a model id.
    return rows.filter((row) =>
      `${row.providerName} ${row.label} ${row.modelId}`.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const visibleKeys = useMemo(
    () => ["__default__", ...visible.map((row) => row.key)],
    [visible],
  );

  useEffect(() => {
    setActiveKey((current) =>
      visibleKeys.includes(current) ? current : (visibleKeys[0] ?? "__default__"),
    );
  }, [visibleKeys]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (key: string) => {
    const row = rows.find((entry) => entry.key === key);
    onChange(row ? { providerId: row.providerId, modelId: row.modelId } : null);
    close();
  };

  const moveActive = (delta: number) => {
    if (visibleKeys.length === 0) return;
    const index = visibleKeys.indexOf(activeKey);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : visibleKeys.length - 1
        : (index + delta + visibleKeys.length) % visibleKeys.length;
    setActiveKey(visibleKeys[next] ?? "__default__");
  };

  const currentKey = keyOf(value);
  const selected = rows.find((row) => row.key === currentKey) ?? null;
  const triggerLabel = selected
    ? `${selected.providerName} · ${selected.label}`
    : t("workbench.modelFollowDefault");

  return (
    <AnchoredMenu
      className="provider-service-anchor"
      open={open}
      onClose={close}
      menuClassName="provider-service-menu"
      label={t("workbench.model")}
      initialFocus="input"
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className="field-select provider-service-trigger"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t("workbench.model")}
          onClick={() => {
            setQuery("");
            setActiveKey(currentKey);
            setOpen((current) => !current);
          }}
        >
          <span className="provider-service-trigger-label">{triggerLabel}</span>
          <IconChevronDown className="provider-service-trigger-chevron" size={14} aria-hidden />
        </button>
      )}
    >
      <div className="provider-service-search">
        <IconSearch size={14} aria-hidden />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("workbench.modelSearch")}
          aria-label={t("workbench.modelSearch")}
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (visibleKeys.includes(activeKey)) choose(activeKey);
            }
          }}
        />
      </div>
      <div className="provider-service-results" role="presentation">
        {visible.length === 0 && query.trim() ? (
          <div className="provider-service-no-results">{t("workbench.modelNoMatches")}</div>
        ) : null}
        <ul className="provider-service-list">
          <li>
            <button
              ref={(node) => {
                if (node) optionRefs.current.set("__default__", node);
                else optionRefs.current.delete("__default__");
              }}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={currentKey === "__default__"}
              className={cx(
                "provider-service-option",
                currentKey === "__default__" && "is-current",
                activeKey === "__default__" && "is-active",
              )}
              onMouseEnter={() => setActiveKey("__default__")}
              onClick={() => choose("__default__")}
            >
              <span className="provider-service-option-check" aria-hidden>
                {currentKey === "__default__" ? <IconCheck size={12} /> : null}
              </span>
              <span className="provider-service-option-label">
                {t("workbench.modelFollowDefault")}
              </span>
            </button>
          </li>
          {visible.map((row) => {
            const isCurrent = row.key === currentKey;
            const isActive = row.key === activeKey;
            return (
              <li key={row.key}>
                {row.startsGroup ? (
                  <div className={cx("provider-service-group", row.divided && "has-divider")}>
                    {row.providerName}
                  </div>
                ) : null}
                <button
                  ref={(node) => {
                    if (node) optionRefs.current.set(row.key, node);
                    else optionRefs.current.delete(row.key);
                  }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isCurrent}
                  className={cx(
                    "provider-service-option",
                    isCurrent && "is-current",
                    isActive && "is-active",
                  )}
                  onMouseEnter={() => setActiveKey(row.key)}
                  onClick={() => choose(row.key)}
                >
                  <span className="provider-service-option-check" aria-hidden>
                    {isCurrent ? <IconCheck size={12} /> : null}
                  </span>
                  <span className="provider-service-option-label font-mono">{row.label}</span>
                  {row.label !== row.modelId ? (
                    <span className="provider-service-option-note">{row.modelId}</span>
                  ) : null}
                  {row.isCandidate ? (
                    <span className="workbench-model-badge">{t("workbench.modelCandidate")}</span>
                  ) : null}
                  {row.local ? (
                    <span className="workbench-model-badge">{t("workbench.modelLocal")}</span>
                  ) : null}
                  {row.isDefault ? (
                    <span className="workbench-model-badge">{t("workbench.modelConfigured")}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </AnchoredMenu>
  );
}
