import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentInstructionFile, AppSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useUpdateState } from "../../hooks/use-update-state";
import { Button, Textarea } from "../../components/ui";
import { IconFileText } from "../../components/icons";
import { ReleaseNotesDialog } from "../../components/ReleaseNotesDialog";
import { SettingsCard, SettingsRow } from "./primitives";

/**
 * The app-wide persona. It is a settings field, not a file, so the user can
 * set it without knowing where AGENTS.md lives; a conversation can still
 * override it from its own prompt editor.
 */
export function GlobalPromptCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const stored = settings.globalSystemPrompt ?? "";
  const [draft, setDraft] = useState<string>(stored);
  const [saving, setSaving] = useState(false);

  // Follow the stored value when it changes elsewhere (config sync, reset),
  // but never stomp on what the user is typing: only a NEW stored value wins.
  useEffect(() => {
    setDraft((current) => (current === stored ? current : stored));
  }, [stored]);

  const dirty = draft !== stored;
  const save = async () => {
    setSaving(true);
    try {
      await saveSettings({ globalSystemPrompt: draft.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title={t("settings.globalPromptTitle")}
      description={t("settings.globalPromptDesc")}
    >
      <div className="settings-form-grid">
        <Textarea
          className="settings-instruction-editor"
          value={draft}
          placeholder={t("settings.globalPromptPlaceholder")}
          aria-label={t("settings.globalPromptTitle")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="settings-row-copy">
          <div className="settings-instruction-path">
            {t("settings.globalPromptHint")}
          </div>
        </div>
      </div>
      <div className="settings-panel-actions">
        <Button
          variant="primary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
    </SettingsCard>
  );
}

export function AgentInstructionsSection({
  settings,
  saveSettings,
}: {
  settings?: AppSettings;
  saveSettings?: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [global, setGlobal] = useState<AgentInstructionFile | null>(null);
  const [globalDraft, setGlobalDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getAgentInstructions().then((result) => {
      if (cancelled) return;
      setGlobal(result.global);
      setGlobalDraft(result.global.content);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.saveAgentInstructions("global", globalDraft);
      setGlobal(result.file);
    } finally {
      setSaving(false);
    }
  };

  const globalDirty = global !== null && globalDraft !== global.content;
  return (
    <div className="settings-stack">
      {settings && saveSettings ? (
        <GlobalPromptCard settings={settings} saveSettings={saveSettings} />
      ) : null}
      <SettingsCard
        title={t("settings.instructionsGlobal")}
        description={t("settings.instructionsGlobalDesc")}
      >
        <div className="settings-form-grid">
          <div className="settings-row-copy">
            <div className="settings-instruction-path">{global?.path ?? ""}</div>
          </div>
          <textarea
            className="field-textarea settings-instruction-editor"
            value={globalDraft}
            onChange={(event) => setGlobalDraft(event.target.value)}
            aria-label={t("settings.instructionsGlobal")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <div className="settings-panel-actions">
          <Button
            variant="primary"
            disabled={!globalDirty || saving}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.instructionsSave")}
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

export function UpdatesRow({ currentVersion }: { currentVersion?: string }) {
  const { t } = useTranslation();
  const update = useUpdateState();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const closeReleaseNotes = useCallback(() => setReleaseNotesOpen(false), []);
  const disabled = !update || update.mode === "disabled";
  const busy = update?.status === "checking" || update?.status === "downloading";

  let action: ReactNode;
  if (update?.status === "downloaded") {
    action = (
      <Button
        variant="primary"
        onClick={() => void api.updatesInstall().catch(() => undefined)}
      >
        {t("updates.restart")}
      </Button>
    );
  } else if (update?.status === "available" && update.mode === "manual") {
    action = (
      <Button
        variant="secondary"
        onClick={() => void api.updatesOpenReleases().catch(() => undefined)}
      >
        {t("updates.viewRelease")}
      </Button>
    );
  } else {
    action = (
      <Button
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => void api.updatesCheck().catch(() => undefined)}
      >
        {busy ? t("updates.checking") : t("updates.check")}
      </Button>
    );
  }

  let statusText: string | null = null;
  if (disabled) {
    statusText = t("updates.devDisabled");
  } else {
    switch (update.status) {
      case "checking":
        statusText = t("updates.checking");
        break;
      case "up-to-date":
        statusText = t("updates.upToDate");
        break;
      case "available":
        statusText = `${t("updates.available", { version: update.availableVersion })}${
          update.mode === "manual" ? ` ${t("updates.manualHint")}` : ""
        }`;
        break;
      case "downloading":
        statusText = t("updates.downloading", {
          percent: update.progressPercent ?? 0,
        });
        break;
      case "downloaded":
        statusText = t("updates.downloaded", {
          version: update.availableVersion,
        });
        break;
      case "error":
        statusText = t("updates.error", { message: update.error ?? "" });
        break;
      default:
        statusText = null;
    }
  }

  const notes = update?.releaseNotes?.trim() || null;
  const showNotes =
    notes &&
    (update?.status === "available" ||
      update?.status === "downloading" ||
      update?.status === "downloaded");

  return (
    <SettingsRow title={t("updates.title")} description={t("updates.desc")}>
      <div className="flex flex-col items-end gap-1.5">
        <div className="update-settings-actions">
          <Button
            variant="secondary"
            onClick={() => setReleaseNotesOpen(true)}
          >
            <IconFileText size={14} />
            {t("updates.releaseNotes")}
          </Button>
          {action}
        </div>
        {statusText ? (
          <div className="text-right text-xs-plus text-text-muted">{statusText}</div>
        ) : null}
        {showNotes ? (
          <div className="update-settings-notes">
            <div className="update-settings-notes-label">{t("updates.whatsNew")}</div>
            <pre className="update-settings-notes-body">{notes}</pre>
          </div>
        ) : null}
      </div>
      {releaseNotesOpen ? (
        <ReleaseNotesDialog
          currentVersion={update?.currentVersion ?? currentVersion}
          availableVersion={update?.availableVersion}
          onClose={closeReleaseNotes}
        />
      ) : null}
    </SettingsRow>
  );
}

