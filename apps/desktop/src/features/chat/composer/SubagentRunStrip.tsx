import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/app-store";
import { useElapsedLabel } from "../../../hooks/use-elapsed-label";
import { runningDelegations } from "../../../lib/subagent-running";

/**
 * What is still running, above the composer.
 *
 * A delegate can work for minutes while its card is scrolled out of the
 * viewport, so the count and the longest elapsed time stay where the eye already
 * is. Clicking it brings the newest running card back into view; the strip itself
 * is a button rather than a badge so that affordance is reachable by keyboard.
 */
export const SubagentRunStrip = memo(function SubagentRunStrip() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const runs = runningDelegations(messages);
  const oldest = runs[0];
  // The longest run is the one worth timing: it is the one that can look stuck.
  const elapsed = useElapsedLabel(oldest?.startedAt, undefined, runs.length > 0);

  const reveal = useCallback((toolCallId: string) => {
    const row = document.querySelector(
      `[data-delegation-call="${CSS.escape(toolCallId)}"]`,
    );
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  if (runs.length === 0 || !oldest) return null;
  const label = t("chat.subagentRunning", { count: runs.length });

  return (
    <button
      type="button"
      className="subagent-strip"
      title={t("chat.subagentReveal")}
      onClick={() => reveal(runs[runs.length - 1].toolCallId)}
    >
      <span className="tool-spinner" aria-hidden />
      <span className="subagent-strip-label">{label}</span>
      {elapsed ? (
        <span className="subagent-strip-time" aria-label={t("chat.subagentDuration", { duration: elapsed })}>
          {elapsed}
        </span>
      ) : null}
    </button>
  );
});
