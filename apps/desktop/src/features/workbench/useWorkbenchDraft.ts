/**
 * Persist the media workbench's compose draft.
 *
 * The page reads its draft once on open (`loadWorkbenchDrafts`) and hands every
 * later change to the scheduler this hook returns; the write itself is debounced
 * so typing a prompt does not touch `localStorage` on every keystroke, and the
 * pending write is flushed when the page unmounts so the last edit is not lost
 * on navigation.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  type DebouncedWriter,
  type WorkbenchDrafts,
  WORKBENCH_DRAFT_DEBOUNCE_MS,
  createDebouncedWriter,
  saveWorkbenchDrafts,
} from "../../lib/workbench-draft";

export function useWorkbenchDraftPersistence(): (drafts: WorkbenchDrafts) => void {
  const writer = useRef<DebouncedWriter<WorkbenchDrafts> | null>(null);
  if (writer.current === null) {
    writer.current = createDebouncedWriter(saveWorkbenchDrafts, WORKBENCH_DRAFT_DEBOUNCE_MS);
  }
  useEffect(() => {
    const current = writer.current;
    return () => current?.flush();
  }, []);
  return useCallback((drafts: WorkbenchDrafts) => {
    writer.current?.schedule(drafts);
  }, []);
}
