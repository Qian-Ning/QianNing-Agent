import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { inlineVizUrlFor } from "@pi-desktop/shared";
import type { UiMessage } from "@pi-desktop/shared";
import { Badge, Button, Panel } from "../../../components/ui";
import { api } from "../../../lib/api";
import {
  inlineVizMetaOf,
  sandboxAttrFor,
  scriptedSrcDocFor,
  srcDocFor,
  type InlineVisualizationCardMeta,
} from "../../../lib/inline-viz";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import "../../../styles/inline-viz.css";

/** Kinds the scheme can serve as a document the frame renders natively. */
const STREAMED_KINDS = new Set(["html", "svg"]);

/**
 * The transcript card for a `WriteInlineVisualization` tool result (ADR 0327).
 *
 * The tool result carries only the reference (`{ visualization: meta }`), so
 * the card resolves the content itself. Documents the frame can render
 * natively (html, svg) load straight from the `qn-visuals:` scheme (ADR 0328),
 * which streams the artifact out of host-core's visualization root without a
 * JSON round trip; the textual kinds are escaped into `srcDoc` because they
 * need the wrapper. Either way the frame's `sandbox` attribute is the gate:
 * empty by default — no scripts, no same-origin, no navigation — and
 * `allow-scripts` alone only when the user allowed scripted previews.
 *
 * The scheme is not trusted blindly: the card probes it once and, if the
 * request fails (handler not installed, artifact swept), falls back to reading
 * through IPC and rendering `srcDoc`, so an unavailable scheme degrades to
 * ADR 0327's behavior instead of an empty frame.
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
  const scriptedAllowed = useAppStore(
    (state) =>
      state.settings?.inlineVisualizations === true &&
      state.settings?.inlineVizScriptedPreviews === true,
  );
  const meta = useMemo(
    () => inlineVizMetaOf(toolResultPayload(message)),
    [message],
  );
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // `null` while undecided: the document is streamed unless the probe said no.
  const [streamed, setStreamed] = useState<boolean | null>(null);
  const probeStarted = useRef(false);

  const scripted = scriptedAllowed && meta?.kind === "html";
  const schemeUrl = meta
    ? inlineVizUrlFor(meta.sessionId, meta.id, { scripted })
    : null;

  useEffect(() => {
    if (!open || !meta) return;
    let cancelled = false;

    const readViaIpc = () => {
      api
        .readInlineVisualization(meta.sessionId, meta.id)
        .then((artifact) => {
          if (!cancelled) {
            setContent(artifact.content);
            setStreamed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };

    // A document kind streams; everything else needs the escaped wrapper. The
    // probe decides once per mount, so re-opening does not re-fetch.
    if (STREAMED_KINDS.has(meta.kind) && schemeUrl && !probeStarted.current) {
      probeStarted.current = true;
      fetch(schemeUrl)
        .then((response) => {
          if (cancelled) return;
          if (response.ok) {
            setStreamed(true);
            return;
          }
          readViaIpc();
        })
        .catch(() => {
          if (!cancelled) readViaIpc();
        });
      return () => {
        cancelled = true;
      };
    }
    if (content === null && !failed && streamed !== true) readViaIpc();
    return () => {
      cancelled = true;
    };
  }, [open, meta, content, failed, schemeUrl, streamed]);

  if (!enabled || !meta) return null;

  return (
    <InlineVisualizationPreview
      meta={meta}
      open={open}
      content={content}
      failed={failed}
      scripted={scripted}
      schemeUrl={streamed === true ? schemeUrl : null}
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
  scripted,
  schemeUrl = null,
  t,
  onToggle,
}: {
  meta: InlineVisualizationCardMeta;
  open: boolean;
  content: string | null;
  failed: boolean;
  scripted: boolean;
  /** Set when the artifact should stream from the scheme instead of srcDoc. */
  schemeUrl?: string | null;
  t: TFunction;
  onToggle: () => void;
}) {
  const sandbox = sandboxAttrFor({ kind: meta.kind, scriptedAllowed: scripted });
  const streaming = schemeUrl !== null && STREAMED_KINDS.has(meta.kind);
  const ready = streaming || content !== null;
  return (
    <Panel className="inline-viz-card">
      <div className="inline-viz-head">
        <span className="inline-viz-title" title={meta.title}>
          {meta.title}
        </span>
        <Badge tone="neutral">{t(`inlineViz.kind.${meta.kind}`)}</Badge>
        {scripted ? (
          <Badge tone="neutral">{t("inlineViz.scriptedBadge")}</Badge>
        ) : null}
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
        ready ? (
          <iframe
            className="inline-viz-frame"
            sandbox={sandbox}
            title={meta.title}
            src={streaming ? (schemeUrl ?? undefined) : undefined}
            srcDoc={
              streaming
                ? undefined
                : scripted && meta.kind === "html"
                  ? scriptedSrcDocFor(content ?? "")
                  : srcDocFor(meta.kind, content ?? "")
            }
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
