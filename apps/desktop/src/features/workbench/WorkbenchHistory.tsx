/**
 * The workbench's history list.
 *
 * Runs are grouped by outcome — a run that failed is a different thing from a
 * run that worked — and each row names when, which model, what size and, when
 * it failed, why. Picking a row reveals that run in the results panel. Each row
 * also carries its own remove control, and the list as a whole can be cleared or
 * revealed on disk; every removal is a second-confirmed trip to the recycle bin,
 * so a render that cost money is recoverable.
 *
 * The list is the app's library, not a window-local record: its ids are the ones
 * the removal and clear channels act on, and its length is what the visible cap
 * counts.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_LIBRARY_ENTRIES } from "@pi-desktop/shared";
import { IconFolderOpen, IconTrash } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
import { pickRowThumbnail } from "./history-thumbnail";
import { describeLibraryError } from "./library-errors";
import type { Run } from "./useWorkbenchRuns";

/**
 * The picture a row leads with: the first image its run produced.
 *
 * It is decoration, not a control, so it carries no label and no interaction —
 * the row's own pick button already opens the run. A load that fails (the file
 * was moved, the scheme refused it) hides the element rather than showing a
 * broken-image icon or a placeholder, so a row without a working picture looks
 * exactly like it did before thumbnails existed.
 */
function HistoryThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="workbench-history-thumb"
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One past run. Kept beside the type it renders so the two history groups can
 * share a row without repeating the markup twice.
 */
function HistoryRow({
  entry,
  onPick,
  onRemove,
}: {
  entry: Run;
  onPick: (entry: Run) => void;
  onRemove: (entry: Run) => void;
}) {
  const { t } = useTranslation();
  const succeeded = entry.results?.filter((item) => item.status === "succeeded").length ?? 0;
  const failed = entry.ok === false;
  const thumbnail = pickRowThumbnail(entry);
  return (
    <li className="workbench-history-row">
      {thumbnail ? <HistoryThumb url={thumbnail} /> : null}
      <button
        type="button"
        className="workbench-history-pick"
        onClick={() => onPick(entry)}
      >
        <span
          className={`workbench-history-dot${
            entry.ok === null ? "" : entry.ok ? " is-ok" : " is-bad"
          }`}
        />
        <span className="workbench-history-prompt">{entry.prompt}</span>
        <span className="workbench-history-meta">
          {[
            new Date(entry.startedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
            entry.model?.modelId,
            entry.size,
            // A failed or cancelled row names why it is there; a succeeded one
            // counts what it produced. The reason comes from the recorded code,
            // with a generic line standing in for a code the app does not know.
            failed ? describeLibraryError(entry.errorCode, t) : `${succeeded}/${entry.total}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <TooltipButton
        type="button"
        className="workbench-icon-button workbench-history-remove"
        tooltip={t("workbench.historyRemove")}
        ariaLabel={t("workbench.historyRemove")}
        onClick={() => onRemove(entry)}
      >
        <IconTrash size={14} aria-hidden />
      </TooltipButton>
    </li>
  );
}

export function WorkbenchHistory({
  scopedHistory,
  succeededHistory,
  failedHistory,
  libraryCount,
  onPick,
  onRemove,
  onClear,
  onReveal,
}: {
  scopedHistory: Run[];
  succeededHistory: Run[];
  failedHistory: Run[];
  /** Entries the whole library holds, both capabilities, for the visible cap. */
  libraryCount: number;
  onPick: (entry: Run) => void;
  onRemove: (entry: Run) => void;
  onClear: () => void;
  onReveal: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workbench-history">
      <div className="workbench-history-head">
        <h2>{t("workbench.history")}</h2>
        <span className="workbench-history-count">
          {t("workbench.libraryCount", { used: libraryCount, max: MAX_LIBRARY_ENTRIES })}
        </span>
        <span className="workbench-history-actions">
          <TooltipButton
            type="button"
            className="workbench-icon-button workbench-history-reveal"
            tooltip={t("workbench.historyReveal")}
            ariaLabel={t("workbench.historyReveal")}
            onClick={onReveal}
          >
            <IconFolderOpen size={14} aria-hidden />
          </TooltipButton>
          {libraryCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="workbench-history-clear"
              onClick={onClear}
            >
              {t("workbench.historyClear")}
            </Button>
          ) : null}
        </span>
      </div>
      {scopedHistory.length === 0 ? (
        <p className="workbench-hint">{t("workbench.historyEmpty")}</p>
      ) : (
        <>
          {succeededHistory.length > 0 ? (
            <>
              <p className="workbench-history-group">
                {`${t("workbench.historySucceeded")} · ${succeededHistory.length}`}
              </p>
              <ul className="workbench-history-list">
                {succeededHistory.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} onPick={onPick} onRemove={onRemove} />
                ))}
              </ul>
            </>
          ) : null}
          {failedHistory.length > 0 ? (
            <>
              <p className="workbench-history-group">
                {`${t("workbench.historyFailed")} · ${failedHistory.length}`}
              </p>
              <ul className="workbench-history-list">
                {failedHistory.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} onPick={onPick} onRemove={onRemove} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      {/* Why a long-ago render may be missing from the list: the index is capped,
          the files are not. Saying so turns a silent disappearance into a rule. */}
      <p className="workbench-history-note">
        {t("workbench.libraryCapNote", { max: MAX_LIBRARY_ENTRIES })}
      </p>
    </div>
  );
}
