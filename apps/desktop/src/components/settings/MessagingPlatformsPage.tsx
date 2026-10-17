import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessagingChannelSettings } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  MESSAGING_PERMISSION_MODES,
  MESSAGING_PLATFORMS,
  MESSAGING_ROLES,
  deriveMessagingStatus,
  draftFrom,
  draftMissing,
  platformById,
  saveMessagingPlatform,
  type MessagingDraft,
  type MessagingPlatform,
  type MessagingPlatformId,
  type MessagingStatus,
} from "../../lib/messaging-platforms";
import {
  Badge,
  Button,
  CheckboxGroup,
  Field,
  Input,
  PasswordInput,
  SegmentedControl,
  cx,
} from "../ui";

/**
 * Settings ▸ Messaging platforms: the platforms this build can actually run,
 * one at a time, with the credential form the stored record really has.
 *
 * The page is deliberately a master/detail pair rather than a stack of cards:
 * the left rail is the platform list, the right pane is the selected platform's
 * record, its state and its save. It is not part of Connections — a messaging
 * platform is a channel the agent is reached on, not a target it dials — and it
 * is not a second target manager.
 *
 * What the form edits is exactly what the runtime reads
 * (`packages/agent-host/src/messaging-*.ts` for the link,
 * `crates/host-core/src/messaging_{telegram,slack}.rs` for the record), so a
 * save cannot invent a field the host ignores.
 *
 * Credentials: a token typed here is written to the host's secret store under
 * its `secret:` ref and never into the settings row (`buildSectionWrite` does
 * not read the token fields at all). The page learns only whether a ref is
 * present, so a stored token is never rendered back.
 */

const STATUS_KEY: Record<MessagingStatus, string> = {
  disabled: "settings.messaging.statusDisabled",
  needsSetup: "settings.messaging.statusNeedsSetup",
  running: "settings.messaging.statusRunning",
  error: "settings.messaging.statusError",
};

function statusTone(status: MessagingStatus): "neutral" | "success" | "warning" | "error" {
  switch (status) {
    case "running":
      return "success";
    case "needsSetup":
      return "warning";
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

/** The label a missing-field id reads as in the status line. */
function missingLabelKey(id: string): string {
  switch (id) {
    case "endpoint":
      return "settings.messaging.endpoint";
    case "destination":
      return "settings.messaging.destination";
    case "link":
      return "settings.messaging.link";
    case "app-token":
      return "settings.messaging.appToken";
    default:
      return "settings.messaging.botToken";
  }
}

function StatusBadge({ status }: { status: MessagingStatus }) {
  const { t } = useTranslation();
  return <Badge tone={statusTone(status)}>{t(STATUS_KEY[status])}</Badge>;
}

export function MessagingPlatformsPage() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  const [selectedId, setSelectedId] = useState<MessagingPlatformId>(
    MESSAGING_PLATFORMS[0].id,
  );
  const [secretPresent, setSecretPresent] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const platform = useMemo(() => platformById(selectedId), [selectedId]);
  const record = settings?.[platform.section] as MessagingChannelSettings | undefined;

  /**
   * Presence only: `secrets.has` answers whether the host holds a credential
   * under the ref. There is no read path from the renderer, by design.
   */
  const loadSecretPresence = useCallback(async () => {
    const slots = MESSAGING_PLATFORMS.flatMap((entry) => entry.secrets);
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

  useEffect(() => {
    void loadSecretPresence();
  }, [loadSecretPresence]);

  const save = async (draft: MessagingDraft) => {
    setSaving(true);
    try {
      await saveMessagingPlatform(platform, draft, record, {
        writeSection: async (section, value) => {
          await api.setMessagingSection(section, value);
        },
        setSecret: async (ref, value) => {
          await api.setSecret(ref, value);
        },
      });
      // The settings row is the page's only view of the channel, so re-read it
      // rather than assume the write landed in the shape we sent.
      const next = await api.getSettings();
      useAppStore.setState({ settings: next });
      await loadSecretPresence();
      showToast(t("settings.messaging.saved", { platform: t(platform.labelKey) }), {
        variant: "info",
      });
    } catch {
      showToast(t("settings.messaging.saveFailed", { platform: t(platform.labelKey) }), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-stack settings-messaging">
      <div
        className="settings-messaging-list"
        role="tablist"
        aria-label={t("settings.messaging.title")}
      >
        {MESSAGING_PLATFORMS.map((entry) => {
          const view = deriveMessagingStatus(
            entry,
            settings?.[entry.section] as MessagingChannelSettings | undefined,
            secretPresent,
          );
          return (
            <Button
              key={entry.id}
              type="button"
              variant="ghost"
              role="tab"
              aria-selected={entry.id === platform.id}
              data-nav={`messaging-platform-${entry.id}`}
              className={cx(
                "settings-messaging-item",
                entry.id === platform.id && "active",
              )}
              onClick={() => setSelectedId(entry.id)}
            >
              <span className="settings-messaging-item-name">{t(entry.labelKey)}</span>
              <StatusBadge status={view.status} />
            </Button>
          );
        })}
      </div>

      <section
        className="settings-messaging-detail"
        role="tabpanel"
        aria-label={t(platform.labelKey)}
      >
        {settings ? (
          <PlatformForm
            /* A new platform gets a fresh draft; the same platform keeps what
               the user typed while the settings row refreshes around it. */
            key={platform.id}
            platform={platform}
            record={record}
            secretPresent={secretPresent}
            saving={saving}
            onSave={save}
          />
        ) : (
          <p className="settings-messaging-blurb" role="status">
            {t("settings.messaging.loading")}
          </p>
        )}
      </section>
    </div>
  );
}

function PlatformForm({
  platform,
  record,
  secretPresent,
  saving,
  onSave,
}: {
  platform: MessagingPlatform;
  record: MessagingChannelSettings | undefined;
  secretPresent: Record<string, boolean>;
  saving: boolean;
  onSave: (draft: MessagingDraft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MessagingDraft>(() => draftFrom(platform, record));
  const view = deriveMessagingStatus(platform, record, secretPresent);
  const missing = draftMissing(platform, draft);

  return (
    <>
      <header className="settings-messaging-head">
        <div className="settings-messaging-head-copy">
          <h3 className="settings-card-heading">{t(platform.labelKey)}</h3>
          <p className="settings-messaging-blurb">{t(platform.blurbKey)}</p>
        </div>
        <StatusBadge status={view.status} />
      </header>

      <p className="settings-messaging-status-note" role="status">
        {view.status === "needsSetup"
          ? t("settings.messaging.missing", {
              fields: view.missing.map((id) => t(missingLabelKey(id))).join(", "),
            })
          : t("settings.messaging.statusNote")}
      </p>

      <form
        className="settings-messaging-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (missing.length > 0 || saving) return;
          void onSave(draft);
        }}
      >
        <Field label={t("settings.messaging.endpoint")} hint={t("settings.messaging.endpointHint")}>
          <Input
            value={draft.endpoint}
            aria-label={t("settings.messaging.endpoint")}
            onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
            disabled={saving}
          />
        </Field>

        <Field
          label={t("settings.messaging.destination")}
          hint={t("settings.messaging.destinationHint")}
        >
          <Input
            value={draft.destination}
            aria-label={t("settings.messaging.destination")}
            onChange={(event) => setDraft({ ...draft, destination: event.target.value })}
            disabled={saving}
          />
        </Field>

        <Field
          label={t("settings.messaging.subject")}
          hint={t("settings.messaging.subjectHint")}
        >
          <Input
            value={draft.subject}
            aria-label={t("settings.messaging.subject")}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            disabled={saving}
          />
        </Field>

        <Field label={t("settings.messaging.roles")} hint={t("settings.messaging.rolesHint")}>
          <CheckboxGroup
            values={draft.roles}
            onChange={(roles) => setDraft({ ...draft, roles })}
            options={MESSAGING_ROLES.map((role) => ({
              value: role,
              label: t(`settings.messaging.role.${role}`),
            }))}
            label={t("settings.messaging.roles")}
            minSelected={1}
            disabled={saving}
          />
        </Field>

        <Field
          label={t("settings.messaging.permissionMode")}
          hint={t("settings.messaging.permissionModeHint")}
        >
          <SegmentedControl
            value={draft.permissionMode}
            label={t("settings.messaging.permissionMode")}
            disabled={saving}
            onChange={(value) =>
              setDraft({ ...draft, permissionMode: value as MessagingDraft["permissionMode"] })
            }
            options={MESSAGING_PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: t(`settings.messaging.mode.${mode}`),
            }))}
          />
        </Field>

        <Field
          label={t("settings.messaging.requestTimeout")}
          hint={t("settings.messaging.requestTimeoutHint")}
        >
          <Input
            value={draft.requestTimeoutMs}
            inputMode="numeric"
            aria-label={t("settings.messaging.requestTimeout")}
            onChange={(event) =>
              setDraft({ ...draft, requestTimeoutMs: event.target.value })
            }
            disabled={saving}
          />
        </Field>

        {platform.secrets.map((slot) => (
          <Field key={slot.id} label={t(slot.labelKey)} hint={t(slot.hintKey)}>
            <div className="settings-messaging-secret">
              <PasswordInput
                value={draft.secrets[slot.id] ?? ""}
                aria-label={t(slot.labelKey)}
                autoComplete="off"
                placeholder={
                  secretPresent[slot.ref]
                    ? t("settings.messaging.secretPlaceholderStored")
                    : t("settings.messaging.secretPlaceholderEmpty")
                }
                showLabel={t("settings.messaging.showSecret")}
                hideLabel={t("settings.messaging.hideSecret")}
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    secrets: { ...draft.secrets, [slot.id]: event.target.value },
                  })
                }
              />
              <span className="settings-messaging-secret-state">
                {secretPresent[slot.ref]
                  ? t("settings.messaging.secretStored")
                  : t("settings.messaging.secretMissing")}
              </span>
              <span className="settings-messaging-secret-ref">{slot.ref}</span>
            </div>
          </Field>
        ))}

        <div className="settings-messaging-actions">
          <Button type="submit" variant="primary" disabled={saving || missing.length > 0}>
            {saving ? t("settings.messaging.saving") : t("settings.messaging.save")}
          </Button>
        </div>
      </form>
    </>
  );
}
