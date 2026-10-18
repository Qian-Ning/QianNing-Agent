import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MessagingChannelSettings } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  MESSAGING_GATEWAY_OFF,
  MESSAGING_PERMISSION_MODES,
  MESSAGING_PLATFORMS,
  MESSAGING_REQUIREMENT_CLASS_KEYS,
  MESSAGING_ROLES,
  SUPPORTED_MESSAGING_PLATFORMS,
  canSave,
  deriveChannelState,
  draftFrom,
  draftMissing,
  fieldsInGroup,
  gatewayPresentation,
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
  type MessagingSetupState,
  type SupportedMessagingPlatform,
  type TelegramChatCandidate,
  type TelegramProbeFailure,
} from "../../lib/messaging-platforms";
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
};

const GATEWAY_NOTE_KEY: Record<MessagingGatewayDisplay, string> = {
  running: "settings.messaging.gatewayRunningNote",
  stopped: "settings.messaging.gatewayStoppedNote",
  idle: "settings.messaging.gatewayIdleNote",
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

/** One dot per state dimension in the rail row: dense, but never collapsed. */
function StatePips({ state }: { state: MessagingChannelState }) {
  const { t } = useTranslation();
  const gateway = gatewayPresentation(state);
  const pips = [
    {
      key: "enabled",
      value: ENABLED_KEY[state.enabled],
      tone: state.enabled === "on" ? "on" : state.enabled === "unreadable" ? "bad" : "off",
      label: t("settings.messaging.stateEnabled"),
    },
    {
      key: "setup",
      value: SETUP_KEY[state.setup],
      tone: state.setup === "complete" ? "on" : state.setup === "incomplete" ? "warn" : "off",
      label: t("settings.messaging.stateSetup"),
    },
    {
      key: "gateway",
      value: GATEWAY_KEY[gateway],
      tone: gateway === "running" ? "on" : gateway === "stopped" ? "warn" : "off",
      label: t("settings.messaging.stateGateway"),
    },
  ];
  return (
    <span className="settings-messaging-pips">
      {pips.map((pip) => (
        <span
          key={pip.key}
          className="settings-messaging-pip"
          data-tone={pip.tone}
          role="img"
          aria-label={`${pip.label}: ${t(pip.value)}`}
          title={`${pip.label}: ${t(pip.value)}`}
        />
      ))}
    </span>
  );
}

export function MessagingPlatformsPage() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  const [selectedId, setSelectedId] = useState<MessagingPlatformId>("telegram");
  const [secretPresent, setSecretPresent] = useState<Record<string, boolean>>({});
  const [gateway, setGateway] = useState<MessagingGatewaySnapshot>(MESSAGING_GATEWAY_OFF);
  const [saving, setSaving] = useState(false);

  const platform = useMemo(() => platformById(selectedId), [selectedId]);

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
  ) => {
    setSaving(true);
    try {
      await saveMessagingPlatform(
        target,
        draft,
        settings?.[target.section] as MessagingChannelSettings | undefined,
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
    } catch {
      showToast(t("settings.messaging.saveFailed", { platform: t(target.labelKey) }), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const supportedCount = SUPPORTED_MESSAGING_PLATFORMS.length;

  return (
    <div className="settings-messaging">
      <div className="settings-messaging-chooser">
        <div className="settings-messaging-chooser-head">
          <h3 className="settings-card-heading">{t("settings.messaging.listTitle")}</h3>
          <p className="settings-messaging-chooser-note">
            {t("settings.messaging.listSummary", {
              supported: supportedCount,
              total: MESSAGING_PLATFORMS.length,
            })}
          </p>
        </div>
        <div
          className="settings-messaging-list"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.messaging.title")}
        >
          {MESSAGING_PLATFORMS.map((entry) => {
            const state =
              entry.support === "supported"
                ? deriveChannelState(
                    entry,
                    settings?.[entry.section] as MessagingChannelSettings | undefined,
                    secretPresent,
                    gateway,
                  )
                : null;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === platform.id}
                data-nav={`messaging-platform-${entry.id}`}
                data-support={entry.support}
                className={cx(
                  "settings-messaging-item",
                  entry.id === platform.id && "active",
                  entry.support === "unsupported" && "is-unsupported",
                )}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="settings-messaging-item-name">{t(entry.labelKey)}</span>
                {state ? (
                  <StatePips state={state} />
                ) : (
                  <span className="settings-messaging-item-tag">
                    {t("settings.messaging.supportUnsupportedShort")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <section
        className="settings-messaging-detail"
        role="tabpanel"
        aria-label={t(platform.labelKey)}
        data-support={platform.support}
      >
        {platform.support === "supported" ? (
          <MessagingDetail
            key={platform.id}
            platform={platform}
            record={settings?.[platform.section] as MessagingChannelSettings | undefined}
            secretPresent={secretPresent}
            gateway={gateway}
            saving={saving}
            onSave={(draft, enabled) => save(platform, draft, enabled)}
          />
        ) : (
          <UnsupportedPanel platform={platform} />
        )}
      </section>
    </div>
  );
}

/** The detail header: what the platform is, how it is supported, and the action. */
function DetailHeader({
  platform,
  action,
  hint,
}: {
  platform: MessagingPlatform;
  action?: ReactNode;
  hint?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <header className="settings-messaging-head">
      <div className="settings-messaging-head-copy">
        <h3 className="settings-card-heading">{t(platform.labelKey)}</h3>
        <p className="settings-messaging-blurb">{t(platform.blurbKey)}</p>
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
 * The selected channel: its header, and the one draft both the header's quick
 * action and the footer's Save write through.
 *
 * The draft and the enable intent live here, above both controls, because a
 * quick action that flipped its own copy of the flag would either lose the
 * form's edits or persist something the page never showed. One state, one
 * submit path; the header action is a shortcut, not a second form.
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
  record: MessagingChannelSettings | undefined;
  secretPresent: Record<string, boolean>;
  gateway: MessagingGatewaySnapshot;
  saving: boolean;
  onSave: (draft: MessagingDraft, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MessagingDraft>(() => draftFrom(platform, record));
  // The toggle is the intent of THIS save. It starts on because a channel with
  // no record is the one being set up; turning it off is how an existing one is
  // removed. The state strip still reports the stored truth until Save.
  const [enabled, setEnabled] = useState(true);
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
    if (saving || blockedReason !== null) return;
    const next = !storedOn;
    // The footer toggle follows what this click persisted, not the other way
    // round: it is the same flag the save just wrote.
    setEnabled(next);
    await onSave(draft, next);
  };

  return (
    <>
      <DetailHeader
        platform={platform}
        hint={blockedReason}
        action={
          <Button
            type="button"
            size="sm"
            variant={storedOn ? "secondary" : "primary"}
            className="settings-messaging-head-action"
            disabled={saving || blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={() => void runQuickAction()}
          >
            {saving
              ? t("settings.messaging.saving")
              : storedOn
                ? t("settings.messaging.disableNow")
                : t("settings.messaging.enableNow")}
          </Button>
        }
      />
      <SupportedPanel
        platform={platform}
        state={state}
        draft={draft}
        enabled={enabled}
        saving={saving}
        secretPresent={secretPresent}
        onDraftChange={(next) => setDraft((current) => ({ ...current, ...next }))}
        onEnabledChange={() => setEnabled((current) => !current)}
        onSave={onSave}
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
  onDraftChange: (next: Partial<MessagingDraft>) => void;
  onEnabledChange: () => void;
  onSave: (draft: MessagingDraft, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const timeoutValid = isTimeoutValid(draft);
  const ready = canSave(platform, draft);
  const gateway = gatewayPresentation(state);
  const required = fieldsInGroup(platform, "required");
  const recommended = fieldsInGroup(platform, "recommended");

  const patch = onDraftChange;

  const fieldControl = (field: MessagingField) => {
    const id = `messaging-${platform.id}-${field.id}`;
    const label = t(field.labelKey);
    switch (field.id) {
      case "bot-token":
      case "app-token":
      case "access-token":
      case "server-password": {
        const slot = platform.secrets.find((entry) => entry.id === field.id);
        if (!slot) return null;
        return (
          <div className="settings-messaging-secret">
            <PasswordInput
              id={id}
              value={draft.secrets[slot.id] ?? ""}
              aria-label={label}
              autoComplete="off"
              placeholder={t(slot.placeholderKey)}
              showLabel={t("settings.messaging.showSecret")}
              hideLabel={t("settings.messaging.hideSecret")}
              disabled={saving}
              onChange={(event) =>
                patch({ secrets: { ...draft.secrets, [slot.id]: event.target.value } })
              }
            />
            <span className="settings-messaging-secret-state">
              {secretPresent[slot.ref]
                ? t("settings.messaging.secretStored")
                : t("settings.messaging.secretMissing")}
              <span className="settings-messaging-secret-ref">{slot.ref}</span>
            </span>
            <p className="settings-messaging-secret-hint">
              {secretPresent[slot.ref]
                ? t("settings.messaging.secretStoredHint")
                : t("settings.messaging.secretNotStoredHint")}
            </p>
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
      case "subjectPrefix": {
        // Email's record fields: two servers, the account, the sender allowlist
        // and the reply prefix. None of them is a credential, so each is a
        // plain text input and lands in the settings record.
        const numeric = field.id === "imapPort" || field.id === "smtpPort";
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
    const labelled = [
      "bot-token",
      "app-token",
      "access-token",
      "server-password",
      "nick",
      "channels",
      "destination",
      "subject",
      "endpoint",
      "requestTimeoutMs",
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
        <p className="settings-messaging-field-consequence">{t(consequenceKey)}</p>
      </div>
    );
  };

  return (
    <>
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

      {state.setup === "incomplete" ? (
        <p className="settings-messaging-missing" role="status">
          {t("settings.messaging.missing", {
            fields: state.missing.map((id) => t(missingLabelKey(id, platform))).join(", "),
          })}
        </p>
      ) : null}

      {platform.id === "telegram" ? (
        <TelegramQuickSetup
          disabled={saving}
          onApply={(next) => onDraftChange(next)}
        />
      ) : null}

      <section className="settings-messaging-steps">
        <h4 className="settings-messaging-section-title">
          {t("settings.messaging.getCredentials")}
        </h4>
        <ol className="settings-messaging-step-list">
          {platform.credentialStepKeys.map((key) => (
            <li key={key} className="settings-messaging-step">
              {t(key)}
            </li>
          ))}
        </ol>
        <a
          className="settings-messaging-guide"
          href={platform.guideUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("settings.messaging.guideLink", { platform: t(platform.labelKey) })}
        </a>
      </section>

      {platform.noteKey ? (
        <p className="settings-messaging-note">{t(platform.noteKey)}</p>
      ) : null}

      <form
        className="settings-messaging-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || (enabled && !ready)) return;
          void onSave(draft, enabled);
        }}
      >
        <fieldset className="settings-messaging-group" disabled={saving}>
          <legend className="settings-messaging-group-title">
            {t("settings.messaging.requiredGroup")}
          </legend>
          {required.map(renderField)}
        </fieldset>

        <fieldset className="settings-messaging-group" disabled={saving}>
          <legend className="settings-messaging-group-title">
            {t("settings.messaging.recommendedGroup")}
            <span className="settings-messaging-group-note">
              {t("settings.messaging.recommendedNote")}
            </span>
          </legend>
          {recommended.map(renderField)}
        </fieldset>

        <div className="settings-messaging-footer">
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
    default:
      return "settings.messaging.botToken";
  }
}

const PROBE_FAILURE_KEY: Record<TelegramProbeFailure, string> = {
  malformed: "settings.messaging.quickMalformed",
  unauthorized: "settings.messaging.quickUnauthorized",
  network: "settings.messaging.quickNetwork",
  refused: "settings.messaging.quickRefused",
};

/**
 * Telegram's quick setup: the half of the walkthrough that can be done for the
 * user rather than by them.
 *
 * A token pasted here is checked against Telegram's `getMe`, so "I created a
 * bot" becomes a confirmed bot with a name; then `getUpdates` finds the chat
 * that has messaged it, so the numeric chat id is discovered instead of read off
 * another bot. Both calls run in the desktop main process against a fixed host.
 * Nothing is saved here: the values land in the form, and the Save button at the
 * bottom is still the only writer.
 */
function TelegramQuickSetup({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (next: { destination?: string; secrets?: Record<string, string> }) => void;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"bot" | "chats" | null>(null);
  const [bot, setBot] = useState<{ username: string; name: string } | null>(null);
  const [failure, setFailure] = useState<TelegramProbeFailure | null>(null);
  const [chat, setChat] = useState<TelegramChatCandidate | null>(null);
  const [noChat, setNoChat] = useState(false);

  const check = async () => {
    setBusy("bot");
    setFailure(null);
    setNoChat(false);
    setChat(null);
    try {
      const result = await api.probeTelegram(token, "bot");
      if (result.ok && "bot" in result) {
        setBot({ username: result.bot.username, name: result.bot.name });
        onApply({ secrets: { "bot-token": token.trim() } });
      } else {
        setBot(null);
        setFailure(result.ok ? "refused" : result.reason);
      }
    } catch {
      setBot(null);
      setFailure("network");
    } finally {
      setBusy(null);
    }
  };

  const findChat = async () => {
    setBusy("chats");
    setFailure(null);
    setNoChat(false);
    try {
      const result = await api.probeTelegram(token, "chats");
      if (result.ok && "chats" in result) {
        const first = result.chats[0];
        if (!first) {
          setNoChat(true);
        } else {
          setChat(first);
          onApply({ destination: first.id });
        }
      } else {
        setFailure(result.ok ? "refused" : result.reason);
      }
    } catch {
      setFailure("network");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-messaging-quick">
      <h4 className="settings-messaging-section-title">
        {t("settings.messaging.quickTitle")}
      </h4>
      <p className="settings-messaging-quick-body">{t("settings.messaging.quickBody")}</p>
      <div className="settings-messaging-quick-row">
        <PasswordInput
          value={token}
          aria-label={t("settings.messaging.botToken")}
          placeholder={t("settings.messaging.telegramTokenPlaceholder")}
          autoComplete="off"
          showLabel={t("settings.messaging.showSecret")}
          hideLabel={t("settings.messaging.hideSecret")}
          disabled={disabled || busy !== null}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || busy !== null || token.trim() === ""}
          onClick={() => void check()}
        >
          {busy === "bot" ? t("settings.messaging.quickChecking") : t("settings.messaging.quickCheck")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || busy !== null || bot === null}
          onClick={() => void findChat()}
        >
          {busy === "chats" ? t("settings.messaging.quickFinding") : t("settings.messaging.quickFind")}
        </Button>
      </div>
      {bot ? (
        <p className="settings-messaging-quick-note ok" role="status">
          {t("settings.messaging.quickVerified", { username: bot.username })}
        </p>
      ) : null}
      {chat ? (
        <p className="settings-messaging-quick-note ok" role="status">
          {t("settings.messaging.quickFound", { chat: chat.title, id: chat.id })}
        </p>
      ) : null}
      {noChat && bot ? (
        <p className="settings-messaging-quick-note" role="status">
          {t("settings.messaging.quickNoChat", { username: bot.username })}
        </p>
      ) : null}
      {failure ? (
        <p className="settings-messaging-quick-note bad" role="status">
          {t(PROBE_FAILURE_KEY[failure])}
        </p>
      ) : null}
    </section>
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
          >
            {t("settings.messaging.unsupportedGuide", { platform: name })}
          </a>
        ) : null}
      </div>
    </>
  );
}
