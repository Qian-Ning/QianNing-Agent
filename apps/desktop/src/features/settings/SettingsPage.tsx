import type {
  AppSettings,
  GlobalPermissionMode,
  PluginScenicThemesDestinationMeta,
  RedactionTableStatus,
  ShortcutPlatform,
} from "@pi-desktop/shared";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconActivity,
  IconArchive,
  IconBookOpen,
  IconBot,
  IconChartColumn,
  IconChat,
  IconChevronLeft,
  IconCloudDown,
  IconDownload,
  IconInfo,
  IconKeyboard,
  IconMic,
  IconPalette,
  IconSearch,
  IconServer,
  IconSliders,
  IconSmartphone,
  IconSparkles,
} from "../../components/icons";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import { ConfigSyncPage } from "../../components/settings/ConfigSyncPage";
import { FontFamilyRow } from "../../components/settings/FontFamilyRow";
import { FontSizeRow } from "../../components/settings/FontSizeRow";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { LanguageRow } from "../../components/settings/LanguageRow";
import { MessagingPlatformsPage } from "../../components/settings/MessagingPlatformsPage";
import { ModelConfigPage } from "../../components/settings/ModelConfigPage";
import { NetworkProxySection } from "../../components/settings/NetworkProxySection";
import { PluginScenicThemesDestination } from "../../components/settings/PluginScenicThemesDestination";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { ThemeRow } from "../../components/settings/ThemeRow";
import { ThinkingDisplayModeRow } from "../../components/settings/ThinkingDisplayModeRow";
import { UsagePage } from "../../components/settings/UsagePage";
import { Badge, Button, cx, SegmentedControl, SettingsToggle } from "../../components/ui";
import { api } from "../../lib/api";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import {
  isSettingsDestinationHidden,
  SETTINGS_NAV_GROUP_LABELS,
  type SettingsNavGroupId,
  visibleSettingsNav,
} from "../../lib/settings-search";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { useAppStore } from "../../stores/app-store";
import { UpdatesRow } from "./agent-sections";
import { CloseBehaviorSection, DeveloperSection } from "./developer-sections";
import { ImportSection } from "./import-page";
import {
  CommandShellRow,
  ContextUsageDisplayRow,
  LargePasteThresholdRow,
  LinkOpenTargetRow,
  SettingsCard,
  SettingsRow,
} from "./primitives";
import { RemoteAccessCard } from "./RemoteAccessCard";
import { VoiceSettingsSection } from "./voice/VoiceSettingsSection";

type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

type NavItem = {
  id: SettingsTab;
  labelKey: string;
  titleKey: string;
  icon: ReactNode;
  group: SettingsNavGroupId;
  experimentalBadgeKey?: string;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
};

export function SettingsPage() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const settingsTabNonce = useAppStore((s) => s.settingsTabNonce);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const version = useAppStore((s) => s.version);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;

  // Experimental feature surfaces remain available in development builds only.
  const includeDevelopmentOnly = import.meta.env.DEV;
  const developerMode = settings?.developerMode === true;
  // The phone surface hides destinations that only exist for a desktop — a
  // keyboard-shortcut editor has nothing to bind without a hardware keyboard.
  const surface = document.documentElement.dataset.surface === "mobile" ? "mobile" : "desktop";
  const navEntries = useMemo(
    () => visibleSettingsNav(developerMode, includeDevelopmentOnly, surface),
    [developerMode, includeDevelopmentOnly, surface],
  );
  const tabHidden = isSettingsDestinationHidden(
    tab,
    developerMode,
    includeDevelopmentOnly,
    surface,
  );

  const [query, setQuery] = useState("");
  const [recoveringSettings, setRecoveringSettings] = useState(!settings);
  const [settingsRecoveryFailed, setSettingsRecoveryFailed] = useState(false);
  const [extensions, setExtensions] = useState<PluginScenicThemesDestinationMeta[]>([]);
  const [activeExtension, setActiveExtension] = useState<PluginScenicThemesDestinationMeta | null>(null);
  const [redactionTable, setRedactionTable] = useState<RedactionTableStatus | null>(null);
  const [clearingRedactionTable, setClearingRedactionTable] = useState(false);
  const seenSettingsTabNonce = useRef(settingsTabNonce);
  // setSettingsTab means "show this built-in category", even when the tab id
  // does not change. Dismiss a plugin page before paint; an anchor-only deep
  // link has to do the same or the row lookup hits the plugin instead.
  if (
    seenSettingsTabNonce.current !== settingsTabNonce ||
    (activeExtension && settingsAnchor)
  ) {
    seenSettingsTabNonce.current = settingsTabNonce;
    if (activeExtension) setActiveExtension(null);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const settingsSearchRef = useRef<HTMLInputElement>(null);
  const destination = activeExtension ? `extension:${activeExtension.ref}` : `builtin:${tab}`;

  useLayoutEffect(() => {
    // On a phone this focus opens the soft keyboard the moment settings loads,
    // covering the very directory the reader came to look at. Focus stays a
    // pointer decision there.
    if (document.documentElement.dataset.surface === "mobile") return;
    settingsSearchRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    // Reset before paint and before the search-anchor effect positions its row.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [destination]);

  useEffect(() => {
    const refresh = () => void api.listPluginScenicThemesDestinations().then(setExtensions, () => setExtensions([]));
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  useEffect(() => {
    if (activeExtension && !extensions.some((entry) => entry.ref === activeExtension.ref)) {
      setActiveExtension(null);
      setSettingsTab("general");
    }
  }, [activeExtension, extensions, setSettingsTab]);

  // A hidden destination must not keep rendering: leave the page the rail no
  // longer offers (Cloud sync is retained in the build but absent from the
  // index) and fall back to General.
  useEffect(() => {
    if (!settings || !tabHidden) return;
    setSettingsTab("general");
  }, [settings, tabHidden, setSettingsTab]);

  const recoverSettings = useCallback(async () => {
    setRecoveringSettings(true);
    setSettingsRecoveryFailed(false);
    try {
      const recovered = await api.getSettings();
      useAppStore.setState({ settings: recovered });
    } catch {
      setSettingsRecoveryFailed(true);
    } finally {
      setRecoveringSettings(false);
    }
  }, []);

  useEffect(() => {
    if (settings) return;
    void recoverSettings();
  }, [settings, recoverSettings]);

  // The count is read when the switch is on and after every clear. It is not a
  // live subscription: the table only changes on a turn, and a settings page
  // that polled would keep the sidecar busy for nothing.
  useEffect(() => {
    if (settings?.redaction?.enabled !== true) {
      setRedactionTable(null);
      return;
    }
    let cancelled = false;
    void api
      .getRedactionStatus()
      .then((status) => {
        if (!cancelled) setRedactionTable(status);
      })
      .catch(() => {
        if (!cancelled) setRedactionTable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.redaction?.enabled]);

  const clearRedactionTable = useCallback(async () => {
    setClearingRedactionTable(true);
    try {
      await api.clearRedactionTable();
      setRedactionTable(await api.getRedactionStatus());
    } finally {
      setClearingRedactionTable(false);
    }
  }, []);

  // Arriving from the global search dialog: scroll to and flash the row
  // whose title matches the pending anchor key. This runs after the
  // destination reset and before paint, so a category change does not flash
  // the top. Rows are located by their translated title so async tab content
  // (providers, import) needs no per-row wiring; a short retry window covers
  // late mounts.
  useLayoutEffect(() => {
    if (!settingsAnchor) return;
    const target = t(settingsAnchor).trim();
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const titles = document.querySelectorAll<HTMLElement>(
        ".settings-content .settings-row-title, .settings-content .settings-card-heading",
      );
      const match = [...titles].find(
        (node) => node.textContent?.trim() === target,
      );
      if (match) {
        const row =
          match.closest<HTMLElement>(".settings-row") ??
          match.closest<HTMLElement>(".settings-card-block") ??
          match;
        row.scrollIntoView({ block: "center" });
        row.classList.add("settings-anchor-flash");
        window.setTimeout(
          () => row.classList.remove("settings-anchor-flash"),
          1800,
        );
        setSettingsAnchor(null);
        return;
      }
      if (attempt < 8) timer = window.setTimeout(() => tryFind(attempt + 1), 120);
      else setSettingsAnchor(null);
    };
    tryFind(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsAnchor, tab, t, setSettingsAnchor]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const nextSettings = { ...settings, ...patch };
    await api.setSettings(nextSettings);
    useAppStore.setState({ settings: nextSettings });
    await refreshProviders();
  };

  const selectPluginTheme = async (theme: string) => {
    await saveSettings({ theme: theme as AppSettings["theme"] });
  };

  // Nav structure comes from the shared settings index (lib/settings-search)
  // so the global search dialog and this page stay in sync; only the icons
  // are view-level.
  const navItems: NavItem[] = useMemo(() => {
    const iconFor: Record<SettingsTab, ReactNode> = {
      // Semantic Lucide glyphs for the settings destinations.
      general: <IconSliders size={14} />,
      ai: <IconSparkles size={14} />,
      shortcuts: <IconKeyboard size={14} />,
      agent: <IconBot size={14} />,
      skills: <IconBookOpen size={14} />,
      mcp: <IconServer size={14} />,
      subagents: <IconBot size={14} />,
      import: <IconDownload size={14} />,
      projects: <IconArchive size={14} />,
      sync: <IconCloudDown size={14} />,
      messaging: <IconChat size={14} />,
      voice: <IconMic size={14} />,
      remote: <IconSmartphone size={14} />,
      usage: <IconChartColumn size={14} />,
      about: <IconInfo size={14} />,
    };
    return navEntries.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey,
      titleKey: entry.titleKey,
      icon: iconFor[entry.id],
      group: entry.group,
      experimentalBadgeKey: entry.experimentalBadgeKey,
      keywordKeys: entry.keywordKeys,
    }));
  }, [navEntries]);

  // Search matches the tab label and the titles of the rows inside it, so
  // typing e.g. "theme" or "主题" surfaces Basics even though the tab is
  // named differently.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navItems;
    return navItems.filter((item) =>
      [t(item.labelKey), ...item.keywordKeys.map((key) => t(key))].some((text) =>
        text.toLowerCase().includes(q),
      ),
    );
  }, [navItems, query, t]);

  // Keep the destination index flat for search, while giving the rail titled
  // visual clusters so the eight rows do not read as one dense block.
  const filteredGroups = useMemo(() => {
    const groups = new Map<SettingsNavGroupId, NavItem[]>();
    for (const item of filteredItems) {
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items }));
  }, [filteredItems]);

  /**
   * The phone shows one column at a time: the directory first, then the chosen
   * section. Desktop ignores this — its rail and panel sit side by side — but
   * without it a 390px screen squeezes the panel into a sliver.
   */
  const [mobileView, setMobileView] = useState<"nav" | "content">("nav");

  /**
   * The phone has one back gesture and it must unwind one screen at a time. The
   * section view is local state, so it publishes its own "go back to the list"
   * hook for the app shell's gesture handler to call first.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.documentElement.dataset.surface !== "mobile") return;
    if (mobileView !== "content") return;
    const host = window as unknown as { __qianningSettingsBack?: () => boolean };
    host.__qianningSettingsBack = () => {
      // A section can own deeper screens of its own (a platform's settings, for
      // one). It claims the gesture first and returns true when it consumed it.
      const inner = (window as unknown as { __qianningPlatformBack?: () => boolean })
        .__qianningPlatformBack;
      if (inner && inner()) return true;
      setMobileView("nav");
      return true;
    };
    return () => {
      delete host.__qianningSettingsBack;
    };
  }, [mobileView]);

  const activeNavItem = navItems.find((item) => item.id === tab);
  const activeTitleKey = activeNavItem?.titleKey ?? "settings.title";
  const tabNeedsSettings = ["general", "ai", "shortcuts", "agent"].includes(tab);

  return (
    <div className="settings-shell settings-shell-full" data-settings-view={mobileView}>
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav sidebar-surface" aria-label={t("settings.title")}>
        <div className="settings-nav-top drag">
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              ref={settingsSearchRef}
              className="settings-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.search")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
        </div>

        <div className="settings-nav-scroll no-drag">
          {filteredGroups.length === 0 ? (
            <div className="settings-nav-empty">{t("settings.noResults")}</div>
          ) : (
            filteredGroups.map(({ id, items }) => (
              <div key={id} className="settings-nav-group">
                <div className="settings-nav-group-label">
                  {t(SETTINGS_NAV_GROUP_LABELS[id])}
                </div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={cx("settings-nav-item", tab === item.id && "active")}
                    onClick={() => {
                      setActiveExtension(null);
                      setSettingsTab(item.id);
                      setMobileView("content");
                    }}
                  >
                    <span className="settings-nav-icon">{item.icon}</span>
                    <span className="settings-nav-label">{t(item.labelKey)}</span>
                    {item.experimentalBadgeKey ? (
                      <Badge tone="warning" className="settings-nav-experimental">
                        {t(item.experimentalBadgeKey)}
                      </Badge>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
          {extensions.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-group-label">{t("settings.groupExtensions")}</div>
              {extensions.filter((entry) => {
                const q = query.trim().toLowerCase();
                return !q || [entry.label, ...entry.keywords].some((value) => value.toLowerCase().includes(q));
              }).map((entry) => {
                const ExtensionIcon = pluginViewIcon(entry.icon) ?? IconPalette;
                return (
                  <button
                    key={entry.ref}
                    className={cx("settings-nav-item", activeExtension?.ref === entry.ref && "active")}
                    onClick={() => setActiveExtension(entry)}
                  >
                    <span className="settings-nav-icon"><ExtensionIcon size={14} /></span>
                    <span className="settings-nav-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Pinned to the rail's bottom so it lands on the same line as the
            main shell's sidebar footer icon row. Both the band and the control
            stay explicitly non-draggable, like the rail's other controls. */}
        <div className="settings-nav-footer no-drag">
          <button
            type="button"
            className="settings-back no-drag"
            data-nav="back-to-app"
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>
      </aside>

      <div
        className="settings-content"
        ref={contentRef}
        data-settings-tab={activeExtension ? "extension" : tab}
      >
        <div className="settings-content-inner">
          <div className="settings-content-enter">
          <h1 className="settings-section-title">
            <span>{activeExtension?.label ?? t(activeTitleKey)}</span>
            {!activeExtension && activeNavItem?.experimentalBadgeKey ? (
              <Badge tone="warning">{t(activeNavItem.experimentalBadgeKey)}</Badge>
            ) : null}
          </h1>

          {activeExtension ? (
            <PluginScenicThemesDestination destination={activeExtension} selectTheme={selectPluginTheme} />
          ) : <>

          {tabNeedsSettings && !settings ? (
            <div className="settings-recovery" role="status" aria-live="polite">
              {recoveringSettings ? (
                <>
                  <span className="route-pending-indicator" aria-hidden />
                  <span>{t("common.loading")}</span>
                </>
              ) : settingsRecoveryFailed ? (
                <>
                  <span>{t("errors.HOST_UNAVAILABLE")}</span>
                  <Button variant="secondary" onClick={() => void recoverSettings()}>
                    {t("errors.action.retry")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "general" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.appearance")}>
                <ThemeRow settings={settings} saveSettings={saveSettings} />
                <LanguageRow settings={settings} saveSettings={saveSettings} />
                <FontFamilyRow settings={settings} saveSettings={saveSettings} />
                <FontSizeRow settings={settings} saveSettings={saveSettings} />
              </SettingsCard>

              <NetworkProxySection settings={settings} saveSettings={saveSettings} />

              {surface === "desktop" ? (
              <SettingsCard title={t("settings.power")}>
                <SettingsRow
                  title={t("settings.keepAwakeWhileRunning")}
                  description={t("settings.keepAwakeWhileRunningDesc")}
                >
                  <SettingsToggle
                    checked={settings.keepAwakeWhileRunning === true}
                    label={t("settings.keepAwakeWhileRunning")}
                    onChange={() => void saveSettings({
                      keepAwakeWhileRunning: settings.keepAwakeWhileRunning !== true,
                    })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.preventScreenSleep")}
                  description={t("settings.preventScreenSleepDesc")}
                >
                  <SettingsToggle
                    checked={settings.preventScreenSleep === true}
                    label={t("settings.preventScreenSleep")}
                    onChange={() => void saveSettings({ preventScreenSleep: !settings.preventScreenSleep })}
                  />
                </SettingsRow>
              </SettingsCard>
              ) : null}

              {surface === "desktop" && platform !== "darwin" && <CloseBehaviorSection />}

              <SettingsCard title={t("settings.companion")}>
                <SettingsRow
                  title={t("settings.petEnabled")}
                  description={t("settings.petEnabledDesc")}
                >
                  <SettingsToggle
                    checked={settings.petEnabled === true}
                    label={t("settings.petEnabled")}
                    onChange={() => void saveSettings({ petEnabled: settings.petEnabled !== true })}
                  />
                </SettingsRow>
              </SettingsCard>
            </div>
          )}

          {tab === "ai" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.permissions")}>
                <SettingsRow
                  title={t("settings.permissionMode")}
                  description={t("settings.permissionModeDesc")}
                >
                  <SettingsMenuSelect
                    className="settings-permission-select"
                    label={t("settings.permissionMode")}
                    value={settings.defaultPermissionMode ?? "ask"}
                    onChange={(mode) =>
                      void saveSettings({
                        defaultPermissionMode: mode as GlobalPermissionMode,
                      })
                    }
                    options={[
                      { id: "ask", label: t("settings.permissionModeAsk") },
                      {
                        id: "accept-edits",
                        label: t("settings.permissionModeAcceptEdits"),
                      },
                      { id: "auto", label: t("settings.permissionModeAuto") },
                    ]}
                  />
                </SettingsRow>
              </SettingsCard>

              {/* Computer control drives this machine's pointer and keyboard.
                  A phone has no such target, so the card is desktop-only. */}
              {surface === "desktop" ? (
                <SettingsCard title={t("settings.computerControl")}>
                  <SettingsRow
                    title={t("settings.computerControl")}
                    description={t("settings.computerControlDesc")}
                  >
                    <SettingsToggle
                      checked={settings.computerControlEnabled === true}
                      label={t("settings.computerControl")}
                      onChange={() =>
                        void saveSettings({
                          computerControlEnabled: settings.computerControlEnabled !== true,
                        })
                      }
                    />
                  </SettingsRow>
                </SettingsCard>
              ) : null}

              <SettingsCard title={t("settings.connectionControl")}>
                <SettingsRow
                  title={t("settings.connectionTargets")}
                  description={t("connections.subtitle")}
                >
                  <Button
                    size="sm"
                    onClick={() => {
                      setPage("connections");
                    }}
                  >
                    {t("settings.connectionTargetsManage")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={t("settings.connectionAgentAccess")}
                  description={t("settings.connectionControlDesc")}
                >
                  <SettingsToggle
                    checked={settings.remoteControlEnabled === true}
                    label={t("settings.connectionAgentAccess")}
                    onChange={() =>
                      void saveSettings({
                        remoteControlEnabled: settings.remoteControlEnabled !== true,
                      })
                    }
                  />
                </SettingsRow>
              </SettingsCard>

              <SettingsCard title={t("settings.defaultsTitle")}>
                <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
                  <SegmentedControl
                    value={settings.defaultMode ?? "agent"}
                    onChange={(value) => void saveSettings({ defaultMode: value })}
                    options={[
                      { value: "agent", label: t("settings.modeAgent") },
                      { value: "plan", label: t("settings.modePlan") },
                      { value: "goal", label: t("settings.modeGoal") },
                    ]}
                    label={t("settings.mode")}
                    role="group"
                  />
                </SettingsRow>
                <CommandShellRow settings={settings} saveSettings={saveSettings} />
                <LinkOpenTargetRow settings={settings} saveSettings={saveSettings} />
                <ThinkingDisplayModeRow settings={settings} saveSettings={saveSettings} />
                <ContextUsageDisplayRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
                <SettingsRow
                  title={t("settings.enterToSend")}
                  description={t("settings.enterToSendDesc")}
                >
                  <SettingsToggle
                    checked={settings.enterToSend}
                    label={t("settings.enterToSend")}
                    onChange={() => void saveSettings({ enterToSend: !settings.enterToSend })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.infiniteProviderRetry")}
                  description={t("settings.infiniteProviderRetryDesc")}
                >
                  <SettingsToggle
                    checked={settings.infiniteProviderRetry === true}
                    label={t("settings.infiniteProviderRetry")}
                    onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.smoothStreaming")}
                  description={t("settings.smoothStreamingDesc")}
                >
                  <SettingsToggle
                    checked={settings.smoothStreaming !== false}
                    label={t("settings.smoothStreaming")}
                    onChange={() => void saveSettings({ smoothStreaming: !(settings.smoothStreaming !== false) })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.inlineVisualizations")}
                  description={t("settings.inlineVisualizationsDesc")}
                >
                  <SettingsToggle
                    checked={settings.inlineVisualizations === true}
                    label={t("settings.inlineVisualizations")}
                    onChange={() => void saveSettings({
                      inlineVisualizations: settings.inlineVisualizations !== true,
                    })}
                  />
                </SettingsRow>
                <SettingsRow
                  title={t("settings.redaction")}
                  description={t("settings.redactionDesc")}
                >
                  <SettingsToggle
                    checked={settings.redaction?.enabled === true}
                    label={t("settings.redaction")}
                    onChange={() => void saveSettings({
                      redaction: { enabled: settings.redaction?.enabled !== true },
                    })}
                  />
                </SettingsRow>
                {settings.redaction?.enabled === true ? (
                  <SettingsRow
                    title={t("settings.redactionTable")}
                    description={t("settings.redactionTableDesc", { n: redactionTable?.count ?? 0 })}
                  >
                    <Button
                      variant="secondary"
                      onClick={() => void clearRedactionTable()}
                      disabled={clearingRedactionTable || (redactionTable?.count ?? 0) === 0}
                    >
                      {t("settings.redactionClear")}
                    </Button>
                  </SettingsRow>
                ) : null}
                {settings.inlineVisualizations === true ? (
                  <SettingsRow
                    title={t("settings.inlineVizScriptedPreviews")}
                    description={t("settings.inlineVizScriptedPreviewsDesc")}
                  >
                    <SettingsToggle
                      checked={settings.inlineVizScriptedPreviews === true}
                      label={t("settings.inlineVizScriptedPreviews")}
                      onChange={() => void saveSettings({
                        inlineVizScriptedPreviews: settings.inlineVizScriptedPreviews !== true,
                      })}
                    />
                  </SettingsRow>
                ) : null}
                <LargePasteThresholdRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
              </SettingsCard>
            </div>
          )}

          {tab === "remote" && !tabHidden && (
            <div className="settings-stack">
              <RemoteAccessCard />
            </div>
          )}

          {tab === "voice" && !tabHidden && settings && (
            <VoiceSettingsSection
              t={t}
              settings={settings}
              saveSettings={saveSettings}
            />
          )}

          {tab === "shortcuts" && settings && (
            <div className="settings-stack">
              <KeyboardShortcutsSection
                settings={settings}
                platform={platform}
                saveSettings={saveSettings}
              />
            </div>
          )}

          {tab === "agent" && <ModelConfigPage />}

          {tab === "skills" && <AgentSkillsPage />}

          {tab === "mcp" && <AgentMcpPage />}

          {tab === "subagents" && <AgentSubagentsPage />}
          {tab === "messaging" && <MessagingPlatformsPage />}

          {tab === "import" && <ImportSection />}

          {tab === "projects" && <ProjectsPage />}

          {tab === "sync" && !tabHidden && <ConfigSyncPage />}

          {tab === "usage" && <UsagePage />}

          {tab === "about" && (
            <div className="settings-stack">
              <SettingsCard>
                <SettingsRow title={t("settings.application")}>
                  <div className="settings-about-meta">
                    <div className="font-medium">
                      {version?.name || "QianNing Agent"} {version?.version}
                    </div>
                    <div className="font-mono text-xs-plus text-text-muted">
                      protocol {version?.protocolVersion} · host {version?.hostVersion}
                    </div>
                  </div>
                </SettingsRow>
                <SettingsRow title={t("settings.logs")}>
                  <Button variant="secondary" onClick={() => void api.openLogs()}>
                    {t("settings.openLogs")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={t("settings.feedback")}
                  description={t("settings.feedbackDesc")}
                >
                  <Button
                    variant="secondary"
                    onClick={() => void api.openFeedback().catch(() => undefined)}
                  >
                    {t("settings.openFeedback")}
                  </Button>
                </SettingsRow>
                <UpdatesRow
                  currentVersion={version?.version}
                  settings={settings ?? null}
                  saveSettings={saveSettings}
                />
              </SettingsCard>

              {settings && (
                <DeveloperSection settings={settings} saveSettings={saveSettings} />
              )}
            </div>
          )}
          </>}

          </div>
        </div>
      </div>
    </div>
  );
}
