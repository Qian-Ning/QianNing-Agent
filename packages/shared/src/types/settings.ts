/** Shared public types grouped by the owning application domain. */
import type { CommandShellId } from "../command-shells.js";
import type { KeybindingOverrides } from "../keyboard-shortcuts.js";
import type { NetworkProxySettings } from "../network-proxy.js";
import type { NetworkPolicySettings } from "../network-policy.js";
import type { UsageBudgetSettings } from "../usage-budget.js";
import type { ContextCompactionSettings } from "./sessions.js";
import type { Mode } from "./common.js";
import type { GlobalPermissionMode } from "./permissions.js";
import type { PluginMarketSource } from "./plugins.js";
import type { SpeechSettings } from "./speech.js";
import type { ThinkingLevel } from "./models.js";
import type { Skin } from "../skins.js";
import type { UpdatePreference } from "./platform.js";

export type ThemePreference = "system" | "light" | "dark" | "fox" | `plugin:${string}`;

/**
 * What closing the main window does on Windows/Linux. macOS keeps the native
 * Dock lifecycle and never consults this preference.
 * - `ask`: transient unset state — the first close prompts once; after a
 *   choice is made it is remembered permanently and cannot be reverted
 * - `tray`: hide to the system tray; the app keeps running in the background
 * - `quit`: close the window and exit the app (legacy behavior)
 */
export type CloseBehavior = "ask" | "tray" | "quit";

export type AppSettings = {
  imageGeneration?: import("../image-generation.js").ImageGenerationBinding | null;
  /** All models marked for image generation; absent falls back to imageGeneration. */
  imageGenerationModels?: import("../image-generation.js").ImageGenerationBinding[] | null;
  defaultProviderId?: string;
  defaultModelId?: string;
  /** Per-install update behavior; absent uses the package's safe default. */
  updatePreference?: UpdatePreference;
  /** Last manually announced release; kept local to avoid repeating notices. */
  lastNotifiedUpdateVersion?: string;
  /** Host speech bindings. Absent means voice actions stay disabled. */
  speech?: SpeechSettings;
  defaultMode: Mode;
  /**
   * Keep retryable provider/network failures retrying until the request succeeds.
   * Absent and false use the bounded ten-retry policy.
   */
  infiniteProviderRetry?: boolean;
  /** Prevent idle system sleep while this desktop app runs; off when absent. */
  keepAwakeWhileRunning?: boolean;
  /** Configured command shell for the agent Bash protocol tool. */
  defaultCommandShell?: CommandShellId;

  defaultPermissionMode?: GlobalPermissionMode;
  theme: ThemePreference;
  /** UI language; `auto` (and absent) follows the OS locale. */
  language?: "auto" | "en" | "zh-CN" | "zh-TW" | "tr" | "de" | "es" | "fr" | "ko" | "pt-BR";
  /**
   * Global UI font stack (CSS `font-family` value). Absent means the built-in
   * token stack; bundled open-source families and installed system families
   * are offered by the settings picker.
   */
  fontFamily?: string;
  /**
   * Global UI type scale (D343). `1` is the product `--text-*` ramp.
   * Absent means 1. Range 0.8–1.5 in 0.025 steps. Window zoom is independent.
   */
  fontScale?: number;
  /** Transcript presentation only; absent means detailed. Reasoning is retained. */
  thinkingDisplayMode?: "detailed" | "compact";
  /**
   * @deprecated Unreleased D343 px field. Reads migrate into `fontScale`
   * as `px / 14`; new writes persist `fontScale` instead.
   */
  fontSize?: number;
  enterToSend: boolean;
  /** Text length above which a plain-text paste becomes a session file reference. */
  largePasteThreshold?: number;
  /**
   * @deprecated No longer read. Compaction derives its budgets from the model
   * window instead of exposing knobs; persisted values are ignored so a
   * session disabled long ago is not stuck without a switch to re-enable it.
   */
  contextCompaction?: ContextCompactionSettings;
  /** User overrides for the shared application shortcut map. */
  keybindings?: KeybindingOverrides;
  /** Unlocks the devtools console (settings button, F12, macOS View menu). */
  developerMode?: boolean;
  /**
   * Extension marketplace provider. `mirror` targets the cnb.cool copy for
   * networks that cannot reach `raw.githubusercontent.com`; both serve the
   * same catalog and packages.
   */
  pluginMarketSource?: PluginMarketSource;
  /** Catalog URL used when `pluginMarketSource` is `custom`. */
  pluginMarketCustomUrl?: string;
  /**
   * Outbound proxy for app-owned HTTP (D340). Absent means System: Chromium
   * follows the OS proxy; Node sidecar traffic stays direct unless Custom
   * is set. See `network-proxy.ts`.
   */
  networkProxy?: NetworkProxySettings;
  /**
   * Trust policy for the network endpoints the user enters themselves: how a
   * user-supplied model base URL, MCP server, or market source is judged.
   * Absent means the defaults in `network-policy.ts`.
   */
  networkPolicy?: NetworkPolicySettings;
  /**
   * Preferred destination when clicking HTTP/HTTPS links in chat messages.
   * `workpanel`: Preview in the Work Panel browser tab (default).
   * `external`: Open directly in the system's default web browser.
   */
  linkOpenTarget?: LinkOpenTarget;
  /**
   * Which context figure the composer ring and its summary lead with (D398).
   * `remaining` (default, absent) counts down from 100%; `used` counts up.
   * Color thresholds always follow remaining capacity, so the warning state
   * does not change meaning with this preference.
   */
  contextUsageDisplay?: ContextUsageDisplay;
  /**
   * Preferred centered chat band width in CSS px (D439). Absent means 760.
   * The live band is `min(available pane, this value)` so a squeezed sidebar
   * or work panel compresses without rewriting the preference.
   */
  chatContentMaxWidth?: number;
  /**
   * Opt-in smooth streaming display (D152 amendment). When enabled, incoming
   * stream chunks are released character-by-character through a
   * requestAnimationFrame loop instead of appearing as whole blocks.
   * Absent and true enable smooth rendering; false disables it. Automatically
   * disabled when the system prefers reduced motion.
   */
  smoothStreaming?: boolean;
  /**
   * Prevent the display from sleeping while the app is running. Uses
   * Electron's `powerSaveBlocker` with `prevent-display-sleep` on all
   * platforms. Absent and false mean the system manages sleep normally.
   */
  preventScreenSleep?: boolean;
  /** Voice input settings (D-voice-runtime). */
  voice?: VoiceInputSettings;
  /**
   * Desktop companion ("千凝" pet) overlay (D633). When true, a floating fox
   * mirrors the active session's agent state (idle/thinking/working/done/
   * error/permission/sleep) in the corner of the chat shell. Absent and false
   * keep it hidden — the pet is opt-in. It only reads run state; it never
   * drives the agent.
   */
  petEnabled?: boolean;
  /**
   * Skin center (D635). `activeSkinId` names the applied skin — a built-in id
   * ("none"/"qianning"/"amber"/…) or a user skin's id; absent/"none" means
   * follow the plain theme. `customSkins` holds the user's DIY and imported
   * skins. Both are validated through `sanitizeSkin` on load, so a corrupt or
   * tampered value fails closed to the theme instead of applying.
   */
  activeSkinId?: string;
  customSkins?: Skin[];
  /**
   * Monthly spend ceiling for the usage dashboard (D657). Absent, or a null
   * `monthlyUsd`, means no ceiling is set and the dashboard shows no alert.
   * This is a display preference only — nothing in the runtime reads it, and
   * reaching the ceiling blocks no turn.
   */
  usageBudget?: UsageBudgetSettings;
  /**
   * Desktop control (D659). When true, the agent's `Computer` tool and the
   * `computer.*` host methods may inject real mouse and keyboard input, so
   * the assistant can drive this machine's desktop. Off by default, and
   * defaulting off is the point: writing to the desktop is the one agent
   * capability that reaches outside the window.
   *
   * The reads — `screen`, `cursor`, `windows`, `windowAt` — answer whether or
   * not this is set, because looking at the screen is not the part that needs
   * consent. Every write — `moveMouse`, `click`, `scroll`, `typeText`,
   * `activateWindow` — is refused with `COMPUTER_DISABLED` while the switch is
   * off, on every door into the host. Windows only: elsewhere the control
   * layer reports `COMPUTER_UNSUPPORTED` and this setting changes nothing.
   */
  computerControlEnabled?: boolean;
  onboardingDismissed: boolean;
};

export type ChineseVariant = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

export type VoiceInputSettings = {
  enabled: boolean;
  /** Microphone device ID; null means system default. */
  deviceId: string | null;
  /** Language codes for recognition, e.g. ["zh", "en"]. */
  languages: string[];
  /** Chinese output variant. */
  chineseVariant: ChineseVariant;
  /** Catalog model ID. Empty string means no model selected yet. */
  modelId: string;
};

export type LinkOpenTarget = "workpanel" | "external";

export type ContextUsageDisplay = "remaining" | "used";
