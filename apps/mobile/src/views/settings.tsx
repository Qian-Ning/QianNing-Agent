import { useEffect, useState } from "react";
import { BUILTIN_SKINS } from "@pi-desktop/shared/skins";
import type { Translate } from "../lib/i18n";
import type { HostClient, ThinkingLevel } from "../lib/racp";
import { loadSkinId, saveSkinId } from "../lib/skin";
import { loadPrefs, savePrefs, type AgentPrefs } from "../agent/settings";
import { ModelSheet } from "./model-sheet";
import { NotificationsPage } from "./notifications-page";
import { SchedulesPage } from "./schedules-page";
import { loadNotices, subscribeNotices, unreadCount } from "../agent/notifications";
import { loadSchedules } from "../agent/schedules";

type Page =
  | "root"
  | "general"
  | "model"
  | "appearance"
  | "notifications"
  | "schedules"
  | "connection"
  | "remote"
  | "usage"
  | "about";

type Props = {
  t: Translate;
  client?: HostClient;
  modelLabel: string;
  thinking: ThinkingLevel;
  onApplyModel: (patch: { modelId: string; thinking: ThinkingLevel }) => void;
  connection?: { base: string };
  onConnectRemote: (base: string, token: string) => Promise<void>;
  onDisconnect: () => void;
  stats: { sessions: number; messages: number };
  /** Jump straight to the conversation a notification belongs to. */
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
};

const FONT_STEPS = ["1", "1.06", "1.12"] as const;

function readFontStep(): string {
  const raw = localStorage.getItem("qn.font-scale");
  return raw && (FONT_STEPS as readonly string[]).includes(raw) ? raw : "1";
}

/**
 * Settings shaped like the desktop's: a list of destinations, each opening a
 * page of its own. Anything this build cannot do is stated on its page rather
 * than drawn as a switch that does nothing.
 */
export function SettingsView({
  t,
  client,
  modelLabel,
  thinking,
  onApplyModel,
  connection,
  onConnectRemote,
  onDisconnect,
  stats,
  onOpenSession,
  onClose,
}: Props) {
  const [page, setPage] = useState<Page>("root");
  const [skinId, setSkinId] = useState(loadSkinId());
  const [fontStep, setFontStep] = useState(readFontStep());
  const [prefs, setPrefs] = useState<AgentPrefs>(() => loadPrefs());
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [unread, setUnread] = useState(() => unreadCount(loadNotices()));

  useEffect(() => {
    const refresh = () => setUnread(unreadCount(loadNotices()));
    refresh();
    return subscribeNotices(refresh);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", fontStep);
    localStorage.setItem("qn.font-scale", fontStep);
  }, [fontStep]);

  const chooseSkin = (id: string) => {
    saveSkinId(id);
    setSkinId(id);
  };

  const header = (title: string, back: Page | null) => (
    <header className="bar">
      {back ? (
        <button className="ghost back" onClick={() => setPage(back)} aria-label={t("settings.back")}>
          ‹
        </button>
      ) : null}
      <h1>{title}</h1>
      {page === "root" ? (
        <div className="bar-actions">
          <button className="ghost" onClick={onClose}>
            {t("settings.done")}
          </button>
        </div>
      ) : null}
    </header>
  );

  if (page === "root") {
    const rows: { key: Page; label: string; value?: string }[] = [
      { key: "general", label: t("settings.general") },
      { key: "model", label: t("settings.model"), value: modelLabel },
      { key: "appearance", label: t("settings.appearance"), value: BUILTIN_SKINS.find((s) => s.id === skinId)?.name },
      { key: "notifications", label: t("settings.notifications"), value: unread > 0 ? String(unread) : undefined },
      {
        key: "schedules",
        label: t("settings.schedules"),
        value: loadSchedules().filter((entry) => entry.enabled).length
          ? String(loadSchedules().filter((entry) => entry.enabled).length)
          : undefined,
      },
      { key: "connection", label: t("settings.connection"), value: connection ? connection.base : t("settings.thisPhone") },
      { key: "remote", label: t("settings.remoteAccess") },
      { key: "usage", label: t("settings.usage") },
      { key: "about", label: t("settings.about") },
    ];
    return (
      <div className="screen settings">
        {header(t("settings.title"), null)}
        <div className="settings-list">
          {rows.map((row) => (
            <button key={row.key} className="row" onClick={() => setPage(row.key)}>
              <span className="row-title">{row.label}</span>
              <span className="row-meta">
                {row.value}
                <span className="chevron">›</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (page === "notifications") {
    return (
      <div className="screen settings">
        {header(t("settings.notifications"), "root")}
        <NotificationsPage t={t} onOpenSession={onOpenSession} />
      </div>
    );
  }

  if (page === "schedules") {
    return (
      <div className="screen settings">
        {header(t("settings.schedules"), "root")}
        <SchedulesPage t={t} />
      </div>
    );
  }

  if (page === "general") {
    return (
      <div className="screen settings">
        {header(t("settings.general"), "root")}
        <div className="settings-list">
          <label>{t("settings.fontSize")}</label>
          <div className="levels">
            {FONT_STEPS.map((step) => (
              <button
                key={step}
                className={"level" + (step === fontStep ? " chosen" : "")}
                onClick={() => setFontStep(step)}
              >
                {step === "1" ? "标准" : step === "1.06" ? "大" : "特大"}
              </button>
            ))}
          </div>
          <label>{t("settings.data")}</label>
          <div className="row">
            <span className="row-title">{t("settings.sessions")}</span>
            <span className="row-meta">{stats.sessions}</span>
          </div>
          <div className="row">
            <span className="row-title">{t("settings.messages")}</span>
            <span className="row-meta">{stats.messages}</span>
          </div>
        </div>
      </div>
    );
  }

  if (page === "appearance") {
    return (
      <div className="screen settings">
        {header(t("settings.appearance"), "root")}
        <div className="settings-list">
          <p className="muted">{t("settings.skinHint")}</p>
          {BUILTIN_SKINS.map((skin) => (
            <button key={skin.id} className="row" onClick={() => chooseSkin(skin.id)}>
              <span className="row-title">{skin.name}</span>
              <span className="swatches">
                {skin.id === "none" ? (
                  <span className="row-meta">{t("settings.followSystem")}</span>
                ) : (
                  <>
                    <i style={{ background: skin.tokens.bg }} />
                    <i style={{ background: skin.tokens.panel }} />
                    <i style={{ background: skin.tokens.accent }} />
                  </>
                )}
                {skin.id === skinId ? <span className="tick">✓</span> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (page === "model") {
    return (
      <div className="screen settings">
        {header(t("settings.model"), "root")}
        <div className="settings-list">
          <button className="row" onClick={() => setModelOpen(true)}>
            <span className="row-title">{t("settings.model")}</span>
            <span className="row-meta">
              {modelLabel}
              <span className="chevron">›</span>
            </span>
          </button>
          <button className="row" onClick={() => setModelOpen(true)}>
            <span className="row-title">{t("chat.thinking")}</span>
            <span className="row-meta">{thinking}</span>
          </button>
          <label>{t("settings.systemPrompt")}</label>
          <textarea
            value={prefs.systemPrompt ?? ""}
            onChange={(event) => setPrefs({ ...prefs, systemPrompt: event.target.value })}
            placeholder={t("settings.systemPromptHint")}
            rows={4}
          />
          <button
            className="primary wide"
            onClick={() => {
              savePrefs(prefs);
              setNotice(t("settings.saved"));
            }}
          >
            {t("settings.save")}
          </button>
          {notice ? <p className="muted">{notice}</p> : null}
        </div>
        {modelOpen ? (
          <ModelSheet
            t={t}
            client={client ?? {}}
            model={modelLabel}
            thinking={thinking}
            onClose={() => setModelOpen(false)}
            onApply={(patch) => {
              onApplyModel(patch);
              setModelOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  }

  if (page === "connection") {
    return (
      <div className="screen settings">
        {header(t("settings.connection"), "root")}
        <div className="settings-list">
          <label>{t("settings.thisPhone")}</label>
          <p className="muted">{t("settings.localHint")}</p>

          <label>{t("settings.pairDesktop")}</label>
          <p className="muted">{t("settings.pairHint")}</p>
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="https://192.168.1.10:4331"
          />
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("settings.pairToken")}
            type="password"
          />
          <button className="primary wide" disabled={busy} onClick={() => void connect()}>
            {busy ? t("connect.busy") : t("settings.connect")}
          </button>
          {connection ? (
            <button className="ghost wide" onClick={onDisconnect}>
              {t("settings.disconnect")}
            </button>
          ) : null}
          {notice ? <p className="muted">{notice}</p> : null}
        </div>
      </div>
    );
  }

  if (page === "remote") {
    return (
      <div className="screen settings">
        {header(t("settings.remoteAccess"), "root")}
        <div className="settings-list">
          <p className="muted">{t("settings.remoteBody")}</p>
        </div>
      </div>
    );
  }

  if (page === "usage") {
    return (
      <div className="screen settings">
        {header(t("settings.usage"), "root")}
        <div className="settings-list">
          <div className="row">
            <span className="row-title">{t("settings.sessions")}</span>
            <span className="row-meta">{stats.sessions}</span>
          </div>
          <div className="row">
            <span className="row-title">{t("settings.messages")}</span>
            <span className="row-meta">{stats.messages}</span>
          </div>
          <p className="muted">{t("settings.usageHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen settings">
      {header(t("settings.about"), "root")}
      <div className="settings-list">
        <div className="row">
          <span className="row-title">{t("app.name")}</span>
          <span className="row-meta">2.2.0</span>
        </div>
        <div className="row">
          <span className="row-title">{t("settings.build")}</span>
          <span className="row-meta">{__BUILD_STAMP__}</span>
        </div>
        <p className="muted">{t("settings.aboutBody")}</p>
      </div>
    </div>
  );

  async function connect(): Promise<void> {
    if (!base.trim() || !token.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await onConnectRemote(base.trim(), token.trim());
      setNotice(t("settings.connected"));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }
}
