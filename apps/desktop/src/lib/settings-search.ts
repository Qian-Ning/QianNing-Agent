/**
 * Data-only index of the settings IA, shared by the settings page nav and
 * the global search dialog. Keyword keys are the i18n keys of the rows
 * rendered inside each tab; search matches their translations, so a query
 * like "主题" or "theme" can surface the tab that owns the row.
 */

export type SettingsTabId =
  | "general"
  | "ai"
  | "shortcuts"
  | "agent"
  | "skills"
  | "mcp"
  | "subagents"
  | "messaging"
  | "import"
  | "projects"
  | "sync"
  | "voice"
  | "remote"
  | "usage"
  | "about";

export type SettingsNavGroupId =
  | "preferences"
  | "agent"
  | "workspace"
  | "system";

export const SETTINGS_NAV_GROUP_LABELS: Record<SettingsNavGroupId, string> = {
  preferences: "settings.groupPreferences",
  agent: "settings.groupAgent",
  workspace: "settings.groupWorkspace",
  system: "settings.groupSystem",
};

export type SettingsNavEntry = {
  id: SettingsTabId;
  /** Short label used by the rail and settings search results. */
  labelKey: string;
  /** Descriptive title used at the top of the selected settings page. */
  titleKey: string;
  /** Visual-only rail grouping; search remains a flat destination index. */
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
  /**
   * Destination only exists while `AppSettings.developerMode` is on; the
   * rail, the page, and settings search drop it together.
   */
  developerOnly?: true;
  /** Surface is omitted from packaged builds; development builds retain it. */
  developmentOnly?: true;
  /**
   * Destination edits keyboard bindings. A phone has no hardware keyboard
   * shortcuts to bind, so the phone surface drops it with the rest of the
   * desktop-only settings.
   */
  desktopOnly?: true;
  /** Localized Experimental badge shown beside the rail row and page title. */
  experimentalBadgeKey?: string;
};

export const SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: "general",
    labelKey: "settings.nav.general",
    titleKey: "settings.general",
    group: "preferences",
    keywordKeys: [
      "settings.appearance",
      "settings.theme",
      "settings.language",
      "settings.languageAuto",
      "settings.font",
      "settings.fontSize",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
      "settings.power",
      "settings.keepAwakeWhileRunning",
      "settings.keepAwakeWhileRunningDesc",
      "settings.companion",
      "settings.petEnabled",
      "settings.petEnabledDesc",
      "settings.network",
      "settings.proxy",
      "settings.proxySystem",
      "settings.proxyDirect",
      "settings.proxyCustom",
      "settings.proxyUrl",
      "settings.networkRelaxedMode",
      "settings.networkRelaxedModeDesc",
      "settings.networkRelaxedModeStrictDesc",
      "settings.preventScreenSleep",
      "settings.preventScreenSleepDesc",
    ],
  },
  {
    id: "ai",
    labelKey: "settings.nav.ai",
    titleKey: "settings.ai",
    group: "preferences",
    keywordKeys: [
      "settings.permissions",
      "settings.permissionMode",
      "settings.permissionModeAsk",
      "settings.permissionModeAcceptEdits",
      "settings.permissionModeAuto",
      "settings.computerControl",
      "settings.computerControlDesc",
      "settings.defaultsTitle",
      "settings.imageModel",
      "settings.mode",
      "settings.commandShell",
      "settings.linkOpenTarget",
      "settings.enterToSend",
      "settings.infiniteProviderRetry",
      "settings.infiniteProviderRetryDesc",
      "settings.smoothStreaming",
      "settings.smoothStreamingDesc",
      "settings.redaction",
      "settings.redactionDesc",
      "settings.inlineVisualizations",
      "settings.inlineVisualizationsDesc",
      "settings.inlineVizScriptedPreviews",
      "settings.inlineVizScriptedPreviewsDesc",
      "settings.thinkingDisplayMode",
      "settings.thinkingDisplayDetailed",
      "settings.thinkingDisplayCompact",
      "settings.contextUsageDisplay",
      "settings.contextUsageDisplayRemaining",
      "settings.contextUsageDisplayUsed",
      "settings.largePasteThreshold",
    ],
  },
  {
    id: "voice",
    desktopOnly: true,
    labelKey: "settings.nav.voice",
    titleKey: "settings.voice",
    group: "preferences",
    experimentalBadgeKey: "settings.voiceExperimental",
    keywordKeys: [
      "settings.voiceEnable",
      "settings.voiceMicrophone",
      "settings.voiceLanguages",
      "settings.voiceChineseVariant",
      "settings.voiceModel",
      "settings.voiceLocalModels",
    ],
  },
  {
    id: "shortcuts",
    desktopOnly: true,
    labelKey: "settings.nav.shortcuts",
    titleKey: "settings.shortcuts",
    group: "preferences",
    keywordKeys: [
      "settings.keyboard",
      "settings.shortcutAction.openSearch",
      "settings.shortcutAction.openCommandPalette",
      "settings.shortcutAction.toggleSidebar",
      "settings.shortcutAction.openWorkPanel",
    ],
  },
  {
    id: "agent",
    labelKey: "settings.nav.models",
    titleKey: "settings.configuration",
    group: "agent",
    keywordKeys: [
      "settings.providers",
      "settings.models",
      "settings.defaultModel",
      "settings.apiKey",
      "settings.baseUrl",
      "settings.apiStyle",
      // Subscription accounts share the service list (D625).
      "settings.vendorAccounts",
      "settings.vendorSubscription",
    ],
  },
  {
    id: "skills",
    labelKey: "settings.nav.skills",
    titleKey: "settings.skills",
    group: "agent",
    keywordKeys: [
      "settings.skillsGlobalPath",
      "settings.skillsProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.importSkill",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.skills.add",
      "extensions.skills.edit",
      "extensions.skills.remove",
      "extensions.skills.reveal",
    ],
  },
  {
    id: "mcp",
    labelKey: "settings.nav.mcp",
    titleKey: "settings.mcp",
    group: "agent",
    keywordKeys: [
      "settings.mcpGlobalPath",
      "settings.mcpProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.addMcp",
      "settings.editMcp",
      "settings.transport",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.mcp.test",
      "extensions.mcp.remove",
    ],
  },
  {
    id: "subagents",
    labelKey: "settings.nav.subagents",
    titleKey: "settings.subagents",
    group: "agent",
    keywordKeys: [
      "settings.subagentsGlobalPath",
      "settings.subagentsOnlyGlobal",
      "settings.globalScopeDescription",
      "extensions.subagents.add",
      "extensions.subagents.edit",
      "extensions.subagents.remove",
      "extensions.subagents.reveal",
      "extensions.subagents.copy",
      "extensions.subagents.sourceBuiltin",
      "extensions.subagents.presetExplorerName",
      "extensions.subagents.presetReviewerName",
      "extensions.subagents.presetTestRunnerName",
      "extensions.subagents.presetFixerName",
      "extensions.subagents.presetUiDesignerName",
      "extensions.subagents.tools",
    ],
  },
  {
    /*
     * Messaging is its own destination, not a row inside Connections: it is
     * the set of channels the agent is reached on, not a target it dials.
     */
    id: "messaging",
    labelKey: "settings.nav.messaging",
    titleKey: "settings.messaging.title",
    group: "agent",
    keywordKeys: [
      "settings.messaging.platformSlack",
      "settings.messaging.platformTelegram",
      "settings.messaging.endpoint",
      "settings.messaging.chatId",
      "settings.messaging.botToken",
      "settings.messaging.appToken",
      "settings.messaging.getCredentials",
      "settings.messaging.requiredGroup",
      "settings.messaging.recommendedGroup",
      "settings.messaging.stateEnabled",
      "settings.messaging.stateSetup",
      "settings.messaging.stateGateway",
      "settings.messaging.setupIncomplete",
      "settings.messaging.gatewayRunning",
      "settings.messaging.supportUnsupported",
      "settings.messaging.quickTitle",
    ],
  },
  {
    // Import scans the *machine's* other agents — Codex, Claude Code, OpenCode,
    // cc-switch — for sessions, models, skills and MCP servers. A phone has
    // none of those installs, so the destination is desktop-only rather than a
    // page whose every action answers with a bridge error.
    id: "import",
    labelKey: "settings.nav.import",
    titleKey: "settings.import",
    group: "workspace",
    desktopOnly: true,
    keywordKeys: [
      "settings.importTitle",
      "settings.importModelsTitle",
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
      "settings.importSourcePi",
      "settings.importSourceCcSwitch",
    ],
  },
  {
    id: "projects",
    labelKey: "settings.nav.projects",
    titleKey: "settings.projectArchive",
    group: "workspace",
    keywordKeys: [
      "project.title",
      "project.searchPlaceholder",
      "project.archive",
      "project.restore",
      "project.delete",
    ],
  },
  {
    /*
     * The Cloud sync destination is intentionally absent from the rail, the
     * page index and settings search. Its component and host backend are kept
     * in the build; the `sync` tab id still exists so the retained page can be
     * restored by putting this entry back, and so a stored selection remains
     * type-safe.
     */
    id: "usage",
    labelKey: "settings.nav.usage",
    titleKey: "settings.usage",
    group: "system",
    keywordKeys: [
      "settings.usageStats.subtitle",
      "settings.usageStats.totalTokens",
      "settings.usageStats.byProvider",
      "settings.usageStats.byModel",
      "settings.usageStats.trendTitle",
      "settings.usageStats.detailTitle",
    ],
  },
  {
    /*
     * Reaching this machine from a phone is its own destination rather than a
     * row under AI: the listener, its address, its certificate, and the device
     * list are one subject, and the device list is long enough to bury a tab.
     */
    id: "remote",
    labelKey: "settings.nav.remote",
    titleKey: "settings.remoteAccess",
    group: "system",
    keywordKeys: [
      "settings.remoteAccessDesc",
      "settings.remoteAccessEnable",
      "settings.remoteModeLan",
      "settings.remoteModeLoopback",
      "settings.remoteUrlTitle",
      "settings.remoteDevices",
      "settings.remoteIssueDevice",
      "settings.remoteDeviceLabel",
      "settings.remotePairingTitle",
      "settings.remotePairingScan",
      "settings.remoteRevoke",
      "settings.remoteRemove",
      "settings.remoteClearRevoked",
    ],
  },
  {
    id: "about",
    labelKey: "settings.nav.info",
    titleKey: "settings.about",
    group: "system",
    keywordKeys: [
      "settings.application",
      "settings.logs",
      "settings.feedback",
      "updates.title",
      "updates.preferenceTitle",
      "settings.developer",
      "settings.developerMode",
      "settings.devTools",
    ],
  },
];

/**
 * Destinations the current mode offers. Unavailable destinations are omitted
 * from navigation and search rather than disabled.
 */
export function visibleSettingsNav(
  developerMode: boolean,
  includeDevelopmentOnly = true,
  surface: "desktop" | "mobile" = "desktop",
): SettingsNavEntry[] {
  return SETTINGS_NAV.filter(
    (entry) =>
      (entry.developerOnly !== true || developerMode) &&
      (entry.developmentOnly !== true || includeDevelopmentOnly) &&
      (entry.desktopOnly !== true || surface === "desktop"),
  );
}

/** True when a stale selection points to a destination the current mode hides. */
export function isSettingsDestinationHidden(
  tab: SettingsTabId,
  developerMode: boolean,
  includeDevelopmentOnly = true,
  surface: "desktop" | "mobile" = "desktop",
): boolean {
  return !visibleSettingsNav(developerMode, includeDevelopmentOnly, surface).some(
    (entry) => entry.id === tab,
  );
}

export type SettingsSearchHit = {
  tab: SettingsTabId;
  tabLabelKey: string;
  /** Matched row key; null when the tab label itself matched. */
  rowKey: string | null;
};

export type SettingsSearchOptions = {
  limit?: number;
  /** Search mirrors the rail, so developer-only tabs stay out of results. */
  developerMode?: boolean;
  /** Packaged builds omit experimental surfaces, even with developer mode on. */
  includeDevelopmentOnly?: boolean;
  surface?: "desktop" | "mobile";
};

export function searchSettings(
  query: string,
  t: (key: string) => string,
  {
    limit = 8,
    developerMode = false,
    includeDevelopmentOnly = true,
    surface = "desktop",
  }: SettingsSearchOptions = {},
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of visibleSettingsNav(developerMode, includeDevelopmentOnly, surface)) {
    if (t(entry.labelKey).toLowerCase().includes(q)) {
      hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: null });
    }
    for (const key of entry.keywordKeys) {
      if (t(key).toLowerCase().includes(q)) {
        hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: key });
      }
    }
  }
  return hits.slice(0, limit);
}
