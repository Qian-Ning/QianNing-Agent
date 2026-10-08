/**
 * The workbench's history list.
 *
 * Runs are grouped by outcome — a run that failed is a different thing from a
 * run that worked — and each row names when, which model, what size and, when
 * it failed, why. Picking a row reveals that run in the results panel.
 */
import { useTranslation } from "react-i18next";
import type { Run } from "./useWorkbenchRuns";

/**
 * One past run. Kept beside the type it renders so the two history groups can
 * share a row without repeating the markup twice.
 */
function HistoryRow({
  entry,
  onPick,
}: {
  entry: Run;
  onPick: (entry: Run) => void;
}) {
  const { t } = useTranslation();
  const succeeded = entry.results?.filter((item) => item.status === "succeeded").length ?? 0;
  return (
    <li>
      <button type="button" onClick={() => onPick(entry)}>
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
            entry.errorCode ?? `${succeeded}/${entry.total}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
    </li>
  );
}

export function WorkbenchHistory({
  scopedHistory,
  succeededHistory,
  failedHistory,
  onPick,
}: {
  scopedHistory: Run[];
  succeededHistory: Run[];
  failedHistory: Run[];
  onPick: (entry: Run) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workbench-history">
      <h2>{t("workbench.history")}</h2>
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
                  <HistoryRow key={entry.id} entry={entry} onPick={onPick} />
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
                  <HistoryRow key={entry.id} entry={entry} onPick={onPick} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
