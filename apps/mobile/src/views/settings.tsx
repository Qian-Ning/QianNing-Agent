import { useState } from "react";
import { BUILTIN_SKINS, type Skin } from "@pi-desktop/shared/skins";
import type { Translate } from "../lib/i18n";
import { applySkin, loadSkinId } from "../lib/skin";
import { loadPrefs, savePrefs, type AgentPrefs } from "../agent/settings";
import { ModelSheet } from "./model-sheet";

type Page = "home" | "appearance" | "model" | "context" | "connection" | "storage";

type Props = {
  t: Translate;
  /** Absent when this phone is paired to a desktop instead of running itself. */
  client?: { listModels?: () => Promise<string[]> };
  modelLabel: string;
  thinking: string;
  onApplyModel: (patch: { modelId: string; thinking: string }) => void;
  connection?: { base: string };
  onDisconnect: () => void;
  /** Real counts, read from the session store. */
  stats: { sessions: number; messages: number };
  onClose: () => void;
};

/**
 * The desktop's settings window, reduced to the pages a phone can honour.
 *
 * Each row here does something real: appearance applies the desktop's skin
 * catalog, the model page changes what the next turn runs on, context changes
 * the answer cap, storage shows what is actually on the device. Pages that need
 * a background service are not drawn at all rather than drawn empty.
 */
export function SettingsView(props: Props) {
  const { t, onClose } = props;
  const [page, setPage] = useState<Page>("home");
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  const [skinId, setSkinId] = useState(loadSkinId);

  const rows: { key: Page; label: string; value?: string }[] = [
    { key: "appearance", label: t("settings.appearance"), value: skinName(skinId) },
    { key: "model", label: t("settings.model"), value: props.modelLabel },
    { key: "context", label: t("settings.context"), value: String(prefs.maxTokens ?? "") },
    { key: "connection", label: t("settings.connection"), value: props.connection?.base ?? t("settings.localHost") },
    { key: "storage", label: t("settings.storage") },
  ];

  return (
    <div className="screen settings">
      <header className="bar">
        <button className="ghost back" onClick={() => (page === "home" ? onClose() : setPage("home"))}>
          ‹ {page === "home" ? t("settings.close") : t("settings.back")}
        </button>
        <h1 className="truncate">{title(t, page)}</h1>
        <div className="bar-actions" />
      </header>

      {page === "home" ? (
        <main className="settings-list">
          {rows.map((row) => (
            <button key={row.key} className="row" onClick={() => setPage(row.key)}>
              <span className="row-title">{row.label}</span>
              <span className="row-meta">
                {row.value}
                <span className="chevron">›</span>
              </span>
            </button>
          ))}
        </main>
      ) : null}

      {page === "appearance" ? (
        <main className="settings-list">
          <p className="muted">{t("settings.appearanceHint")}</p>
          {BUILTIN_SKINS.map((skin) => (
            <button
              key={skin.id}
              className={"row" + (skin.id === skinId ? " chosen" : "")}
              onClick={() => {
                applySkin(skin.id);
                try {
                  localStorage.setItem("qn.mobile.skin", skin.id);
                } catch {
                  // Private mode still renders; it just forgets the choice.
                }
                setSkinId(skin.id);
              }}
            >
              <span className="row-title">
                {skin.name}
                {skin.id === skinId ? <span className="tick"> ✓</span> : null}
              </span>
              <span className="swatches">
                <i style={{ background: skin.tokens.bg }} />
                <i style={{ background: skin.tokens.panel }} />
                <i style={{ background: skin.tokens.accent }} />
              </span>
            </button>
          ))}
        </main>
      ) : null}

      {page === "model" ? (
        <main className="settings-list">
          {props.client?.listModels ? (
            <ModelSheet
              t={t}
              client={props.client}
              model={props.modelLabel}
              thinking={props.thinking as "off"}
              onClose={() => setPage("home")}
              onApply={(patch) => {
                props.onApplyModel(patch);
                setPage("home");
              }}
            />
          ) : (
            <p className="muted">{t("settings.modelRemote")}</p>
          )}
        </main>
      ) : null}

      {page === "context" ? (
        <main className="settings-list">
          <p className="muted">{t("settings.contextHint")}</p>
          <label htmlFor="maxTokens">{t("settings.maxTokens")}</label>
          <input
            id="maxTokens"
            inputMode="numeric"
            value={String(prefs.maxTokens ?? "")}
            onChange={(event) => {
              const next = { ...prefs, maxTokens: Number(event.target.value.replace(/[^0-9]/g, "")) || 0 };
              setPrefs(next);
              savePrefs(next);
            }}
          />
          <p className="muted">
            {t("settings.contextEstimate")} {props.stats.messages}
          </p>
        </main>
      ) : null}

      {page === "connection" ? (
        <main className="settings-list">
          <p className="muted">
            {props.connection ? t("settings.pairedTo") + " " + props.connection.base : t("settings.runningLocal")}
          </p>
          <button className="ghost wide" onClick={props.onDisconnect}>
            {t("settings.disconnect")}
          </button>
        </main>
      ) : null}

      {page === "storage" ? (
        <main className="settings-list">
          <div className="row">
            <span className="row-title">{t("settings.sessions")}</span>
            <span className="row-meta">{props.stats.sessions}</span>
          </div>
          <div className="row">
            <span className="row-title">{t("settings.messages")}</span>
            <span className="row-meta">{props.stats.messages}</span>
          </div>
          <p className="muted">{t("settings.storageHint")}</p>
        </main>
      ) : null}
    </div>
  );
}

function skinName(id: string): string {
  return (BUILTIN_SKINS.find((skin: Skin) => skin.id === id) ?? BUILTIN_SKINS[0])?.name ?? id;
}

function title(t: Translate, page: Page): string {
  switch (page) {
    case "appearance":
      return t("settings.appearance");
    case "model":
      return t("settings.model");
    case "context":
      return t("settings.context");
    case "connection":
      return t("settings.connection");
    case "storage":
      return t("settings.storage");
    default:
      return t("settings.title");
  }
}
