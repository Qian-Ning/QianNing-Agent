/**
 * The workbench's run lifecycle and its merge with the media library.
 *
 * A run is created here, streams its progress, and settles into history. The
 * library read on mount turns what the app rendered before this window opened
 * into the same shape, so a restart does not erase assets the user paid for.
 * Holding that lifecycle in one hook keeps the page a layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ImageGenerationInput,
  type MediaLibraryEntry,
  type MediaWorkbenchItemResult,
  type MediaWorkbenchProgress,
  type VideoGenerationInput,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { WorkbenchModelChoice } from "./WorkbenchModelPicker";
import type { ItemState, WorkbenchOutput } from "./WorkbenchResults";

export type Capability = "image" | "video";

export type Run = {
  id: string;
  capability: Capability;
  /** What the request was sent with; save and reveal are scoped to it. */
  sessionId: string;
  prompt: string;
  model: WorkbenchModelChoice | null;
  startedAt: number;
  finishedAt?: number;
  results: MediaWorkbenchItemResult[] | null;
  states: Record<number, ItemState>;
  total: number;
  /** The size this run asked for, when it asked for one. */
  size?: string;
  ok: boolean | null;
  errorCode?: string;
  message?: string;
};

/**
 * A render the app already owns, in the shape the page renders runs in.
 *
 * Only the file and what is known about it survive a restart; the per-item states
 * are reconstructed from the recorded outcome, so a library entry opens in the
 * results panel exactly like a run that just finished.
 */
export function runFromEntry(entry: MediaLibraryEntry): Run {
  const at = Date.parse(entry.createdAt);
  const startedAt = Number.isNaN(at) ? 0 : at;
  return {
    id: entry.id,
    capability: entry.capability,
    sessionId: "",
    prompt: entry.prompt ?? "",
    // The provider is recorded with the entry now, so a row restored after a
    // restart names the same binding the run did. An entry an earlier build
    // wrote carries none, which stays unknown instead of becoming a wrong name.
    model: entry.modelId
      ? { providerId: entry.providerId ?? "", modelId: entry.modelId }
      : null,
    startedAt,
    finishedAt: startedAt,
    results: [
      {
        index: 0,
        status: entry.status,
        ...(entry.status === "succeeded" ? { path: entry.path } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      },
    ],
    states: { 0: entry.status },
    total: 1,
    ...(entry.size ? { size: entry.size } : {}),
    ok: entry.status === "succeeded",
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
  };
}

export type WorkbenchRunInput = {
  capability: Capability;
  isImage: boolean;
  /** The session every request and its files belong to. */
  sessionId: string;
  prompt: string;
  count: number;
  /** The composed size, when one was chosen. */
  size: string;
  sizeOk: boolean;
  lastFrameOk: boolean;
  choice: WorkbenchModelChoice | null;
  duration: number;
  firstFrame: string;
  lastFrame: string;
  frameFieldFirst: string;
  frameFieldLast: string;
  imageReferences: string[];
};

export function useWorkbenchRuns({
  capability,
  isImage,
  sessionId,
  prompt,
  count,
  size,
  sizeOk,
  lastFrameOk,
  choice,
  duration,
  firstFrame,
  lastFrame,
  frameFieldFirst,
  frameFieldLast,
  imageReferences,
}: WorkbenchRunInput) {
  const [progress, setProgress] = useState<MediaWorkbenchProgress | null>(null);
  // Results belong to the capability that produced them: one panel shared
  // between the tabs showed an image run while the video tab was open.
  const [runs, setRuns] = useState<Record<Capability, Run | null>>({ image: null, video: null });
  const run = runs[capability];
  const setRun = (value: Run | null | ((current: Run | null) => Run | null)) =>
    setRuns((current) => ({
      ...current,
      [capability]: typeof value === "function" ? value(current[capability]) : value,
    }));
  const [history, setHistory] = useState<Run[]>([]);
  // What the app rendered before this window opened. Read once, on mount, so a
  // restart does not erase assets the user paid for.
  const [library, setLibrary] = useState<Run[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const generationRef = useRef("");

  const running = run !== null && run.finishedAt === undefined;

  useEffect(() => {
    setRun(null);
    setProgress(null);
  }, [capability]);

  useEffect(() => {
    let cancelled = false;
    void api
      .workbenchLibrary()
      .then((result) => {
        if (!cancelled) setLibrary(result.entries.map(runFromEntry));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Re-read the app's library. The main process owns the index, so the list the
  // user manages must be its list, with its ids — never a second, locally minted
  // copy whose ids the removal and clear channels would not recognise.
  const reloadLibrary = useCallback(async () => {
    const result = await api.workbenchLibrary();
    setLibrary(result.entries.map(runFromEntry));
  }, []);

  // Removing and clearing answer with the surviving entries, so the list is
  // replaced by what the main process returns rather than edited by guesswork.
  const removeLibraryEntries = useCallback(async (ids: string[]) => {
    const result = await api.workbenchLibraryRemove({ ids });
    setLibrary(result.entries.map(runFromEntry));
    // A run that only ever lived in this window (its channel call failed before
    // the library saw it) still leaves the list when its row is removed.
    setHistory((current) => current.filter((entry) => !ids.includes(entry.id)));
  }, []);

  const clearLibraryHistory = useCallback(async () => {
    const result = await api.workbenchLibraryClear();
    setLibrary(result.entries.map(runFromEntry));
    setHistory([]);
  }, []);

  /** Open the library directory itself, where every kept render lives. */
  const revealLibrary = useCallback(async () => {
    await api.workbenchLibraryReveal();
  }, []);

  // The main process reports progress under the id it assigned, which the renderer
  // only learns from the first event; adopting it here keeps later events matching.
  useEffect(
    () =>
      api.onWorkbenchProgress((event) => {
        if (event.sessionId !== sessionId) return;
        if (!event.generationId) return;
        if (generationRef.current && event.generationId !== generationRef.current) return;
        generationRef.current = event.generationId;
        setProgress(event);
        if (!event.item) return;
        const item = event.item;
        setRun((current) =>
          current ? { ...current, states: { ...current.states, [item.index]: item.status } } : current,
        );
      }),
    [sessionId],
  );

  const submit = useCallback(async () => {
    if (!prompt.trim() || running || !sizeOk || !lastFrameOk) return;
    const frameFields =
      !isImage && (frameFieldFirst.trim() || frameFieldLast.trim())
        ? {
            ...(frameFieldFirst.trim() ? { first: frameFieldFirst.trim() } : {}),
            ...(frameFieldLast.trim() ? { last: frameFieldLast.trim() } : {}),
          }
        : undefined;
    const input: ImageGenerationInput | VideoGenerationInput = isImage
      ? {
          items: [
            {
              prompt: prompt.trim(),
              count,
              ...(size.trim() ? { size: size.trim() } : {}),
              ...(imageReferences.length ? { images: imageReferences } : {}),
            },
          ],
        }
      : {
          items: [
            {
              prompt: prompt.trim(),
              count,
              durationSeconds: duration,
              ...(size.trim() ? { size: size.trim() } : {}),
              ...(firstFrame ? { image: firstFrame } : {}),
              ...(lastFrame && firstFrame ? { lastFrame } : {}),
            },
          ],
        };
    const startedAt = Date.now();
    const model = choice ?? null;
    generationRef.current = "";
    setNow(startedAt);
    setProgress(null);
    setRun({
      id: "",
      capability,
      sessionId,
      prompt: prompt.trim(),
      model,
      startedAt,
      results: null,
      states: {},
      total: count,
      ok: null,
    });
    try {
      const result = await api.workbenchGenerate({
        capability,
        sessionId,
        ...(model ? { model } : {}),
        ...(frameFields ? { frames: frameFields } : {}),
        input,
      });
      const finished: Run = {
        id: result.generationId,
        capability,
        sessionId,
        prompt: prompt.trim(),
        model:
          model ??
          (result.providerId && result.modelId
            ? { providerId: result.providerId, modelId: result.modelId }
            : null),
        startedAt,
        finishedAt: Date.now(),
        ...(size ? { size } : {}),
        results: result.results,
        states: result.results.reduce<Record<number, ItemState>>((accumulator, item) => {
          accumulator[item.index] = item.status;
          return accumulator;
        }, {}),
        total: Math.max(count, result.results.length),
        ok: result.ok,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
      setRun(finished);
      // The run is already in the app's library — the service records it before
      // it answers — so re-read that list instead of pushing a second copy with
      // a different id. Falling back to a window-only row keeps the run visible
      // if the read fails.
      try {
        await reloadLibrary();
      } catch {
        setHistory((current) => [finished, ...current].slice(0, 24));
      }
    } catch (error) {
      setRun((current) =>
        current
          ? {
              ...current,
              finishedAt: Date.now(),
              results: [],
              ok: false,
              errorCode: "MEDIA_FAILED",
              message: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    } finally {
      generationRef.current = "";
    }
  }, [
    sessionId,
    capability,
    choice,
    count,
    duration,
    firstFrame,
    frameFieldFirst,
    frameFieldLast,
    imageReferences,
    isImage,
    lastFrame,
    lastFrameOk,
    prompt,
    running,
    size,
    sizeOk,
    reloadLibrary,
  ]);

  const cancel = async () => {
    if (generationRef.current) await api.workbenchCancel(generationRef.current);
  };

  const outputs = useMemo<WorkbenchOutput[]>(() => {
    if (!run) return [];
    const total = Math.max(run.total, run.results?.length ?? 0);
    return Array.from({ length: total }, (_unused, index) => {
      const result = run.results?.find((item) => item.index === index);
      const state: ItemState =
        result?.status ?? run.states[index] ?? (run.finishedAt ? "failed" : "pending");
      return { index, state, ...(result ? { result } : {}) };
    });
  }, [run]);

  const elapsed = run ? (run.finishedAt ?? now) - run.startedAt : 0;
  const succeeded = run?.results?.filter((item) => item.status === "succeeded").length ?? 0;
  const failed = run?.results?.filter((item) => item.status !== "succeeded").length ?? 0;
  const savedPaths = outputs
    .map((output) => output.result?.path)
    .filter((path): path is string => Boolean(path));

  // History belongs to the capability that produced it, and a run that failed is
  // a different thing from a run that worked, so the two never share a list.
  const scopedHistory = [...library, ...history].filter(
    (entry) => entry.capability === capability,
  );
  const succeededHistory = scopedHistory.filter((entry) => entry.ok !== false);
  const failedHistory = scopedHistory.filter((entry) => entry.ok === false);

  return {
    run,
    setRun,
    progress,
    running,
    elapsed,
    succeeded,
    failed,
    outputs,
    savedPaths,
    scopedHistory,
    succeededHistory,
    failedHistory,
    /** Total entries the library holds, across both capabilities. */
    libraryCount: library.length,
    removeLibraryEntries,
    clearLibraryHistory,
    revealLibrary,
    submit,
    cancel,
  };
}
