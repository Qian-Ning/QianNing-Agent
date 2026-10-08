/**
 * The workbench's result surface.
 *
 * One card per requested output, in request order, from the moment it is queued
 * until it lands on disk. That ordering is the point: a batch of eight clips can
 * succeed, fail and still be running at the same time, and the user is paying per
 * second for all of it — so every item has to be individually accountable rather
 * than summarized by a single spinner.
 *
 * Images render from the file the generation wrote; a video is not loaded into
 * the renderer at all (a clip can be hundreds of megabytes), so its card names
 * the file and offers the path instead of pretending to play it.
 */
import { useEffect, useState } from "react";
import { IconDownload, IconFolderOpen, IconImage } from "../../components/icons";
import { api } from "../../lib/api";
import { useTranslation } from "react-i18next";
import type { MediaWorkbenchItemResult } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { IconChevronLeft, IconChevronRight, IconClose, IconCopy } from "../../components/icons";
import { useReferencedImageDataUrl } from "../../lib/use-referenced-image-data-url";

export type ItemState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type WorkbenchOutput = {
  index: number;
  state: ItemState;
  result?: MediaWorkbenchItemResult;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Full-size view for one generated image, arrow-steppable across the batch. */
function Lightbox({
  paths,
  startIndex,
  onClose,
}: {
  paths: string[];
  startIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(startIndex);
  const path = paths[position] ?? "";
  const dataUrl = useReferencedImageDataUrl(path, undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setPosition((current) => (current + 1) % paths.length);
      if (event.key === "ArrowLeft")
        setPosition((current) => (current - 1 + paths.length) % paths.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, paths.length]);

  return (
    <div
      className="workbench-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("workbench.preview")}
      onClick={onClose}
    >
      <div className="workbench-lightbox-body" onClick={(event) => event.stopPropagation()}>
        {dataUrl ? <img src={dataUrl} alt={fileName(path)} /> : null}
        <div className="workbench-lightbox-bar">
          <span className="font-mono">{`${position + 1}/${paths.length}`}</span>
          <span className="workbench-lightbox-path font-mono">{fileName(path)}</span>
          {paths.length > 1 ? (
            <>
              <Button
                type="button"
                size="sm"
                aria-label={t("workbench.previous")}
                onClick={() => setPosition((current) => (current - 1 + paths.length) % paths.length)}
              >
                <IconChevronLeft size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                aria-label={t("workbench.next")}
                onClick={() => setPosition((current) => (current + 1) % paths.length)}
              >
                <IconChevronRight size={14} aria-hidden />
              </Button>
            </>
          ) : null}
          <Button type="button" size="sm" onClick={onClose}>
            <IconClose size={14} aria-hidden />
            {t("workbench.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OutputCard({
  output,
  capability,
  fileNote,
  onSave,
  onReveal,
  onUseAsReference,
  onRetry,
  onPreview,
}: {
  output: WorkbenchOutput;
  capability: "image" | "video";
  onUseAsReference: (path: string) => void;
  onRetry: () => void;
  onPreview: (index: number) => void;
  fileNote: { path: string; text: string } | null;
  onSave: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const { t } = useTranslation();
  const result = output.result;
  const path = result?.path ?? "";
  const isImage = capability === "image";
  const dataUrl = useReferencedImageDataUrl(
    isImage && output.state === "succeeded" ? path : "",
    result?.mimeType,
  );

  return (
    <figure className={`workbench-card is-${output.state}`}>
      <div className="workbench-card-media">
        {output.state === "succeeded" && isImage && dataUrl ? (
          <button
            type="button"
            className="workbench-card-image"
            aria-label={t("workbench.preview")}
            onClick={() => onPreview(output.index)}
          >
            <img src={dataUrl} alt={fileName(path)} />
          </button>
        ) : output.state === "succeeded" ? (
          <div className="workbench-card-file">
            <span className="workbench-card-kind">{result?.mimeType ?? "video"}</span>
            <code>{fileName(path)}</code>
            {result && "durationSeconds" in result && result.durationSeconds ? (
              <span>{`${result.durationSeconds}s`}</span>
            ) : null}
          </div>
        ) : output.state === "running" ? (
          <div className="workbench-card-pending">
            <span className="workbench-spinner" aria-hidden />
            <span>{t("workbench.itemRunning")}</span>
          </div>
        ) : output.state === "pending" ? (
          <div className="workbench-card-pending">
            <span>{t("workbench.itemQueued")}</span>
          </div>
        ) : (
          <div className="workbench-card-pending is-failed">
            <strong>
              {output.state === "cancelled" ? t("workbench.cancelled") : t("workbench.itemFailed")}
            </strong>
            {result?.errorCode ? <code>{result.errorCode}</code> : null}
          </div>
        )}
      </div>
      <figcaption className="workbench-card-foot">
        <span className="workbench-card-index">{output.index + 1}</span>
        {output.state === "succeeded" ? (
          <span className="workbench-card-actions">
            <button
              type="button"
              className="workbench-icon-button"
              aria-label={t("workbench.saveAs")}
              title={t("workbench.saveAs")}
              onClick={() => void onSave(path)}
            >
              <IconDownload size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="workbench-icon-button"
              aria-label={t("workbench.revealFile")}
              title={t("workbench.revealFile")}
              onClick={() => void onReveal(path)}
            >
              <IconFolderOpen size={14} aria-hidden />
            </button>
            {isImage ? (
              <button
                type="button"
                className="workbench-icon-button"
                aria-label={t("workbench.useAsReference")}
                title={t("workbench.useAsReference")}
                onClick={() => onUseAsReference(path)}
              >
                <IconImage size={14} aria-hidden />
              </button>
            ) : null}
          </span>
        ) : null}
        {fileNote?.path === path ? (
          <span className="workbench-hint">{fileNote.text}</span>
        ) : null}
        {output.state === "failed" ? (
          <Button type="button" size="sm" onClick={onRetry}>
            {t("workbench.retry")}
          </Button>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function WorkbenchResults({
  capability,
  sessionId,
  outputs,
  onUseAsReference,
  onRetry,
}: {
  capability: "image" | "video";
  sessionId: string;
  outputs: WorkbenchOutput[];
  onUseAsReference: (path: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const imagePaths = outputs
    .filter((output) => output.state === "succeeded" && output.result?.path)
    .map((output) => output.result?.path as string);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // Saving is per file: the note belongs to the card that asked for it, so a
  // message about one render never appears under another.
  const [fileNote, setFileNote] = useState<{ path: string; text: string } | null>(null);

  const saveAs = async (path: string) => {
    const result = await api.workbenchSaveAs({ sessionId, path });
    if (result.ok) setFileNote({ path, text: t("workbench.saved") });
    else if (!result.cancelled) setFileNote({ path, text: t("workbench.saveFailed") });
  };

  const reveal = async (path: string) => {
    await api.workbenchReveal({ sessionId, path });
  };
  const previewPosition =
    previewIndex === null ? -1 : Math.max(0, imagePaths.indexOf(outputs[previewIndex]?.result?.path as string));

  return (
    <>
      <div className="workbench-outputs">
        {outputs.map((output) => (
          <OutputCard
            key={output.index}
            output={output}
            capability={capability}
            onUseAsReference={onUseAsReference}
            onRetry={onRetry}
            onPreview={setPreviewIndex}
            fileNote={fileNote}
            onSave={(path) => void saveAs(path)}
            onReveal={(path) => void reveal(path)}
          />
        ))}
      </div>
      {previewIndex !== null && imagePaths.length ? (
        <Lightbox
          paths={imagePaths}
          startIndex={previewPosition}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  );
}
