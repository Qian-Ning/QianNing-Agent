import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import QRCode from "qrcode";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  API_SERVER_TOKEN_SECRET_REF,
  MESSAGING_GATEWAY_OFF,
  MESSAGING_PERMISSION_MODES,
  MESSAGING_PLATFORMS,
  MESSAGING_REQUIREMENT_CLASS_KEYS,
  MESSAGING_REQUIREMENT_SHORT_KEYS,
  MESSAGING_ROLES,
  SUPPORTED_MESSAGING_PLATFORMS,
  canSave,
  MESSAGING_START_SCAN,
  type SignalBridgeSnapshot,
  type SignalLinkSnapshot,
  deriveChannelState,
  discordApplicationIdFromToken,
  discordInstallUrl,
  draftFrom,
  draftMissing,
  fieldsInGroup,
  gatewayPresentation,
  generateApiServerToken,
  isLoopbackBindAddress,
  isTimeoutValid,
  platformById,
  saveMessagingPlatform,
  type MessagingChannelState,
  type MessagingDraft,
  type MessagingEnabledState,
  type MessagingField,
  type MessagingGatewayDisplay,
  type MessagingGatewaySnapshot,
  type MessagingPlatform,
  type MessagingPlatformId,
  type MessagingPlatformRecord,
  type MessagingSetupState,
  type SupportedMessagingPlatform,
  type TelegramChatCandidate,
  type TelegramProbeFailure,
} from "../../lib/messaging-platforms";
import { channelStatus, secretSlotFor } from "../../lib/messaging-platforms";
import { MessagingPlatformIcon } from "./MessagingPlatformIcon";
import { draftWithMemory, rememberDraft } from "../../lib/messaging-draft-memory";
import { useTelegramProbe, type TelegramProbe } from "./use-telegram-probe";
import {
  Badge,
  Button,
  CheckboxGroup,
  Input,
  PasswordInput,
  SegmentedControl,
  SettingsToggle,
  cx,
} from "../ui";
import { IconCheck, IconExternal, IconSearch } from "../icons";

/**
 * Settings ▸ Messaging platforms.
 *
 * The page is a chooser and a work surface: the middle column lists every
 * platform the reference product lists, the right pane is the selected
 * platform's job. The settings shell already owns the outer rail, so this page
 * is the second and third column of that three-column layout.
 *
 * # What it shows, and why in three parts
 *
 * A channel has three states that answer three different questions, and a single
 * badge hides two of them:
 *
 * - **Enabled** — is a record of ours stored? (`deriveChannelState.enabled`)
 * - **Setup** — does that record carry the destination, the link and every
 *   credential the transport reads? (`deriveChannelState.setup`)
 * - **Gateway** — did this process start the channel's receive loop, and is that
 *   loop still alive? (`deriveChannelState.gateway`, from
 *   `pi-desktop/messaging/gateway`)
 *
 * A complete record with a stopped loop is a real state — enabled, set up, and
 * not running — so the three are rendered as three values, never merged.
 *
 * # Breadth
 *
 * The catalogue lists all thirty-three platforms the reference product lists,
 * in the product's own order. Telegram, Slack, Discord, Mattermost, Matrix and
 * IRC have an adapter in this build; every other entry opens a panel that says
 * so, names the capability that is missing, and names the class that capability
 * belongs to. No dead form is rendered: an unsupported platform has no section,
 * no format and no credentials, so there is nothing a form could write.
 *
 * # Credentials
 *
 * A token typed here is written to the host's secret store under its `secret:`
 * ref and never into the settings row (`buildSectionWrite` does not read the
 * token fields at all). The page learns only whether a ref is present, so a
 * stored token is never rendered back.
 */

const ENABLED_KEY: Record<MessagingEnabledState, string> = {
  on: "settings.messaging.enabledOn",
  off: "settings.messaging.enabledOff",
  unreadable: "settings.messaging.enabledUnreadable",
};

const SETUP_KEY: Record<MessagingSetupState, string> = {
  complete: "settings.messaging.setupComplete",
  incomplete: "settings.messaging.setupIncomplete",
  notStarted: "settings.messaging.setupNotStarted",
  unknown: "settings.messaging.setupUnknown",
};

/**
 * The gateway answer as the page phrases it, from the one derived state. The
 * display type is `idle` for a channel that was never enabled, and `stopped`
 * (the warning) only when an enabled channel's loop is genuinely dead.
 */
const GATEWAY_KEY: Record<MessagingGatewayDisplay, string> = {
  running: "settings.messaging.gatewayRunning",
  stopped: "settings.messaging.gatewayStopped",
  idle: "settings.messaging.gatewayIdle",
  sendOnly: "settings.messaging.gatewaySendOnly",
};

const GATEWAY_NOTE_KEY: Record<MessagingGatewayDisplay, string> = {
  running: "settings.messaging.gatewayRunningNote",
  stopped: "settings.messaging.gatewayStoppedNote",
  idle: "settings.messaging.gatewayIdleNote",
  sendOnly: "settings.messaging.gatewaySendOnlyNote",
};

function enabledTone(value: MessagingEnabledState): "neutral" | "success" | "warning" | "error" {
  if (value === "on") return "success";
  if (value === "unreadable") return "error";
  return "neutral";
}

function setupTone(value: MessagingSetupState): "neutral" | "success" | "warning" | "error" {
  if (value === "complete") return "success";
  if (value === "incomplete") return "warning";
  if (value === "unknown") return "error";
  return "neutral";
}

function gatewayTone(display: MessagingGatewayDisplay): "neutral" | "success" | "warning" {
  if (display === "running") return "success";
  if (display === "stopped") return "warning";
  return "neutral";
}

export function MessagingPlatformsPage() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  const [selectedId, setSelectedId] = useState<MessagingPlatformId>("telegram");
  // Phone only: which platform's detail page is open. `null` is the list.
  const [openPlatform, setOpenPlatform] = useState<MessagingPlatformId | null>(null);
  const [railNotice, setRailNotice] = useState<{ id: string; platform: string } | null>(null);
  // The remark borrows the row's status line, so it has to give it back.
  useEffect(() => {
    if (!railNotice) return;
    const timer = window.setTimeout(() => setRailNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [railNotice]);
  const [secretPresent, setSecretPresent] = useState<Record<string, boolean>>({});
  const [gateway, setGateway] = useState<MessagingGatewaySnapshot>(MESSAGING_GATEWAY_OFF);
  const [saving, setSaving] = useState(false);
  const detailRef = useRef<HTMLElement | null>(null);

  const platform = useMemo(() => platformById(selectedId), [selectedId]);

  /**
   * The detail pane is its own scroll port (settings.css), so the page, not the
   * window, owns its scroll position: selecting another platform starts that
   * platform at the top instead of wherever the previous one was left. A layout
   * effect, because resetting after paint would show the old offset first.
   */
  useLayoutEffect(() => {
    const node = detailRef.current;
    if (node) node.scrollTop = 0;
  }, [selectedId]);

  /**
   * Presence only: `secrets.has` answers whether the host holds a credential
   * under the ref. There is no read path from the renderer, by design.
   */
  const loadSecretPresence = useCallback(async () => {
    const slots = SUPPORTED_MESSAGING_PLATFORMS.flatMap((entry) => entry.secrets);
    const entries = await Promise.all(
      slots.map(async (slot) => {
        try {
          const result = await api.hasSecret(slot.ref);
          return [slot.ref, result.has === true] as const;
        } catch {
          return [slot.ref, false] as const;
        }
      }),
    );
    setSecretPresent(Object.fromEntries(entries));
  }, []);

  /**
   * The gateway answer is a fact about the main process that can change without
   * any settings write — a loop ends, or the host restarts — so it is polled
   * rather than read once.
   */
  const loadGateway = useCallback(async () => {
    try {
      setGateway(await api.messagingGateway());
    } catch {
      setGateway(MESSAGING_GATEWAY_OFF);
    }
  }, []);

  useEffect(() => {
    void loadSecretPresence();
    void loadGateway();
    const timer = setInterval(() => void loadGateway(), 15_000);
    return () => clearInterval(timer);
  }, [loadSecretPresence, loadGateway]);

  const save = async (
    target: SupportedMessagingPlatform,
    draft: MessagingDraft,
    enabled: boolean,
  ): Promise<boolean> => {
    setSaving(true);
    try {
      await saveMessagingPlatform(
        target,
        draft,
        settings?.[target.section] as MessagingPlatformRecord | undefined,
        {
          writeSection: async (section, value) => {
            await api.setMessagingSection(section, value);
          },
          setSecret: async (ref, value) => {
            await api.setSecret(ref, value);
          },
        },
        { enabled },
      );
      // The settings row is the page's only view of the channel, so re-read it
      // rather than assume the write landed in the shape we sent.
      const next = await api.getSettings();
      useAppStore.setState({ settings: next });
      await Promise.all([loadSecretPresence(), loadGateway()]);
      showToast(
        t(enabled ? "settings.messaging.saved" : "settings.messaging.disabledToast", {
          platform: t(target.labelKey),
        }),
        { variant: "info" },
      );
      return true;
    } catch {
      showToast(t("settings.messaging.saveFailed", { platform: t(target.labelKey) }), {
        variant: "error",
      });
      return false;
    } finally {
      setSaving(false);
    }
  };


  /**
   * The catalogue is thirty-three entries: twelve this build can run and
   * twenty-one it cannot. Flat, that is a wall; grouped, the question "what can
   * I use" is answered before the first scroll. An unsupported card carries the
   * class of thing it lacks ("needs a public callback") in the same slot a
   * working card puts its state, so the two lists read the same way.
   */
  const railGroups = [
    {
      id: "available",
      labelKey: "settings.messaging.groupAvailable",
      entries: MESSAGING_PLATFORMS.filter((entry) => entry.support === "supported"),
    },
    {
      id: "unavailable",
      labelKey: "settings.messaging.groupUnsupported",
      entries: MESSAGING_PLATFORMS.filter((entry) => entry.support === "unsupported"),
    },
  ];

  /*
    A phone has no room for two panes side by side: the list and a full config
    form cannot share 390px. So the phone drills down instead — the list is the
    first page, a platform is the second, and back returns to the list. The
    desktop keeps both panes, which is the whole point of its width.
  */
  const isPhone =
    typeof document !== "undefined" &&
    document.documentElement.dataset.surface === "mobile";

  const openPlatformPage = (id: MessagingPlatformId) => {
    setSelectedId(id);
    setOpenPlatform(id);
    // The list may be scrolled halfway down; its position means nothing on the
    // platform's own page.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".settings-content")?.scrollTo({ top: 0 });
    });
  };

  /*
   * Android's back gesture never touches the browser history: the native shell
   * calls `window.__qianningBack`, which reaches the settings page and unwinds
   * one screen. A platform's page is one screen below the list, so it has to
   * claim the gesture before the settings page does — otherwise back leaves the
   * section entirely and lands on the settings directory.
   */
  useEffect(() => {
    if (!isPhone || openPlatform === null) return;
    const host = window as unknown as { __qianningPlatformBack?: () => boolean };
    host.__qianningPlatformBack = () => {
      setOpenPlatform(null);
      return true;
    };
    return () => {
      delete host.__qianningPlatformBack;
    };
  }, [isPhone, openPlatform]);

  const chooser = (
      <div className="settings-messaging-chooser">
        {/* The page title already says 消息平台; a second heading and a sentence
            explaining what the line under each card means were the first two
            things a reader had to get past before reaching a platform. */}
        <div
          className="settings-messaging-list"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.messaging.title")}
        >
          {railGroups.map((group) => (
            <section
              key={group.id}
              className="settings-messaging-group-rail"
              aria-labelledby={`messaging-group-${group.id}`}
            >
<p className="settings-messaging-group-label" id={`messaging-group-${group.id}`}>
                {t(group.labelKey, { count: group.entries.length })}
              </p>
              <div
                className="settings-messaging-group-tabs"
                role="tablist"
                aria-orientation="vertical"
                aria-labelledby={`messaging-group-${group.id}`}
              >
                {group.entries.map((entry) => {
                  const state =
                    entry.support === "supported"
                      ? deriveChannelState(
                          entry,
                          settings?.[entry.section] as MessagingPlatformRecord | undefined,
                          secretPresent,
                          gateway,
                        )
                      : null;
                  /**
                   * One sentence per card, and the three dimensions behind it in
                   * the tooltip. The rail is scanned, not read: `enabled · setup
                   * · gateway` is three answers to a question nobody asks while
                   * looking for "Telegram", but it is exactly what someone asks
                   * when a card looks wrong.
                   */
                  const status = state ? channelStatus(state) : null;
                  const line = status
                    ? t(status.key, { count: status.count ?? 0 })
                    : entry.support === "unsupported"
                      ? t(MESSAGING_REQUIREMENT_SHORT_KEYS[entry.requirementClass])
                      : "";
                  const detail =
                    state && status
                      ? `${t(ENABLED_KEY[state.enabled])} · ${t(SETUP_KEY[state.setup])} · ${t(
                          GATEWAY_KEY[
                            gatewayPresentation(
                              state,
                              entry.support === "supported" ? entry : undefined,
                            )
                          ],
                        )}`
                      : t(entry.blurbKey);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={!isPhone && entry.id === platform.id}
                      data-nav={`messaging-platform-${entry.id}`}
                      data-support={entry.support}
                      data-tone={status?.tone ?? "neutral"}
                      aria-label={`${t(entry.labelKey)}: ${line}`}
                      title={detail}
                      className={cx(
                        "settings-messaging-item",
                        !isPhone && entry.id === platform.id && "active",
                        entry.support === "unsupported" && "is-unsupported",
                      )}
                      onClick={() => openPlatformPage(entry.id)}
                    >
                      <MessagingPlatformIcon id={entry.id} label={t(entry.labelKey)} />
                      <span className="settings-messaging-item-copy">
                        <strong className="settings-messaging-item-name">
                          {t(entry.labelKey)}
                        </strong>
                        {railNotice?.id === entry.id ? (
                          <span className="settings-messaging-rail-tip" role="status">
                            {t("settings.messaging.railNeedsFields", {
                              platform: railNotice.platform,
                            })}
                          </span>
                        ) : (
                          <span
                            className="settings-messaging-item-status"
                            data-tone={status?.tone ?? "neutral"}
                          >
                            <span className="settings-messaging-item-dot" aria-hidden="true" />
                            <span className="settings-messaging-item-line">{line}</span>
                          </span>
                        )}
                      </span>
                      {/* The switch lives with the platform's identity, where a
                          person decides whether Telegram is on at all. The config
                          pane below then only holds configuration. */}
                      {entry.support === "supported" ? (
                        <span
                          className="settings-messaging-item-switch"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SettingsToggle
                            checked={state?.enabled === "on"}
                            label={t("settings.messaging.headerSwitchLabel", {
                              platform: t(entry.labelKey),
                            })}
                            onChange={() => {
                              const next = state?.enabled !== "on";
                              const target = entry as SupportedMessagingPlatform;
                              // The remembered draft, not the bare section: an
                              // off channel has no section, and re-entering every
                              // field to switch a switch back on is not a
                              // configuration step, it is a data-loss bug.
                              const entryDraft = draftWithMemory(
                                target,
                                settings?.[entry.section] as MessagingPlatformRecord | undefined,
                              );
                              // Turning a channel on writes this draft. When the
                              // draft is incomplete the save would fail silently,
                              // so say which fields are missing and leave the
                              // switch where it is.
                              if (next) {
                                const missingFields = draftMissing(target, entryDraft);
                                if (missingFields.length > 0) {
                                  setRailNotice({ id: entry.id, platform: t(entry.labelKey) });
                                  return;
                                }
                              }
                              setRailNotice(null);
                              void save(target, entryDraft, next);
                            }}
                          />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
  );

  const detail = (
      <section
        ref={detailRef}
        className="settings-messaging-detail"
        role="tabpanel"
        aria-label={t(platform.labelKey)}
        data-support={platform.support}
      >
        {platform.support === "supported" ? (
          <MessagingDetail
            key={platform.id}
            platform={platform}
            record={settings?.[platform.section] as MessagingPlatformRecord | undefined}
            secretPresent={secretPresent}
            gateway={gateway}
            saving={saving}
            onSave={(draft, enabled) => save(platform, draft, enabled)}
          />
        ) : (
          <UnsupportedPanel platform={platform} />
        )}
      </section>
  );

  if (isPhone) {
    return openPlatform === null ? (
      <div className="settings-messaging is-phone">{chooser}</div>
    ) : (
      // The platform's own header carries its name; a back control would sit
      // above it saying the same thing twice. Back is the system gesture.
      <div className="settings-messaging is-phone">{detail}</div>
    );
  }

  return (
    <div className="settings-messaging">
      {chooser}
      {detail}
    </div>
  );
}

/** The detail header: what the platform is, how it is supported, and the action. */
function DetailHeader({
  platform,
  action,
  hint,
  status,
}: {
  platform: MessagingPlatform;
  action?: ReactNode;
  hint?: string | null;
  /** The same one-sentence state the card in the rail shows. */
  status?: { tone: string; line: string } | null;
}) {
  const { t } = useTranslation();
  return (
    <header className="settings-messaging-head">
      <div className="settings-messaging-head-copy">
        <h3 className="settings-card-heading">
          <MessagingPlatformIcon id={platform.id} label={t(platform.labelKey)} size={22} />
          {t(platform.labelKey)}
        </h3>
        <p className="settings-messaging-blurb">{t(platform.blurbKey)}</p>
        {status ? (
          <p className="settings-messaging-head-status" data-tone={status.tone}>
            <span className="settings-messaging-item-dot" aria-hidden="true" />
            {status.line}
          </p>
        ) : null}
      </div>
      <div className="settings-messaging-head-actions">
        <Badge tone={platform.support === "supported" ? "neutral" : "warning"}>
          {t(
            platform.support === "supported"
              ? "settings.messaging.supportSupported"
              : "settings.messaging.supportUnsupported",
          )}
        </Badge>
        {action}
      </div>
      {hint ? <p className="settings-messaging-head-hint">{hint}</p> : null}
    </header>
  );
}

/**
 * The selected channel: its header, and the one draft both the header's switch
 * and the footer's Save write through.
 *
 * The draft and the enable intent live here, above both controls, because a
 * quick action that flipped its own copy of the flag would either lose the
 * form's edits or persist something the page never showed. One state, one
 * submit path; the header control is a shortcut, not a second form.
 *
 * The header control is a switch, not a button that names one direction. A
 * button can only ever offer the direction that is possible, which reads as
 * "there is no way back" to anyone who looks at it once and sees only "Enable
 * now" on a channel they cannot yet use. A switch whose checked state IS the
 * stored state says both things at once: here is where the channel is, and the
 * other position is one click away. Flipping it still goes through `onSave`,
 * the same call the footer's submit makes.
 */
function MessagingDetail({
  platform,
  record,
  secretPresent,
  gateway,
  saving,
  onSave,
}: {
  platform: SupportedMessagingPlatform;
  record: MessagingPlatformRecord | undefined;
  secretPresent: Record<string, boolean>;
  gateway: MessagingGatewaySnapshot;
  saving: boolean;
  onSave: (draft: MessagingDraft, enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MessagingDraft>(() => draftWithMemory(platform, record));
  // The toggle is the intent of THIS save. It starts on because a channel with
  // no record is the one being set up; turning it off is how an existing one is
  // removed. The state strip still reports the stored truth until Save.
  const [enabled, setEnabled] = useState(true);

  /**
   * The local API's token is generated here, once, when the channel has none.
   *
   * There is nothing on a platform dashboard to copy it from, and the token is
   * the whole credential — so the app makes it, the card shows it until it is
   * saved, and the stored value is never read back. `replace` in the card makes
   * a new one; leaving the field alone keeps the stored one.
   */
  useEffect(() => {
    if (platform.id !== "apiServer") return;
    if (secretPresent[API_SERVER_TOKEN_SECRET_REF] === true) return;
    setDraft((current) =>
      (current.secrets["api-token"] ?? "") !== ""
        ? current
        : { ...current, secrets: { ...current.secrets, "api-token": generateApiServerToken() } },
    );
  }, [platform.id, secretPresent]);

  /**
   * Save, then forget anything typed into a credential field.
   *
   * A successful save means the secret store holds the value, so the form no
   * longer needs it — that is what makes the local API's token shown once rather
   * than kept on screen. A failed save keeps it, so the retry writes the same
   * token instead of a second one.
   */
  const submit = async (nextEnabled: boolean): Promise<boolean> => {
    const saved = await onSave(draft, nextEnabled);
    if (saved) {
      // Remember the values before the credential boxes are cleared: an off
      // channel keeps no section, and this is what lets the switch go back on.
      rememberDraft(platform.id, draft);
      setDraft((current) => ({ ...current, secrets: {} }));
    }
    return saved;
  };
  const state = deriveChannelState(platform, record, secretPresent, gateway);
  const storedOn = state.enabled === "on";
  const missing = draftMissing(platform, draft);
  const ready = missing.length === 0 && isTimeoutValid(draft);
  // Enabling needs the fields this draft would store. Disabling never does, so
  // the action stays available on a channel that is already on.
  const blockedReason =
    storedOn || ready
      ? null
      : missing.length > 0
        ? t("settings.messaging.quickEnableBlocked", {
            fields: missing.map((id) => t(missingLabelKey(id, platform))).join(", "),
          })
        : // The only reason left is the timeout field, which has its own sentence.
          t("settings.messaging.timeoutInvalid");

  const runQuickAction = async () => {
    if (saving) return;
    const next = !storedOn;
    // Turning on is the only direction the draft can block: it writes the form,
    // so a missing required field would produce a record the channel cannot use.
    if (next && blockedReason !== null) return;
    // The footer toggle follows what this click persisted, not the other way
    // round: it is the same flag the save just wrote.
    setEnabled(next);
    await submit(next);
  };

  // The switch is the stored state, so it is truthful after the save re-reads
  // settings; the note next to it always names the other position, which is
  // what makes the control read as two-way rather than one-way.
  const switchNote = storedOn
    ? t("settings.messaging.headerOnNote")
    : blockedReason !== null
      ? t("settings.messaging.headerOffBlockedNote")
      : t("settings.messaging.headerOffNote");

  return (
    <>
      <DetailHeader
        platform={platform}
        hint={blockedReason}
        status={{
          tone: channelStatus(state).tone,
          line: t(channelStatus(state).key, { count: channelStatus(state).count ?? 0 }),
        }}
        action={
          <div className="settings-messaging-head-enable">
            <SettingsToggle
              checked={storedOn}
              busy={saving}
              disabled={!storedOn && blockedReason !== null}
              label={t("settings.messaging.headerSwitchLabel", {
                platform: t(platform.labelKey),
              })}
              onChange={() => void runQuickAction()}
            />
            <span className="settings-messaging-head-enable-copy">
              <span className="settings-messaging-head-enable-state">
                {t(storedOn ? "settings.messaging.enabledOn" : "settings.messaging.enabledOff")}
              </span>
              <span className="settings-messaging-head-enable-note">{switchNote}</span>
            </span>
          </div>
        }
      />
      <SupportedPanel
        platform={platform}
        state={state}
        draft={draft}
        enabled={enabled}
        saving={saving}
        secretPresent={secretPresent}
        gatewayError={platform.id === "apiServer" ? gateway.apiServerError : null}
        onDraftChange={(next) => setDraft((current) => ({ ...current, ...next }))}
        onEnabledChange={() => setEnabled((current) => !current)}
        onSave={submit}
      />
    </>
  );
}

/** One state dimension: label, value, and the evidence it came from. */
function StateRow({
  labelKey,
  valueKey,
  tone,
  noteKey,
}: {
  labelKey: string;
  valueKey: string;
  tone: "neutral" | "success" | "warning" | "error";
  noteKey: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-messaging-state">
      <span className="settings-messaging-state-label">{t(labelKey)}</span>
      <Badge tone={tone}>{t(valueKey)}</Badge>
      <span className="settings-messaging-state-note">{t(noteKey)}</span>
    </div>
  );
}

function SupportedPanel({
  platform,
  state,
  draft,
  enabled,
  saving,
  secretPresent,
  gatewayError,
  onDraftChange,
  onEnabledChange,
  onSave,
}: {
  platform: SupportedMessagingPlatform;
  state: MessagingChannelState;
  draft: MessagingDraft;
  enabled: boolean;
  saving: boolean;
  secretPresent: Record<string, boolean>;
  /** Why the main process could not bind this channel's listener, if it could not. */
  gatewayError: string | null;
  onDraftChange: (next: Partial<MessagingDraft>) => void;
  onEnabledChange: () => void;
  onSave: (enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const timeoutValid = isTimeoutValid(draft);
  const ready = canSave(platform, draft);
  const gateway = gatewayPresentation(state, platform);
  const required = fieldsInGroup(platform, "required");
  const recommended = fieldsInGroup(platform, "recommended");

  const patch = onDraftChange;

  /*
    Both probes are rendered beside the field they read, so nothing here is a
    card above the form: 校验 sits under the token, 查找 under the conversation.
    The state is owned here because the two fields are siblings.
  */
  const telegramProbe = useTelegramProbe({
    token: draft.secrets["bot-token"] ?? "",
    disabled: saving,
    onApply: (next) => onDraftChange(next),
  });
  const typedToken = (draft.secrets["bot-token"] ?? "").trim();

  const fieldControl = (field: MessagingField) => {
    const id = `messaging-${platform.id}-${field.id}`;
    const label = t(field.labelKey);
    // Any field whose id names a credential slot is a password input. The switch
    // below owns what is *not* a secret (the generated API token, and the plain
    // record fields), because a channel's credential ids must never have to be
    // listed here: DingTalk's AppKey is not a new case, it is a slot.
    const secretSlot = secretSlotFor(platform, field.id);
    if (secretSlot && field.id !== "api-token") {
      return (
        <div className="settings-messaging-secret">
          <PasswordInput
            id={id}
            value={draft.secrets[secretSlot.id] ?? ""}
            aria-label={label}
            autoComplete="off"
            placeholder={t(secretSlot.placeholderKey)}
            showLabel={t("settings.messaging.showSecret")}
            hideLabel={t("settings.messaging.hideSecret")}
            disabled={saving}
            onChange={(event) =>
              patch({ secrets: { ...draft.secrets, [secretSlot.id]: event.target.value } })
            }
          />
          <span className="settings-messaging-secret-state">
            {secretPresent[secretSlot.ref]
              ? t("settings.messaging.secretStored")
              : t("settings.messaging.secretMissing")}
          </span>
          <p className="settings-messaging-secret-hint">
            {secretPresent[secretSlot.ref]
              ? t("settings.messaging.secretStoredHint")
              : t("settings.messaging.secretNotStoredHint")}
          </p>
        </div>
      );
    }
    switch (field.id) {
      case "api-token": {
        // The one credential this app makes for the user. It is shown in full
        // exactly while it is not stored yet — that is the only moment it can be
        // copied — and the card replaces it rather than displaying the stored
        // value, which the renderer cannot read anyway.
        const slot = platform.secrets.find((entry) => entry.id === field.id);
        if (!slot) return null;
        const pending = draft.secrets[slot.id] ?? "";
        const stored = secretPresent[slot.ref] === true;
        return (
          <div className="settings-messaging-secret">
            {pending === "" ? (
              <p className="settings-messaging-field-help">
                {stored
                  ? t("settings.messaging.apiServerTokenStored")
                  : t("settings.messaging.secretMissing")}
              </p>
            ) : (
              <>
                <code className="settings-messaging-token" data-api-server-token="">
                  {pending}
                </code>
                <p className="settings-messaging-secret-hint">
                  {t("settings.messaging.apiServerTokenShownOnce")}
                </p>
              </>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() =>
                patch({ secrets: { ...draft.secrets, [slot.id]: generateApiServerToken() } })
              }
            >
              {t("settings.messaging.apiServerTokenReplace")}
            </Button>
          </div>
        );
      }
      case "nick":
      case "channels": {
        // IRC's two record fields that are not credentials: the nick it
        // registers and the extra channels it joins.
        const isNick = field.id === "nick";
        return (
          <Input
            id={id}
            value={isNick ? draft.nick : draft.channels}
            aria-label={label}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            onChange={(event) =>
              patch(isNick ? { nick: event.target.value } : { channels: event.target.value })
            }
          />
        );
      }
      case "imapHost":
      case "imapPort":
      case "smtpHost":
      case "smtpPort":
      case "username":
      case "allowedSenders":
      case "account":
      case "subjectPrefix":
      case "port":
      case "bindAddress": {
        // Email's record fields — two servers, the account, the sender allowlist
        // and the reply prefix — Signal's account and its own allowlist, and the
        // local API's port and bind address. None of them is a credential, so
        // each is a plain text input and lands in the settings record.
        const numeric = field.id === "imapPort" || field.id === "smtpPort" || field.id === "port";
        return (
          <Input
            id={id}
            value={draft[field.id]}
            aria-label={label}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            inputMode={numeric ? "numeric" : "text"}
            onChange={(event) =>
              patch({ [field.id]: event.target.value } as Partial<MessagingDraft>)
            }
          />
        );
      }
      case "smtpSecurity":
        return (
          <SegmentedControl
            value={draft.smtpSecurity}
            label={label}
            disabled={saving}
            onChange={(value) =>
              patch({ smtpSecurity: value === "starttls" ? "starttls" : "tls" })
            }
            options={[
              { value: "tls", label: t("settings.messaging.emailSecurityTls") },
              { value: "starttls", label: t("settings.messaging.emailSecurityStarttls") },
            ]}
          />
        );
      case "destination":
        return (
          <Input
            id={id}
            value={draft.destination}
            aria-label={label}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            inputMode="text"
            onChange={(event) => patch({ destination: event.target.value })}
          />
        );
      case "subject":
        return (
          <Input
            id={id}
            value={draft.subject}
            aria-label={label}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            onChange={(event) => patch({ subject: event.target.value })}
          />
        );
      case "roles":
        return (
          <CheckboxGroup
            values={draft.roles}
            onChange={(roles) => patch({ roles })}
            options={MESSAGING_ROLES.map((role) => ({
              value: role,
              label: t(`settings.messaging.role.${role}`),
            }))}
            label={label}
            minSelected={1}
            disabled={saving}
          />
        );
      case "permissionMode":
        return (
          <SegmentedControl
            value={draft.permissionMode}
            label={label}
            disabled={saving}
            onChange={(value) =>
              patch({ permissionMode: value as MessagingDraft["permissionMode"] })
            }
            options={MESSAGING_PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: t(`settings.messaging.mode.${mode}`),
            }))}
          />
        );
      case "endpoint":
        return (
          <Input
            id={id}
            value={draft.endpoint}
            aria-label={label}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            onChange={(event) => patch({ endpoint: event.target.value })}
          />
        );
      case "requestTimeoutMs":
        return (
          <Input
            id={id}
            value={draft.requestTimeoutMs}
            inputMode="numeric"
            aria-label={label}
            aria-invalid={!timeoutValid}
            placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
            disabled={saving}
            onChange={(event) => patch({ requestTimeoutMs: event.target.value })}
          />
        );
      default:
        return null;
    }
  };

  const renderField = (field: MessagingField) => {
    const id = `messaging-${platform.id}-${field.id}`;
    // Only the single-control fields can be named by the label element; the
    // role and mode groups carry their own accessible name.
    const labelled =
      secretSlotFor(platform, field.id) !== null ||
      [
      "nick",
      "channels",
      "destination",
      "subject",
      "endpoint",
      "account",
      "requestTimeoutMs",
      "port",
      "bindAddress",
      ].includes(field.id);
    const consequenceKey = field.id === "requestTimeoutMs" && !timeoutValid
      ? "settings.messaging.timeoutInvalid"
      : field.consequenceKey;
    return (
      <div
        key={field.id}
        className={cx(
          "settings-messaging-field",
          field.id === "requestTimeoutMs" && !timeoutValid && "is-invalid",
        )}
      >
        <label
          className="settings-messaging-field-label"
          htmlFor={labelled ? id : undefined}
        >
          {t(field.labelKey)}
        </label>
        <p className="settings-messaging-field-help">{t(field.helpKey)}</p>
        {fieldControl(field)}
        {platform.id === "telegram" && field.id === "bot-token" ? (
          <TelegramTokenProbe probe={telegramProbe} disabled={saving} typed={typedToken} />
        ) : null}
        {platform.id === "telegram" && field.id === "destination" ? (
          <TelegramChatProbe probe={telegramProbe} disabled={saving} typed={typedToken} />
        ) : null}
        {platform.id === "signal" && field.id === "account" ? (
          <SignalQuickSetup disabled={saving} onApply={(next) => onDraftChange(next)} />
        ) : null}
        {platform.id === "discord" && field.id === "bot-token" ? (
          <DiscordTokenProbe
            token={draft.secrets["bot-token"] ?? ""}
            disabled={saving}
            onApply={(next) => onDraftChange(next)}
          />
        ) : null}
        <p className="settings-messaging-field-consequence">{t(consequenceKey)}</p>
      </div>
    );
  };

  return (
    <>
      <h4 className="settings-messaging-block-title" id={`messaging-${platform.id}-overview`}>
        {t("settings.messaging.blockOverview")}
      </h4>
      <div className="settings-messaging-states">
        <StateRow
          labelKey="settings.messaging.stateEnabled"
          valueKey={ENABLED_KEY[state.enabled]}
          tone={enabledTone(state.enabled)}
          noteKey="settings.messaging.stateEnabledNote"
        />
        <StateRow
          labelKey="settings.messaging.stateSetup"
          valueKey={SETUP_KEY[state.setup]}
          tone={setupTone(state.setup)}
          noteKey="settings.messaging.stateSetupNote"
        />
        <StateRow
          labelKey="settings.messaging.stateGateway"
          valueKey={GATEWAY_KEY[gateway]}
          tone={gatewayTone(gateway)}
          noteKey={GATEWAY_NOTE_KEY[gateway]}
        />
      </div>

      {platform.limitationKey ? (
        <p className="settings-messaging-limitation">{t(platform.limitationKey)}</p>
      ) : null}

      {/* A port already taken is the one failure a person can fix here, so it is
          shown with the operating system's own reason instead of a generic
          "stopped". Nothing else in the panel reports a bind failure. */}
      {platform.id === "apiServer" && gatewayError ? (
        <p className="settings-messaging-missing" role="alert" data-api-server-bind-error="">
          {t("settings.messaging.apiServerBindFailed", { reason: gatewayError })}
        </p>
      ) : null}

      {/* The listener speaks plain HTTP, so a wider bind cannot work at all: the
          card says so while the address is typed, not after a failed start. */}
      {platform.id === "apiServer" && !isLoopbackBindAddress(draft.bindAddress) ? (
        <p className="settings-messaging-limitation" role="status">
          {t("settings.messaging.apiServerNonLoopbackWarning", { address: draft.bindAddress })}
        </p>
      ) : null}

      {state.setup === "incomplete" ? (
        <p className="settings-messaging-missing" role="status">
          {t("settings.messaging.missing", {
            fields: state.missing.map((id) => t(missingLabelKey(id, platform))).join(", "),
          })}
        </p>
      ) : null}

      <h4 className="settings-messaging-block-title">{t("settings.messaging.blockCredentials")}</h4>

      <StartScanCard key={platform.id} platformId={platform.id} />

      {/* Reference material, not a step in the form: it opens on a click and
          stays closed otherwise, so the page reads as fields first. */}
      <details className="settings-messaging-steps">
        <summary className="settings-messaging-section-title settings-messaging-steps-summary">
          {t("settings.messaging.getCredentials")}
        </summary>
        <ol className="settings-messaging-step-list">
          {platform.credentialStepKeys.map((key) => (
            <li key={key} className="settings-messaging-step">
              {t(key)}
            </li>
          ))}
        </ol>
        {platform.guideUrl ? (
          <a
            className="settings-messaging-guide"
            href={platform.guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t("settings.messaging.guideExternal")}
          >
            {t("settings.messaging.guideLink", { platform: t(platform.labelKey) })}
            <IconExternal size={12} aria-hidden="true" className="settings-messaging-guide-mark" />
          </a>
        ) : null}
      </details>

      {platform.noteKey ? (
        <p className="settings-messaging-note">{t(platform.noteKey)}</p>
      ) : null}

      <form
        className="settings-messaging-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || (enabled && !ready)) return;
          void onSave(enabled);
        }}
      >
        <fieldset className="settings-messaging-group" disabled={saving}>
          <legend className="settings-messaging-group-title">
            {t("settings.messaging.requiredGroup")}
          </legend>
          {required.map(renderField)}
        </fieldset>

        {/* Everything below the two required fields has a sane default, so it
            waits behind one line instead of competing with them. */}
        <details className="settings-messaging-advanced">
          <summary className="settings-messaging-block-title settings-messaging-steps-summary">
            {t("settings.messaging.blockBehaviour")}
          </summary>
          <fieldset className="settings-messaging-group" disabled={saving}>
            <legend className="settings-messaging-group-title">
              {t("settings.messaging.recommendedGroup")}
            </legend>
            {recommended.map(renderField)}
          </fieldset>
        </details>

        <div className="settings-messaging-footer">
          {/* A disabled Save with no reason beside it reads as a broken page.
              The line names the fields the button is waiting on, in the same
              words the state strip above uses. */}
          <p
            className="settings-messaging-footer-blocked"
            data-save-blocked={enabled && !ready ? "" : undefined}
            role={enabled && !ready ? "status" : undefined}
            hidden={!(enabled && !ready)}
          >
            {t("settings.messaging.saveBlockedHint", {
              fields: state.missing.map((id) => t(missingLabelKey(id, platform))).join(", "),
            })}
          </p>
          {/* The process card (ADR 0340) is a per-channel choice, so it sits with
              the enable switch: this save writes it, and only the channels that
              asked for one get the extra message and the extra edits. */}
          <div className="settings-messaging-enable">
            <SettingsToggle
              checked={draft.card}
              busy={saving}
              label={t("settings.messaging.cardToggle", { platform: t(platform.labelKey) })}
              onChange={() => onDraftChange({ card: !draft.card })}
            />
            <div className="settings-messaging-enable-copy">
              <span className="settings-messaging-enable-heading">
                <span className="settings-messaging-enable-title">
                  {t("settings.messaging.cardTitle")}
                </span>
                <Badge tone={draft.card ? "success" : "neutral"}>
                  {t(draft.card ? "settings.messaging.enabledOn" : "settings.messaging.enabledOff")}
                </Badge>
              </span>
              <span className="settings-messaging-enable-note">
                {t("settings.messaging.cardNote")}
              </span>
            </div>
          </div>
          <div className="settings-messaging-enable">
            <SettingsToggle
              checked={enabled}
              busy={saving}
              label={t("settings.messaging.enableToggle", { platform: t(platform.labelKey) })}
              onChange={onEnabledChange}
            />
            <div className="settings-messaging-enable-copy">
              {/* The title names the setting; the badge next to it shows the
                  state this save would write. A state string is not a name. */}
              <span className="settings-messaging-enable-heading">
                <span className="settings-messaging-enable-title">
                  {t("settings.messaging.enableTitle")}
                </span>
                <Badge tone={enabled ? "success" : "neutral"}>
                  {t(enabled ? "settings.messaging.enabledOn" : "settings.messaging.enabledOff")}
                </Badge>
              </span>
              <span className="settings-messaging-enable-note">
                {t("settings.messaging.enableNote")}
              </span>
            </div>
          </div>
          <Button
            type="submit"
            variant="primary"
            className="settings-messaging-footer-action"
            data-ready={!saving && (!enabled || ready) ? "" : undefined}
            disabled={saving || (enabled && !ready)}
          >
            {saving
              ? t("settings.messaging.saving")
              : enabled
                ? t("settings.messaging.save")
                : t("settings.messaging.saveDisabled")}
          </Button>
        </div>
      </form>
    </>
  );
}

/** The field label for a missing-field id, as the status line reads it. */
function missingLabelKey(id: string, platform: SupportedMessagingPlatform): string {
  // The receiver shares the listener field ids with the local API and the
  // credential id with nothing else, so its labels are its own rather than the
  // API server's.
  if (platform.id === "webhooks") {
    switch (id) {
      case "port":
        return "settings.messaging.webhookPort";
      case "bindAddress":
        return "settings.messaging.webhookBindAddress";
      case "sessionId":
        return "settings.messaging.webhookSession";
      case "signing-secret":
        return "settings.messaging.webhookSigningSecret";
      default:
        return "settings.messaging.webhookSigningSecret";
    }
  }
  switch (id) {
    case "endpoint":
      return "settings.messaging.endpoint";
    case "destination":
      if (platform.id === "slack") return "settings.messaging.channelId";
      if (platform.id === "discord") return "settings.messaging.discordChannelId";
      if (platform.id === "mattermost") return "settings.messaging.mattermostChannel";
      if (platform.id === "ntfy") return "settings.messaging.ntfyTopic";
      return "settings.messaging.chatId";
    case "link":
      return "settings.messaging.link";
    case "app-token":
      return "settings.messaging.appToken";
    case "access-token":
      return "settings.messaging.mattermostAccessToken";
    case "server-password":
      return "settings.messaging.ircServerPassword";
    case "nick":
      return "settings.messaging.ircNick";
    case "channels":
      return "settings.messaging.ircChannels";
    case "imapHost":
      return "settings.messaging.emailImapHost";
    case "imapPort":
      return "settings.messaging.emailImapPort";
    case "smtpHost":
      return "settings.messaging.emailSmtpHost";
    case "smtpPort":
      return "settings.messaging.emailSmtpPort";
    case "username":
      return "settings.messaging.emailUsername";
    case "allowedSenders":
      return "settings.messaging.emailAllowedSenders";
    case "password":
      return "settings.messaging.emailPassword";
    case "account":
      return "settings.messaging.signalAccount";
    case "api-token":
      return "settings.messaging.apiServerToken";
    case "port":
      return "settings.messaging.apiServerPort";
    case "bindAddress":
      return "settings.messaging.apiServerBindAddress";
    default:
      return "settings.messaging.botToken";
  }
}

/**
 * The token probe, under the token it reads.
 *
 * It used to be a card above the form with its own heading and two buttons,
 * which asked a person to type a token below and then scroll back up to use it.
 * A probe belongs to its field: the button that checks a value sits under that
 * value, and its answer appears in the same place.
 */
function TelegramTokenProbe({
  probe,
  disabled,
  typed,
}: {
  probe: TelegramProbe;
  disabled: boolean;
  typed: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-messaging-probe">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="settings-messaging-probe-button"
        disabled={disabled || probe.busy !== null || typed === ""}
        title={typed === "" ? t("settings.messaging.probeNeedsToken") : undefined}
        onClick={() => void probe.check()}
      >
        <IconCheck size={13} aria-hidden="true" />
        {probe.busy === "bot" ? t("settings.messaging.quickChecking") : t("settings.messaging.quickCheck")}
      </Button>
      {probe.bot ? (
        <p className="settings-messaging-probe-note ok" role="status">
          {t("settings.messaging.quickVerified", {
            username: probe.bot.username,
            name: probe.bot.name,
          })}
        </p>
      ) : null}
      {probe.failure ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t(PROBE_FAILURE_KEY[probe.failure])}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The conversation probe, under the conversation it fills.
 *
 * `getUpdates` is only meaningful once the bot is confirmed, so the button
 * waits for the token probe rather than failing with the same answer twice. The
 * QR is here because a conversation has to exist before it can be found: the
 * phone opens the bot, the watcher notices the first message, and the id fills
 * itself in.
 */
function TelegramChatProbe({
  probe,
  disabled,
  typed,
}: {
  probe: TelegramProbe;
  disabled: boolean;
  typed: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-messaging-probe">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="settings-messaging-probe-button"
        disabled={disabled || probe.busy !== null || probe.bot === null}
        title={
          probe.bot === null
            ? typed === ""
              ? t("settings.messaging.probeNeedsToken")
              : t("settings.messaging.probeNeedsBot")
            : undefined
        }
        onClick={() => void probe.findChat()}
      >
        <IconSearch size={13} aria-hidden="true" />
        {probe.busy === "chats" ? t("settings.messaging.quickFinding") : t("settings.messaging.quickFind")}
      </Button>
      {probe.chat ? (
        <p className="settings-messaging-probe-note ok" role="status">
          {t("settings.messaging.quickFound", { chat: probe.chat.title, id: probe.chat.id })}
        </p>
      ) : null}
      {probe.noChat && probe.bot ? (
        <p className="settings-messaging-probe-note" role="status">
          {t("settings.messaging.quickNoChat", { username: probe.bot.username })}
        </p>
      ) : null}
      {probe.qr && probe.bot && !probe.chat ? (
        <div className="settings-messaging-probe-qr">
          <img src={probe.qr} alt={t("settings.messaging.quickTitle")} width={104} height={104} />
          <p className="settings-messaging-probe-qr-copy">
            {t("settings.messaging.quickNoChat", { username: probe.bot.username })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const PROBE_FAILURE_KEY: Record<TelegramProbeFailure, string> = {
  malformed: "settings.messaging.quickMalformed",
  unauthorized: "settings.messaging.quickUnauthorized",
  network: "settings.messaging.quickNetwork",
  refused: "settings.messaging.quickRefused",
};

/**
 * The first step of setup, as a QR.
 *
 * A person setting up a channel is holding a phone that already knows who they
 * are. Making them find a page on the desktop, then retype a token, is the part
 * where setup stops. The page goes on the phone's screen; the token comes back
 * pasted once.
 */
function StartScanCard({ platformId }: { platformId: string }) {
  const { t } = useTranslation();
  const start = MESSAGING_START_SCAN[platformId];
  const [qr, setQr] = useState<string | null>(null);
  const url = start?.url ?? null;

  useEffect(() => {
    if (url === null) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 232,
    })
      .then((next) => {
        if (!cancelled) setQr(next);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!start || !qr) return null;

  return (
    <section className="settings-messaging-quick">
      <h4 className="settings-messaging-section-title">
        {t("settings.messaging.quickScanStart")}
      </h4>
      <div className="settings-messaging-quick-qr">
        <img src={qr} alt={t("settings.messaging.quickScanStart")} width={116} height={116} />
        <p className="settings-messaging-quick-qr-copy">{t(start.hintKey)}</p>
      </div>
    </section>
  );
}

/**
 * Signal's quick setup: the only channel here that a phone can finish.
 *
 * `signal-cli link` prints a `sgnl://` URI and waits. Scanning it in the Signal
 * app links this machine as a device; the process then reports the number it
 * bound to, which is exactly the `account` field the channel needs. So the
 * panel starts the process, draws the URI, polls the same snapshot, and writes
 * the account back when the phone confirms — no number typed by hand.
 */
function SignalQuickSetup({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (next: { account?: string }) => void;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState<SignalLinkSnapshot | null>(null);
  const [bridge, setBridge] = useState<SignalBridgeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const linkedAccount = link?.state === "linked" ? link.account : null;

  // One poller, alive only while a URI is on screen. The main process owns the
  // attempt; this loop just reads it, so a dropped poll cannot corrupt state.
  useEffect(() => {
    if (link?.state !== "waiting") return;
    const timer = setInterval(() => {
      void api
        .signalLink("status")
        .then((next) => setLink(next))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [link?.state]);

  useEffect(() => {
    const url = link?.url;
    if (!url) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 232,
    })
      .then((next) => {
        if (!cancelled) setQr(next);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [link?.url]);

  useEffect(() => {
    if (linkedAccount) applyRef.current({ account: linkedAccount });
  }, [linkedAccount]);

  /*
    A linked account alone receives nothing: the channel talks JSON-RPC to
    `signal-cli daemon` on the bridge port. Starting it here is what turns
    "配对成功" into a channel that actually works, and the same call reports a
    port that is already taken instead of leaving the panel guessing.
  */
  useEffect(() => {
    if (!linkedAccount) return;
    let cancelled = false;
    void api
      .signalBridge("start", linkedAccount)
      .then((next) => {
        if (!cancelled) setBridge(next);
      })
      .catch(() => {
        if (!cancelled) setBridge(null);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedAccount]);

  const start = async () => {
    setBusy(true);
    try {
      setLink(await api.signalLink("start"));
    } catch {
      setLink({ state: "failed", url: null, account: null, reason: "exited" });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      setLink(await api.signalLink("cancel"));
    } catch {
      setLink(null);
    } finally {
      setBusy(false);
    }
  };

  const failure = link?.state === "failed" ? link.reason : null;

  return (
    <div className="settings-messaging-probe">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="settings-messaging-probe-button"
        disabled={disabled || busy}
        onClick={link?.state === "waiting" ? () => void cancel() : () => void start()}
      >
          {link?.state === "waiting"
            ? t("settings.messaging.signalLinkCancel")
            : t("settings.messaging.signalLinkStart")}
        </Button>
      {qr && link?.state === "waiting" ? (
        <div className="settings-messaging-probe-qr">
          <img src={qr} alt={t("settings.messaging.signalLinkStart")} width={116} height={116} />
          <p className="settings-messaging-probe-qr-copy">
            {t("settings.messaging.signalLinkWaiting")}
          </p>
        </div>
      ) : null}
      {linkedAccount ? (
        <p className="settings-messaging-probe-note ok" role="status">
          {t("settings.messaging.signalLinkLinked", { account: linkedAccount })}
        </p>
      ) : null}
      {bridge?.state === "running" ? (
        <p className="settings-messaging-probe-note ok" role="status">
          {t("settings.messaging.signalBridgeRunning", {
            host: bridge.host,
            port: bridge.port,
          })}
        </p>
      ) : null}
      {bridge?.state === "failed" && bridge.reason === "port-in-use" ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.signalBridgePortInUse", { port: bridge.port })}
        </p>
      ) : null}
      {bridge?.state === "failed" && bridge.reason === "no-account" ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.signalBridgeNoAccount")}
        </p>
      ) : null}
      {bridge?.state === "failed" && bridge.reason !== "port-in-use" && bridge.reason !== "no-account" ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.signalBridgeFailed")}
        </p>
      ) : null}
      {failure === "missing-cli" ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.signalLinkMissingCli")}
        </p>
      ) : null}
      {failure === "timeout" || failure === "cancelled" || failure === "exited" ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.signalLinkExpired")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Discord's quick setup: turn the token into the install link, and show that
 * link as a QR.
 *
 * Discord has no device authorization. A bot joins a server by opening an
 * OAuth2 URL and choosing which server — a step that works from a phone while
 * the desktop sits here. The application id the URL needs is carried inside the
 * bot token itself, so the code appears without waiting on a request, and the
 * token still travels only where it belongs: into the draft's secret slot.
 */
/**
 * Discord's token probe, under the token it reads.
 *
 * It used to be a card above the form with its own "快速设置" heading, asking a
 * person to type a token below and then scroll back up to press its button —
 * the same shape the Telegram card had before it was moved. Discord's check is
 * local (the application id is the first half of the token), so this needs no
 * state outside itself: press, and the install code appears in place.
 */
function DiscordTokenProbe({
  token,
  disabled,
  onApply,
}: {
  token: string;
  disabled: boolean;
  onApply: (next: { secrets?: Record<string, string> }) => void;
}) {
  const { t } = useTranslation();
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!applicationId) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(discordInstallUrl(applicationId), {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 232,
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  const build = () => {
    const id = discordApplicationIdFromToken(token);
    if (id === null) {
      setApplicationId(null);
      setRejected(true);
      return;
    }
    setRejected(false);
    setApplicationId(id);
    onApply({ secrets: { "bot-token": token.trim() } });
  };

  return (
    <div className="settings-messaging-probe">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="settings-messaging-probe-button"
        disabled={disabled || token.trim() === ""}
        title={token.trim() === "" ? t("settings.messaging.probeNeedsToken") : undefined}
        onClick={build}
      >
        <IconCheck size={13} aria-hidden="true" />
        {t("settings.messaging.quickCheck")}
      </Button>
      {qr ? (
        <div className="settings-messaging-probe-qr">
          <img src={qr} alt={t("settings.messaging.quickTitle")} width={104} height={104} />
          <p className="settings-messaging-probe-qr-copy">
            {t("settings.messaging.discordInviteHint")}
          </p>
        </div>
      ) : null}
      {rejected ? (
        <p className="settings-messaging-probe-note bad" role="status">
          {t("settings.messaging.discordProbeMalformed")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * An unsupported platform's panel: a plain statement, the capability this build
 * lacks, and the platform's own documentation. It renders no form at all — there
 * is no settings section, no record format and no credential for a field to
 * write, so a form here could only lie about what saving would do.
 */
function UnsupportedPanel({ platform }: { platform: MessagingPlatform }) {
  const { t } = useTranslation();
  const name = t(platform.labelKey);
  const requirement =
    platform.support === "unsupported" ? t(platform.requirementKey) : "";
  const requirementClass =
    platform.support === "unsupported"
      ? MESSAGING_REQUIREMENT_CLASS_KEYS[platform.requirementClass]
      : "";
  return (
    <>
      <DetailHeader platform={platform} />
      <div className="settings-messaging-unsupported" data-panel="unsupported">
        <p className="settings-messaging-unsupported-body">
          {t("settings.messaging.unsupportedBody", { platform: name })}
        </p>
        <p className="settings-messaging-unsupported-needs">
          {t("settings.messaging.unsupportedNeeds", { platform: name, requirement })}
        </p>
        <p className="settings-messaging-unsupported-class">
          {t("settings.messaging.requirementType", {
            requirementClass: t(requirementClass),
          })}
        </p>
        <p className="settings-messaging-unsupported-note">
          {t("settings.messaging.unsupportedNoForm", { platform: name })}
        </p>
        {platform.guideUrl ? (
          <a
            className="settings-messaging-guide"
            href={platform.guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t("settings.messaging.guideExternal")}
          >
            {t("settings.messaging.unsupportedGuide", { platform: name })}
            <IconExternal size={12} aria-hidden="true" className="settings-messaging-guide-mark" />
          </a>
        ) : null}
      </div>
    </>
  );
}
