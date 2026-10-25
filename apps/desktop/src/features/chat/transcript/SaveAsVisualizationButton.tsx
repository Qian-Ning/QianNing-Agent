import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChartColumn } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

/**
 * "Save as visualization" (ADR 0328): the renderer-side write path.
 *
 * The affordance sits on an assistant answer and hands that answer's markdown
 * to host-core as a `text` artifact of the session it belongs to. It is the
 * only place the renderer writes, so it stays deliberately small: the
 * transcript already rendered this text, the user is the one clicking, and
 * host-core re-applies the same title/kind/size bounds and records an audit
 * row. The button is hidden unless inline visualizations are switched on, so
 * a user who never opted in never sees a write surface.
 */
export function SaveAsVisualizationButton({
  content,
  sessionId,
}: {
  content: string;
  /** The active session; absent while no conversation is open. */
  sessionId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const enabled = useAppStore(
    (state) => state.settings?.inlineVisualizations === true,
  );
  const showToast = useAppStore((state) => state.showToast);
  const [saving, setSaving] = useState(false);

  if (!enabled || !sessionId || !content.trim()) return null;

  const label = t("inlineViz.saveAsVisualization");
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // The title is the answer's first non-empty line, trimmed to the
      // host's ceiling so an over-long heading is not a rejected write.
      const firstLine =
        content
          .split("\n")
          .map((line) => line.replace(/^#+\s*/, "").trim())
          .find((line) => line.length > 0) ?? "";
      const title = (firstLine || label).slice(0, 120);
      await api.writeInlineVisualization(sessionId, {
        title,
        kind: "text",
        content,
      });
      showToast(t("inlineViz.savedAsVisualization"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <TooltipButton
      className="copy-btn icon"
      tooltip={label}
      ariaLabel={label}
      disabled={saving}
      onClick={() => void save()}
    >
      <IconChartColumn size={13} />
    </TooltipButton>
  );
}
