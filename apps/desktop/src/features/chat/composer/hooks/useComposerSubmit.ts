import type { TFunction } from "i18next";
import {
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
} from "@pi-desktop/shared";
import type { AppState } from "../../../../stores/app-store";
import { api } from "../../../../lib/api";
import { runExtensionCommand, runPaletteCommand } from "../../../../lib/commands";
import { resolveComposerCommand } from "../../../../hooks/use-composer-autocomplete";
import {
  parseSlashSubmission,
  resolveSlashDispatch,
} from "../slash-dispatch";
import { readEditorValue, type ComposerFileReference } from "../editor";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerSubmitOptions = {
  value: string;
  draftKey: string;
  modelReady: boolean;
  sendBlocked: boolean;
  pasting: boolean;
  activeFileReferences: ComposerFileReference[];
  t: TFunction;
  sendPrompt: AppState["sendPrompt"];
  steerPrompt: AppState["steerPrompt"];
  showToast: AppState["showToast"];
  draft: Pick<
    ComposerDraftController,
    | "ref"
    | "draftSnapshot"
    | "draftRevision"
    | "clearDraftForKey"
    | "restoreDraftForKey"
    | "setValue"
    | "setCursor"
  >;
};

export type ComposerSubmitController = {
  submit: (steering?: boolean) => Promise<void>;
};

/**
 * Own send orchestration. It deliberately receives the draft controller as a
 * narrow dependency so command dispatch and optimistic draft clearing remain
 * independent from editor rendering.
 */
export function useComposerSubmit({
  value,
  draftKey,
  modelReady,
  sendBlocked,
  pasting,
  activeFileReferences,
  t,
  sendPrompt,
  steerPrompt,
  showToast,
  draft,
}: UseComposerSubmitOptions): ComposerSubmitController {
  const submit = async (steering = false) => {
    const text = draft.ref.current ? readEditorValue(draft.ref.current) : value;
    const inlineContent = serializeInlineComposerFileReferences(
      text,
      activeFileReferences,
    );
    const serializedContent = serializeComposerFileReferences(text, activeFileReferences);
    if (!serializedContent) return;
    if (sendBlocked) {
      if (pasting) showToast(t("chat.pasteInProgress"), { variant: "info" });
      return;
    }
    const submittedDraftKey = draftKey;
    const submittedDraftRevision = draft.draftRevision(submittedDraftKey);
    const submittedDraft = draft.draftSnapshot(text);
    // Slash dispatch stays local for builtin and extension commands, while
    // templates, skills, and unknown aliases continue as normal prompt text. A
    // command source that cannot be read is a third case: the composer cannot
    // prove `/compact` is not a builtin, so it refuses the submission and keeps
    // the text out of the model's input (issue #795).
    if (!steering) {
      const slashSubmission = parseSlashSubmission(serializedContent);
      const resolution = slashSubmission
        ? await resolveComposerCommand(slashSubmission.name)
        : null;
      const dispatch = resolveSlashDispatch(slashSubmission, resolution);
      if (dispatch.action === "blocked") {
        showToast(t("chat.slashCommandSourceUnavailable"), {
          variant: "error",
        });
        return;
      }
      if (dispatch.action === "dispatch") {
        const command = dispatch.command;
        const commandBody = dispatch.body;
        const isModeCommand =
          command.id === "builtin.mode.agent" ||
          command.id === "builtin.mode.plan" ||
          command.id === "builtin.mode.goal";
        if (isModeCommand && commandBody) {
          try {
            await runPaletteCommand(command.id);
            const visibleDraft = text.trim();
            const visibleCommandEnd = visibleDraft.search(/\s/);
            const visibleCommandBody =
              visibleCommandEnd === -1
                ? ""
                : visibleDraft.slice(visibleCommandEnd).trim();
            const accepted = await sendPrompt(
              serializeInlineComposerFileReferences(
                visibleCommandBody,
                activeFileReferences,
              ),
              draft.draftSnapshot(visibleCommandBody),
            );
            if (accepted) draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
        if (command.kind === "extension") {
          try {
            await runExtensionCommand(command.name, commandBody);
            draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
        if (!commandBody) {
          try {
            if (command.kind === "builtin") await runPaletteCommand(command.id);
            else await api.executeCommand(command.id);
            draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
      }
    }
    if (!steering && !modelReady) {
      showToast(t("errors.MODEL_NOT_CONFIGURED"), { variant: "error" });
      return;
    }
    draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
    const accepted = steering
      ? await steerPrompt(inlineContent, submittedDraft)
      : await sendPrompt(inlineContent, submittedDraft);
    if (!accepted) draft.restoreDraftForKey(submittedDraftKey, submittedDraft);
  };

  return { submit };
}
