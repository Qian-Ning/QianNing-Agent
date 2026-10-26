export const PROTOCOL_VERSION = 11 as const;
export const SCHEMA_VERSION = 16 as const;
export const APP_ID = "com.qianning.agent";
export const APP_NAME = "QianNing Agent";
export const APP_VERSION = "2.1.0";

export const APP_MENU_COMMANDS = [
  "newTask",
  "openProject",
  "openSettings",
  "openSearch",
  "openCommandPalette",
  "toggleSidebar",
  "openHelp",
  "openLogs",
  "checkForUpdates",
] as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[number];

export const NATIVE_MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "toggleFullScreen",
  "minimize",
  "toggleMaximize",
  "close",
  "restoreMainWindow",
  "toggleMainWindow",
] as const;

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];

export const WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  "close",
] as const;

export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export const IPC = {
  invoke: {
    appGetVersion: "pi-desktop/app/getVersion",
    appOpenFeedback: "pi-desktop/app/openFeedback",
    appHealth: "pi-desktop/app/health",
    appGetOnboarding: "pi-desktop/app/getOnboarding",
    appDismissOnboarding: "pi-desktop/app/dismissOnboarding",
    /**
     * Quit the whole application through the ordered shutdown. Exposed for the
     * surfaces that own the window while the shell has no data yet — a stuck
     * startup must always be able to exit the app (issue #831).
     */
    appQuit: "pi-desktop/app/quit",
    /**
     * The renderer's answer to the in-app quit / close prompt (D674):
     * `{ requestId, choice }` with choice `cancel` | `tray` | `quit`. The main
     * process falls back to the native dialog when no answer arrives.
     */
    appQuitPromptAnswer: "pi-desktop/app/quitPrompt/answer",
    /** Installed system font families, resolved by Electron main. */
    systemFontsList: "pi-desktop/app/systemFonts",
    updatesGetState: "pi-desktop/updates/getState",
    updatesCheck: "pi-desktop/updates/check",
    updatesDownload: "pi-desktop/updates/download",
    updatesInstall: "pi-desktop/updates/install",
    updatesOpenReleases: "pi-desktop/updates/openReleases",
    notificationList: "pi-desktop/notification/list",
    notificationMarkRead: "pi-desktop/notification/markRead",
    notificationMarkAllRead: "pi-desktop/notification/markAllRead",
    notificationClear: "pi-desktop/notification/clear",
    notificationShowNative: "pi-desktop/notification/showNative",
    notificationSetViewingSession: "pi-desktop/notification/setViewingSession",
    agentPrompt: "pi-desktop/agent/prompt",
    agentSteer: "pi-desktop/agent/steer",

    speechTranscribe: "pi-desktop/speech/transcribe",
    speechSynthesize: "pi-desktop/speech/synthesize",
    speechGetStatus: "pi-desktop/speech/getStatus",
    /** The media workbench runs a user-authored generation request. */
    workbenchGenerate: "pi-desktop/workbench/generate",
    workbenchCancel: "pi-desktop/workbench/cancel",
    /** Save a finished render to a location the user picks. */
    workbenchSaveAs: "pi-desktop/workbench/saveAs",
    /** Reveal a finished render in the OS file browser. */
    workbenchReveal: "pi-desktop/workbench/reveal",
    /** What the app has rendered before, so history survives a restart. */
    workbenchLibrary: "pi-desktop/workbench/library",
    /** Forget the named library entries; their files go to the OS trash. */
    workbenchLibraryRemove: "pi-desktop/workbench/library/remove",
    /** Forget the whole library; every file goes to the OS trash. */
    workbenchLibraryClear: "pi-desktop/workbench/library/clear",
    /** Open the library directory in the OS file browser. */
    workbenchLibraryReveal: "pi-desktop/workbench/library/reveal",
    /** Keep a poster frame the renderer decoded from a finished clip. */
    workbenchSaveThumbnail: "pi-desktop/workbench/saveThumbnail",
    voiceStart: "pi-desktop/voice/start",
    voiceStop: "pi-desktop/voice/stop",
    voiceCancel: "pi-desktop/voice/cancel",
    voiceGetState: "pi-desktop/voice/getState",
    voiceGetDevices: "pi-desktop/voice/getDevices",
    voiceGetModels: "pi-desktop/voice/getModels",
    voiceDownloadModel: "pi-desktop/voice/downloadModel",
    voiceDeleteModel: "pi-desktop/voice/deleteModel",
    voiceUpdateSettings: "pi-desktop/voice/updateSettings",
    voiceCheckPermission: "pi-desktop/voice/checkPermission",
    voiceRequestPermission: "pi-desktop/voice/requestPermission",
    agentCompact: "pi-desktop/agent/compact",
    agentAbort: "pi-desktop/agent/abort",
    agentStop: "pi-desktop/agent/stop",
    agentQueuePush: "pi-desktop/agent/queue/push",
    agentQueueList: "pi-desktop/agent/queue/list",
    agentQueueRemove: "pi-desktop/agent/queue/remove",
    agentQueuePrioritize: "pi-desktop/agent/queue/prioritize",
    agentQueueReorder: "pi-desktop/agent/queue/reorder",
    agentGetStatus: "pi-desktop/agent/getStatus",
    sessionList: "pi-desktop/session/list",
    sessionCreate: "pi-desktop/session/create",
    sessionFork: "pi-desktop/session/fork",
    sessionMoveProject: "pi-desktop/session/moveProject",
    sessionSearch: "pi-desktop/session/search",
    sessionSearchContext: "pi-desktop/session/searchContext",
    sessionGet: "pi-desktop/session/get",
    sessionCollaboration: "pi-desktop/session/collaboration",
    /** Validate and select a durable session from a reviewed host operation. */
    sessionOpen: "pi-desktop/session/open",
    sessionDelete: "pi-desktop/session/delete",
    sessionRename: "pi-desktop/session/rename",
    /** Set or clear a conversation's own system prompt (schema v20). */
    sessionSetSystemPrompt: "pi-desktop/session/setSystemPrompt",
    /**
     * Saved prompt shelf (ADR 0310). A reusable library of prompt *source
     * text*: `promptPreset.list` returns the shelf, `promptPreset.save` adds
     * one, `promptPreset.delete` removes one. It is not a persona scope — a
     * saved prompt only ever fills a conversation's editor draft, which the
     * user then saves as that conversation's own prompt.
     */
    promptPresetList: "pi-desktop/promptPreset/list",
    promptPresetSave: "pi-desktop/promptPreset/save",
    promptPresetDelete: "pi-desktop/promptPreset/delete",
    sessionSummarizeTitle: "pi-desktop/session/summarizeTitle",
    /** Condense a transcript into a carry-forward brief for a fresh session. */
    sessionSummarizeContext: "pi-desktop/session/summarizeContext",
    sessionConfigure: "pi-desktop/session/configure",
    sessionImportScan: "pi-desktop/session/importScan",
    sessionImportRun: "pi-desktop/session/importRun",
    modelConfigImportScan: "pi-desktop/modelConfig/importScan",
    modelConfigImportRun: "pi-desktop/modelConfig/importRun",
    sessionReplaceMessages: "pi-desktop/session/replaceMessages",
    sessionSaveRevision: "pi-desktop/session/saveRevision",
    sessionListRevisions: "pi-desktop/session/listRevisions",
    sessionActivateRevision: "pi-desktop/session/activateRevision",
    sessionGetScratchPath: "pi-desktop/session/getScratchPath",
    sessionOpenScratchPath: "pi-desktop/session/openScratchPath",
    projectOpenFolder: "pi-desktop/project/openFolder",
    settingsGet: "pi-desktop/settings/get",
    settingsSet: "pi-desktop/settings/set",
    /**
     * Write one messaging channel's settings section (`messagingTelegram` or
     * `messagingSlack`) on the host's internal call path.
     *
     * It exists so the Messaging platforms destination never round-trips the
     * whole settings snapshot to change one channel. `settings.set` merges at
     * the top level, so this patch replaces one section and cannot overwrite a
     * neighbouring setting — nor re-apply the network proxy policy from a
     * partial object, which `settingsSet` would. It only restates an existing
     * host verb; no new store, namespace or persistence is introduced.
     */
    messagingSetSection: "pi-desktop/messaging/setSection",
    /**
     * Which inbound messaging loops this process has running.
     *
     * The Messaging platforms panel shows three independent states, and the
     * third one — is the gateway running — is a fact about the main process,
     * not about the settings row the other two read. It answers from the
     * handles the composition root started (`MessagingGatewayRegistry`), so the
     * panel no longer has to describe configuration intent as if it were
     * liveness. Read-only: it writes nothing, opens nothing and reads no
     * credential.
     */
    messagingGateway: "pi-desktop/messaging/gateway",
    /**
     * Prove a Telegram bot token and find the chat that has messaged the bot.
     *
     * The quick-setup panel uses it to confirm a token really belongs to a bot
     * and to discover the numeric chat id, so the two values a beginner would
     * otherwise copy blind are checked instead. The token crosses this channel
     * once, the host is a constant (`https://api.telegram.org`), redirects are
     * disabled because the credential travels in the path, and the answer is
     * projected onto ids only — never a response body, never the token.
     */
    messagingTelegramProbe: "pi-desktop/messaging/telegramProbe",
    /**
     * Bind the one linked messaging conversation to the session its inbound
     * commands act on (ADR 0205 D375 item 9). The conversation-to-session
     * binding lives in the shared `app` settings row; this is the host-internal
     * writer that puts it there, so a linked chat can actually reach an
     * operation instead of being refused as unbound.
     *
     * It carries only the session id and writes only the channel's own settings
     * key, so it cannot rewrite a neighbouring setting. It is deliberately not a
     * RACP operation: `settings` stays out of `RACP_OPERATIONS`, so no remote
     * peer can reach this row, and the desktop backend router only forwards a
     * call whose session id is a paired remote id — this one carries the local
     * session id, so it always runs against the local host-core.
     */
    messagingInboundBindSession: "pi-desktop/messagingInbound/bindSession",
    /**
     * The Slack channel's counterpart of the bind channel above (ADR 0326). It
     * carries the same session id and is the same host-internal, non-RACP write;
     * it selects the Slack channel's settings section, so the two channels keep
     * separate conversation-to-session bindings. The Telegram channel above is
     * unchanged and keeps its exact shape.
     */
    messagingInboundBindSessionSlack: "pi-desktop/messagingSlack/bindSession",
    /**
     * Skin center (D635). Import a local image/video as a background asset
     * (returns an opaque asset id), delete one, and export/import a whole skin
     * as a `.qnskin` bundle. Assets never expose a filesystem path to the
     * renderer; they are served back over the `skin-asset://` scheme.
     */
    skinImportAsset: "pi-desktop/skin/importAsset",
    skinDeleteAsset: "pi-desktop/skin/deleteAsset",
    skinExport: "pi-desktop/skin/export",
    skinImport: "pi-desktop/skin/import",
    configSyncGetState: "pi-desktop/configSync/getState",
    configSyncConfigure: "pi-desktop/configSync/configure",
    configSyncTest: "pi-desktop/configSync/test",
    configSyncSyncNow: "pi-desktop/configSync/syncNow",
    configSyncPause: "pi-desktop/configSync/pause",
    configSyncUnlock: "pi-desktop/configSync/unlock",
    configSyncApprove: "pi-desktop/configSync/approve",
    configSyncReject: "pi-desktop/configSync/reject",
    configSyncMapProject: "pi-desktop/configSync/mapProject",
    configSyncListHistory: "pi-desktop/configSync/listHistory",
    configSyncRestore: "pi-desktop/configSync/restore",
    configSyncChangePassword: "pi-desktop/configSync/changePassword",
    configSyncDisconnect: "pi-desktop/configSync/disconnect",
    networkProxyTest: "pi-desktop/network/testProxy",
    commandShellList: "pi-desktop/commandShell/list",
    secretsSet: "pi-desktop/secrets/set",
    secretsDelete: "pi-desktop/secrets/delete",
    secretsHas: "pi-desktop/secrets/has",
    projectOpen: "pi-desktop/project/open",
    projectPickFolders: "pi-desktop/project/pickFolders",
    projectMemoryGet: "pi-desktop/project/memory/get",
    projectMemorySave: "pi-desktop/project/memory/save",
    projectGroupList: "pi-desktop/project-group/list",
    projectGroupCreate: "pi-desktop/project-group/create",
    projectGroupRename: "pi-desktop/project-group/rename",
    projectGroupUpdate: "pi-desktop/project-group/update",
    projectGroupMemoryGet: "pi-desktop/project-group/memory/get",
    projectGroupMemorySave: "pi-desktop/project-group/memory/save",
    projectClone: "pi-desktop/project/clone",
    projectCloneCheckout: "pi-desktop/project/cloneCheckout",
    projectGet: "pi-desktop/project/get",
    projectList: "pi-desktop/project/list",
    projectSet: "pi-desktop/project/set",
    projectClear: "pi-desktop/project/clear",
    projectRemove: "pi-desktop/project/remove",
    scheduledList: "pi-desktop/scheduled/list",
    scheduledCreate: "pi-desktop/scheduled/create",
    scheduledUpdate: "pi-desktop/scheduled/update",
    scheduledDelete: "pi-desktop/scheduled/delete",
    scheduledRun: "pi-desktop/scheduled/run",
    scheduledExecute: "pi-desktop/scheduled/execute",
    scheduledListRuns: "pi-desktop/scheduled/listRuns",
    toolResolvePermission: "pi-desktop/tool/resolvePermission",
    askToolResolve: "pi-desktop/agent/askTool/resolve",
    plansPending: "pi-desktop/plans/pending",
    plansResolve: "pi-desktop/plans/resolve",
    /**
     * List every paired remote `pi-host` this desktop knows, redacted so no
     * device token reaches the renderer. See ADR 0286 (R2b pairing UX).
     */
    remoteHostList: "pi-desktop/remoteHost/list",
    /**
     * Pair with a `pi-host` at `url` using a single-use `pairingToken`, mint
     * a device token, persist it encrypted, and open the live connection.
     */
    remoteHostPair: "pi-desktop/remoteHost/pair",
    /** Close the live connection for `hostKey` and drop its persisted record. */
    remoteHostRemove: "pi-desktop/remoteHost/remove",
    /**
     * Install and pair a `pi-host` on a machine the user reaches over SSH:
     * upload the bootstrap script, download and verify the published bundle
     * there, start the host, forward its loopback port, and exchange the
     * pairing token (spec §5.2). Uses the user's own SSH keys; no credential
     * crosses this channel.
     */
    remoteHostBootstrap: "pi-desktop/remoteHost/bootstrap",
    providersList: "pi-desktop/providers/list",
    providersReorder: "pi-desktop/providers/reorder",
    providersCreate: "pi-desktop/providers/create",
    providersUpdate: "pi-desktop/providers/update",
    providersDelete: "pi-desktop/providers/delete",
    /**
     * Set or clear one provider's API key. Separate from `providersUpdate`
     * because a plugin-declared row refuses a generic update while still
     * needing the credential its declaration asks for.
     */
    providersSetSecret: "pi-desktop/providers/setSecret",
    providersTest: "pi-desktop/providers/testConnection",
    providersListModels: "pi-desktop/providers/listModels",
    /**
     * Look one model id up in the local models.dev snapshot.
     *
     * `providersListModels` cannot answer this: it describes a saved or
     * reached provider's catalogue, and a hand-typed custom id exists nowhere
     * yet when the settings picker needs its published limits. This is a
     * snapshot read — no provider network access and no host call — so the
     * picker can seed a custom row without probing an endpoint that does not
     * know the id.
     */
    providersLookupModel: "pi-desktop/providers/lookupModel",
    providersRefreshModelCatalog: "pi-desktop/providers/refreshModelCatalog",
    providersModelCatalogStatus: "pi-desktop/providers/modelCatalogStatus",
    providersOauthVendors: "pi-desktop/providers/oauth/vendors",
    providersOauthStart: "pi-desktop/providers/oauth/start",
    providersOauthRespond: "pi-desktop/providers/oauth/respond",
    providersOauthCancel: "pi-desktop/providers/oauth/cancel",
    providersOauthDelete: "pi-desktop/providers/oauth/delete",
    pluginList: "pi-desktop/plugin/list",
    /** Plugin-contributed agent extensions (D387/D388, ADR 0214). */
    pluginImportExtension: "pi-desktop/plugin/importExtension",
    extensionsCommandRun: "pi-desktop/extensions/commands/run",
    extensionsUiRespond: "pi-desktop/extensions/ui/respond",
    pluginLoadDev: "pi-desktop/plugin/loadDev",
    /**
     * The answer to a development plugin's permission review. Loading a folder
     * is a two-step: `pluginLoadDev` returns the declaration, and this commits
     * the permissions the user accepted.
     */
    pluginLoadDevConfirm: "pi-desktop/plugin/loadDevConfirm",
    pluginReload: "pi-desktop/plugin/reload",
    /** Commits a reviewed widening for an already-loaded development plugin. */
    pluginReloadConfirm: "pi-desktop/plugin/reloadConfirm",
    pluginCreateFromTemplate: "pi-desktop/plugin/createFromTemplate",
    pluginInstallFromPath: "pi-desktop/plugin/installFromPath",
    pluginInstallFromPackage: "pi-desktop/plugin/installFromPackage",
    pluginEnable: "pi-desktop/plugin/enable",
    pluginDisable: "pi-desktop/plugin/disable",
    pluginSetScope: "pi-desktop/plugin/setScope",
    pluginUninstall: "pi-desktop/plugin/uninstall",
    pluginSetAutoUpdate: "pi-desktop/plugin/setAutoUpdate",
    pluginSettingsGet: "pi-desktop/plugin/settings/get",
    pluginSettingsSet: "pi-desktop/plugin/settings/set",
    pluginOpenPanel: "pi-desktop/plugin/openPanel",
    pluginLauncherToggle: "pi-desktop/pluginLauncher/toggle",
    pluginLauncherDismiss: "pi-desktop/pluginLauncher/dismiss",
    pluginThemes: "pi-desktop/plugin/themes",
    pluginScenicThemesDestinations: "pi-desktop/plugin/scenicThemes/destinations",
    pluginScenicThemesSetBlur: "pi-desktop/plugin/scenicThemes/setBlur",
    pluginServices: "pi-desktop/plugin/services",
    pluginViews: "pi-desktop/plugin/views",
    pluginViewOpen: "pi-desktop/plugin/view/open",
    pluginViewClose: "pi-desktop/plugin/view/close",
    pluginViewSetBounds: "pi-desktop/plugin/view/setBounds",
    pluginViewSetVisible: "pi-desktop/plugin/view/setVisible",
    mcpList: "pi-desktop/mcp/list",
    mcpUpsert: "pi-desktop/mcp/upsert",
    mcpRemove: "pi-desktop/mcp/remove",
    mcpSetEnabled: "pi-desktop/mcp/setEnabled",
    mcpSetScope: "pi-desktop/mcp/setScope",
    mcpTransfer: "pi-desktop/mcp/transfer",
    mcpTest: "pi-desktop/mcp/test",
    mcpOauthStart: "pi-desktop/mcp/oauth/start",
    mcpOauthCancel: "pi-desktop/mcp/oauth/cancel",
    mcpImport: "pi-desktop/mcp/import",
    mcpImportScan: "pi-desktop/mcp/importScan",
    mcpImportRun: "pi-desktop/mcp/importRun",
    mcpMarketSearch: "pi-desktop/mcp/market/search",
    skillList: "pi-desktop/skill/list",
    skillCreate: "pi-desktop/skill/create",
    skillImport: "pi-desktop/skill/import",
    skillImportScan: "pi-desktop/skill/importScan",
    skillImportRun: "pi-desktop/skill/importRun",
    skillMarketSearch: "pi-desktop/skill/market/search",
    skillMarketFetch: "pi-desktop/skill/market/fetch",
    skillUpdate: "pi-desktop/skill/update",
    skillRemove: "pi-desktop/skill/remove",
    skillSetEnabled: "pi-desktop/skill/setEnabled",
    skillSetScope: "pi-desktop/skill/setScope",
    skillTransfer: "pi-desktop/skill/transfer",
    skillRead: "pi-desktop/skill/read",
    skillReveal: "pi-desktop/skill/reveal",
    subagentList: "pi-desktop/subagent/list",
    subagentCatalog: "pi-desktop/subagent/catalog",
    subagentCreate: "pi-desktop/subagent/create",
    subagentUpdate: "pi-desktop/subagent/update",
    subagentRead: "pi-desktop/subagent/read",
    subagentRemove: "pi-desktop/subagent/remove",
    subagentSetEnabled: "pi-desktop/subagent/setEnabled",
    subagentSetScope: "pi-desktop/subagent/setScope",
    subagentSetBuiltinEnabled: "pi-desktop/subagent/setBuiltinEnabled",
    subagentReveal: "pi-desktop/subagent/reveal",
    marketRefresh: "pi-desktop/market/refresh",
    marketSearch: "pi-desktop/market/search",
    marketGetDetail: "pi-desktop/market/getDetail",
    marketInstall: "pi-desktop/market/install",
    marketCheckUpdates: "pi-desktop/market/checkUpdates",
    marketApplyUpdates: "pi-desktop/market/applyUpdates",
    marketCancelInstall: "pi-desktop/market/cancelInstall",
    commandPaletteSearch: "pi-desktop/commandPalette/search",
    commandPaletteExecute: "pi-desktop/commandPalette/execute",
    logOpenFolder: "pi-desktop/log/openFolder",
    devtoolsToggle: "pi-desktop/devtools/toggle",
    composerPickFiles: "pi-desktop/composer/pickFiles",
    composerPickPhotos: "pi-desktop/composer/pickPhotos",
    composerImportFiles: "pi-desktop/composer/importFiles",
    composerPasteFiles: "pi-desktop/composer/pasteFiles",
    clipboardRecordPaste: "pi-desktop/clipboard/recordPaste",
    composerCommands: "pi-desktop/composer/commands",
    workspaceDiff: "pi-desktop/workspace/diff",
    workspaceReviewRollback: "pi-desktop/workspace/review/rollback",
    browserNavigate: "pi-desktop/browser/navigate",
    browserAction: "pi-desktop/browser/action",
    browserSetBounds: "pi-desktop/browser/setBounds",
    browserSetVisible: "pi-desktop/browser/setVisible",
    browserOpenExternal: "pi-desktop/browser/openExternal",
    browserGetState: "pi-desktop/browser/getState",
    fsList: "pi-desktop/fs/list",
    fsRead: "pi-desktop/fs/read",
    fsReadImageDataUrl: "pi-desktop/fs/readImageDataUrl",
    computerGetScreen: "pi-desktop/computer/getScreen",
    computerGetCursor: "pi-desktop/computer/getCursor",
    computerListWindows: "pi-desktop/computer/listWindows",
    computerWindowAt: "pi-desktop/computer/windowAt",
    computerMoveMouse: "pi-desktop/computer/moveMouse",
    computerClick: "pi-desktop/computer/click",
    computerScroll: "pi-desktop/computer/scroll",
    computerTypeText: "pi-desktop/computer/typeText",
    computerActivateWindow: "pi-desktop/computer/activateWindow",
    statsGetTokenUsageHistory: "pi-desktop/stats/getTokenUsageHistory",
    statsGetUsageBreakdown: "pi-desktop/stats/getUsageBreakdown",
    statsGetModelPricing: "pi-desktop/stats/getModelPricing",
    statsUpdateModelPricing: "pi-desktop/stats/updateModelPricing",
    statsDeleteModelPricing: "pi-desktop/stats/deleteModelPricing",
    statsResetModelPricing: "pi-desktop/stats/resetModelPricing",
    fsReveal: "pi-desktop/fs/reveal",
    fsOpen: "pi-desktop/fs/open",
    fsIndex: "pi-desktop/fs/index",
    fsResolveRef: "pi-desktop/fs/resolveRef",
    windowSetWorkPanelReservation:
      "pi-desktop/window/setWorkPanelReservation",
    windowSetWorkPanelChatWidth: "pi-desktop/window/setWorkPanelChatWidth",
    windowSetBackgroundColor: "pi-desktop/window/setBackgroundColor",
    windowControl: "pi-desktop/window/control",
    closeBehaviorGet: "pi-desktop/window/closeBehavior/get",
    closeBehaviorSet: "pi-desktop/window/closeBehavior/set",
    menuRendererReady: "pi-desktop/menu/rendererReady",
    traySetSessionPreferences: "pi-desktop/tray/setSessionPreferences",
    nativeMenuAction: "pi-desktop/menu/nativeAction",
    /**
     * Connections (ADR 0320). These are the profile methods a person drives
     * from the Connections destination, plus the audit read the detail view
     * shows. They are deliberately not the agent-facing `connection.list`,
     * `connection.probe`, and `connection.exec`, which sit behind the global
     * switch and reach the host as Agent tool calls rather than as channels.
     */
    connectionProfiles: "pi-desktop/connection/profiles",
    /**
     * The destination's Probe button calls the *agent-facing* `connection.probe`
     * on purpose: probing dials a target, so it belongs behind the same global
     * switch. The gate lives in the host, so a renderer cannot bypass it — while
     * the switch is off this channel answers `CONNECTION_DISABLED`, which is why
     * the button is disabled there too.
     */
    connectionProbe: "pi-desktop/connection/probe",
    connectionCreate: "pi-desktop/connection/create",
    connectionUpdate: "pi-desktop/connection/update",
    connectionDelete: "pi-desktop/connection/delete",
    connectionSetEnabled: "pi-desktop/connection/setEnabled",
    connectionSetCredential: "pi-desktop/connection/setCredential",
    connectionClearCredential: "pi-desktop/connection/clearCredential",
    connectionAcceptHostKey: "pi-desktop/connection/acceptHostKey",
    /**
     * Native "pick a key file" dialog for the SSH form's identity-file field.
     * Returns the chosen *path*: the file itself is read by ssh at connect
     * time, never by this process, the renderer, or the agent.
     */
    connectionPickIdentityFile: "pi-desktop/connection/pickIdentityFile",
    connectionActivity: "pi-desktop/connection/activity",
    /**
     * The terminal surface (spec `03-runtime/19-remote-agent-control-protocol.md`
     * §6.2, rollout R2b). `open` asks for a pty with the session root as its
     * working directory and answers with the terminal id plus the *bounded*
     * replay ring; passing an existing `terminalId` re-attaches after a
     * reconnect and returns that same bounded ring rather than a backlog.
     * `input` and `data` are base64, matching the wire shape.
     *
     * A local session has no interactive terminal in this build, so its local
     * handler refuses with `CAPABILITY_UNAVAILABLE`; a remote session routes
     * every one of these over RACP to the paired `pi-host`.
     */
    terminalOpen: "pi-desktop/terminal/open",
    terminalInput: "pi-desktop/terminal/input",
    terminalResize: "pi-desktop/terminal/resize",
    terminalClose: "pi-desktop/terminal/close",
    /**
     * Read-only session visualization surface (ADR 0327). The renderer lists
     * the visualizations an agent turn wrote to a session and reads one
     * artifact's content to render it in the transcript inside a no-script
     * sandbox iframe. Writing is deliberately not exposed here: artifacts are
     * written only by the agent runtime through host-core's
     * `WriteInlineVisualization` tool path, so a renderer compromise cannot
     * plant content — it can at most read back what the agent already wrote
     * to that session.
     */
    inlineVizList: "pi-desktop/inlineViz/list",
    inlineVizRead: "pi-desktop/inlineViz/read",
    /**
     * Renderer-side write (ADR 0328). The transcript's "save as visualization"
     * affordance persists a bounded snippet into the session visualization
     * root. Unlike the agent tool this crosses the renderer boundary, so the
     * electron main treats it as untrusted input: the same shape, size, and
     * kind validation applies, the session must exist, and host-core records
     * a `tool_execute`-shaped audit row for every accepted write.
     */
    inlineVizWrite: "pi-desktop/inlineViz/write",
    /**
     * The outbound-redaction table (ADR 0332). Both reach the sidecar that owns
     * the table: reading the file from main would miss a turn that has not
     * flushed yet, and deleting it would let a live turn write its snapshot
     * back, so a clear the user asked for would silently undo itself.
     */
    redactionStatus: "pi-desktop/redaction/status",
    redactionClear: "pi-desktop/redaction/clear",
    /** Remote access (ADR 0333): loopback listener, off until enabled. */
    remoteStatus: "pi-desktop/remote/status",
    remoteEnable: "pi-desktop/remote/enable",
    remoteDisable: "pi-desktop/remote/disable",
    remoteIssueDevice: "pi-desktop/remote/device/issue",
    remoteRevokeDevice: "pi-desktop/remote/device/revoke",
  },
  event: {
    pluginChanged: "pi-desktop/event/pluginChanged",
    /** Progress of an install or update, while it is still running. */
    pluginInstallProgress: "pi-desktop/plugin/event/installProgress",
    /** Host-originated app settings mutation (e.g. plugin `app.setTheme`). */
    settingsChanged: "pi-desktop/app/event/settingsChanged",
    configSyncChanged: "pi-desktop/configSync/event/changed",
    /** What a running sync is doing, while it is still running. */
    configSyncProgress: "pi-desktop/configSync/event/progress",
    /** Progress of a media workbench generation, while it is still running. */
    workbenchProgress: "pi-desktop/workbench/event/progress",
    extensionsUiPrompt: "pi-desktop/extensions/event/uiPrompt",
    extensionsStatus: "pi-desktop/extensions/event/status",
    pluginLauncherShown: "pi-desktop/pluginLauncher/event/shown",
    agentMessage: "pi-desktop/agent/event/message",
    agentQueueChanged: "pi-desktop/agent/event/queueChanged",
    hostStatus: "pi-desktop/app/event/hostStatus",
    toast: "pi-desktop/app/event/toast",
    /**
     * Show the in-app quit / close prompt (D674): `{ requestId, kind }` with
     * kind `quit` (confirm exiting) or `close` (window close behavior). The
     * renderer renders it in the app's own dialog, not a native message box.
     * The same channel withdraws it — `{ requestId, kind, dismiss: true }` —
     * when the main process stops waiting (its 20-second timeout) and hands the
     * question to the native dialog, so no card is left answering a settled
     * request.
     */
    appQuitPrompt: "pi-desktop/app/event/quitPrompt",
    /**
     * The first plaintext hop to an endpoint the user typed, sent once and only
     * until the shell records `networkPolicy.insecureNoticeAcknowledged`. The
     * shell owns the wording, because the address is not a secret and the copy
     * is localized.
     */
    insecureEndpointNotice: "pi-desktop/network/event/insecureEndpointNotice",
    browserState: "pi-desktop/browser/event/state",
    browserPreview: "pi-desktop/browser/event/preview",
    windowMaximized: "pi-desktop/window/event/maximized",
    windowFullScreen: "pi-desktop/window/event/fullscreen",
    windowWorkPanelResize: "pi-desktop/window/event/workPanelResize",
    menuCommand: "pi-desktop/menu/event/command",
    traySessionActivated: "pi-desktop/tray/event/sessionActivated",
    notificationChanged: "pi-desktop/notification/event/changed",
    sessionsChanged: "pi-desktop/session/event/changed",
    notificationActivated: "pi-desktop/notification/event/activated",
    notificationSound: "pi-desktop/notification/event/sound",
    plansChanged: "pi-desktop/plans/event/changed",
    providersOauth: "pi-desktop/providers/oauth/event",
    mcpOauth: "pi-desktop/mcp/oauth/event",
    updatesState: "pi-desktop/updates/event/state",
    voiceStateChanged: "pi-desktop/voice/event/stateChanged",
    voiceModelProgress: "pi-desktop/voice/event/modelProgress",
    /**
     * Terminal output, one bounded base64 chunk at a time, keyed by the session
     * that owns the terminal (`{ sessionId, terminalId, data }`). The desktop's
     * terminal surface consumes this for a local and a remote session alike, so
     * a remote row is distinguished only by its namespaced session id.
     */
    terminalOutput: "pi-desktop/terminal/event/output",
    /** A terminal's state change — it exited (`{ sessionId, terminalId, state, code }`). */
    terminalChanged: "pi-desktop/terminal/event/changed",
    /**
     * Live link state of one paired remote host (`RemoteHostStateEvent`). Emitted
     * by the desktop-side connection whenever the RACP transport enters
     * `connecting`, `connected`, `reconnecting`, `disconnected`, or `failed`, so
     * the Settings → Remote Hosts row can say *why* a host is not usable instead
     * of only online/offline. Distinct from `hostStatus`, which is this machine's
     * own backend supervision state and is not scoped to a host key.
     */
    remoteHostState: "pi-desktop/remoteHost/event/state",
  },
} as const;

export const IPC_WHITELIST = new Set<string>([
  ...Object.values(IPC.invoke),
  ...Object.values(IPC.event),
]);
