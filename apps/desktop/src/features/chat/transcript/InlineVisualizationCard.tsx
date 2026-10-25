import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { Badge, Button, Panel } from "../../../components/ui";
import { api } from "../../../lib/api";
import {
  inlineVizMetaOf,
  srcDocFor,
  type InlineVisualizationCardMeta,
} from "../../../lib/inline-viz";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import "../../../styles/inline-viz.css";

/**
 * The transcript card for a `WriteInlineVisualization` tool result (ADR 0327).
 *
 * The tool result carries only the reference (`{ visualization: meta }`);
 * the content is fetched through the read-only IPC channel on first expand.
 * The artifact renders inside an iframe whose `sandbox` attribute is empty,
 * which grants nothing — no script execution, no same-origin access, no
 * top-navigation — so the agent's HTML/SVG can never run code or reach the
 * app's origin. The whole card is opt-in: it renders only while the Settings
 * switch is on.
 */
export const InlineVisualizationCard = memo(function InlineVisualizationCard({
  message,
}: {
  message: UiMessage;
}) {
  const { t } = useTranslation();
  const enabled = useAppStore(
    (state) => state.settings?.inlineVisualizations === true,
  );
  const meta = useMemo(
    () => inlineVizMetaOf(toolResultPayload(message)),
    [message],
  );
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || !meta || content !== null || failed) return;
    let cancelled = false;
    api
      .readInlineVisualization(meta.sessionId, meta.id)
      .then((artifact) => {
        if (!cancelled) setContent(artifact.content);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, meta, content, failed]);

  if (!enabled || !meta) return null;

  return (
    <InlineVisualizationPreview
      meta={meta}
      open={open}
      content={content}
      failed={failed}
      t={t}
      onToggle={() => setOpen((value) => !value)}
    />
  );
});

/**
 * The presentational half of the card: title, kind badge, expand/collapse
 * control, and the sandboxed preview. Kept separate so the markup — and the
 * sandbox contract — is directly testable without driving the store or IPC.
 */
export function InlineVisualizationPreview({
  meta,
  open,
  content,
  failed,
  t,
  onToggle,
}: {
  meta: InlineVisualizationCardMeta;
  open: boolean;
  content: string | null;
  failed: boolean;
  t: TFunction;
  onToggle: () => void;
}) {
  return (
    <Panel className="inline-viz-card">
      <div className="inline-viz-head">
        <span className="inline-viz-title" title={meta.title}>
          {meta.title}
        </span>
        <Badge tone="neutral">{t(`inlineViz.kind.${meta.kind}`)}</Badge>
        <Button
          type="button"
          variant="secondary"
          className="inline-viz-toggle"
          onClick={onToggle}
          aria-expanded={open}
        >
          {open ? t("inlineViz.hidePreview") : t("inlineViz.showPreview")}
        </Button>
      </div>
      {open ? (
        content !== null ? (
          <iframe
            className="inline-viz-frame"
            sandbox=""
            title={meta.title}
            srcDoc={srcDocFor(meta.kind, content)}
          />
        ) : failed ? (
          <div className="inline-viz-status">{t("inlineViz.loadFailed")}</div>
        ) : (
          <div className="inline-viz-status" role="status">
            {t("inlineViz.loading")}
          </div>
        )
      ) : null}
    </Panel>
  );
}
