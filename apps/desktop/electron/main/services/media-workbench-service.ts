import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  MediaWorkbenchItemResult,
  MediaWorkbenchProgressEvent,
  MediaWorkbenchRequest,
  MediaWorkbenchResult,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import { createImageGenerationTool } from "./image-generation-service";
import { appendMediaLibrary, libraryEntryFrom, type MediaLibraryEntry } from "./media-library";
import { createVideoGenerationTool } from "./video-generation-service";

type HostCall = Pick<HostProcess, "call">;

/** What a generation tool returns: finished content, or the one thing that failed. */
type ToolOutcome = { ok?: boolean; content?: unknown };

/** One item reaching a state, as the runtime reports it while the batch runs. */
type ToolItemEvent = {
  index: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  total: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Prompts expanded by their `count`, which is how many outputs the batch owes. */
function outputCount(input: unknown): number {
  const items = asRecord(input)?.items;
  if (!Array.isArray(items)) return 1;
  const total = items.reduce<number>((sum, item) => {
    const count = asRecord(item)?.count;
    return (
      sum + (typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 1)
    );
  }, 0);
  return total > 0 ? total : 1;
}

/**
 * Prompts and sizes expanded by each item's `count`, in the order the batch
 * yields its outputs, so a recorded entry can name the prompt (and size) that
 * produced — or failed to produce — a given item.
 */
function inputExpansion(input: unknown): { prompts: string[]; sizes: (string | undefined)[] } {
  const prompts: string[] = [];
  const sizes: (string | undefined)[] = [];
  const items = asRecord(input)?.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = item as { prompt?: unknown; count?: unknown; size?: unknown };
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const count =
        typeof record.count === "number" && Number.isInteger(record.count) && record.count > 0
          ? record.count
          : 1;
      const size = typeof record.size === "string" ? record.size : undefined;
      for (let copy = 0; copy < count; copy += 1) {
        prompts.push(prompt);
        sizes.push(size);
      }
    }
  }
  return { prompts, sizes };
}

export type MediaWorkbenchAction = MediaWorkbenchResult & { generationId: string };

export type MediaWorkbenchService = {
  generate(request: MediaWorkbenchRequest): Promise<MediaWorkbenchAction>;
  cancel(generationId: string): boolean;
  activeCount(): number;
};

/**
 * The user-facing generation path.
 *
 * It reuses the same tool functions the Agent calls, so configuration lookup,
 * credential handling, containment, download rules, per-item failure reporting
 * and cancellation are literally the same code — the workbench cannot drift
 * from what the tools do. Only the approval step is absent, because the user
 * pressed the button that started the request.
 *
 * Two things the tools do not do, because only a person needs them: the model
 * comes from the request rather than from host settings, and the run reports
 * every item as it starts and finishes. A clip takes minutes; a spinner that
 * never changes tells the user nothing about what they are paying for.
 *
 * A request is cancellable by id: aborting stops queued items and the in-flight
 * request, and cannot promise that the provider stopped rendering or billing.
 */
export function createMediaWorkbenchService(options: {
  dataDir: string;
  getHost: () => HostCall | null;
  emit: (event: MediaWorkbenchProgressEvent) => void;
  /** Proxy fake-IP resolution for downloads; off unless the app has it on. */
  allowFakeIp?: () => boolean;
}): MediaWorkbenchService {
  const running = new Map<string, AbortController>();

  return {
    async generate(request) {
      const generationId = randomUUID();
      const controller = new AbortController();
      const total = outputCount(request.input);
      const { prompts, sizes } = inputExpansion(request.input);
      let completed = 0;
      running.set(generationId, controller);
      const report = (phase: MediaWorkbenchProgressEvent["phase"], item?: ToolItemEvent) =>
        options.emit({
          generationId,
          sessionId: request.sessionId,
          capability: request.capability,
          phase,
          completed,
          total,
          ...(item ? { item: { index: item.index, status: item.status } } : {}),
        });
      const onItemEvent = (event: ToolItemEvent) => {
        if (event.status !== "running") completed += 1;
        report(completed >= total ? "done" : "running", event);
      };
      try {
        report("submitting");
        const tool =
          request.capability === "video"
            ? createVideoGenerationTool({
                dataDir: options.dataDir,
                getHost: options.getHost,
                outputDir: resolve(options.dataDir, "generated", "video"),
                ...(options.allowFakeIp ? { allowFakeIp: options.allowFakeIp } : {}),
                ...(request.model ? { choice: request.model } : {}),
                ...(request.frames ? { frameFields: request.frames } : {}),
                onItemEvent,
              })
            : createImageGenerationTool({
                dataDir: options.dataDir,
                getHost: options.getHost,
                outputDir: resolve(options.dataDir, "generated", "image"),
                ...(options.allowFakeIp ? { allowFakeIp: options.allowFakeIp } : {}),
                ...(request.model ? { choice: request.model } : {}),
                onItemEvent,
              });
        const outcome = (await tool({
          sessionId: request.sessionId,
          toolCallId: generationId,
          args: request.input,
          signal: controller.signal,
        })) as ToolOutcome;
        const content = asRecord(outcome.content);
        const kind = content?.kind;
        const results = Array.isArray(content?.results)
          ? (content.results as MediaWorkbenchItemResult[])
          : [];
        completed = total;
        report("done");
        if (kind !== "generated-images" && kind !== "generated-videos") {
          // A refusal from the tool: not configured, model gone, bad credentials.
          // A run that never produced a file is still remembered, as a failure
          // carrying its error code — the batch produced no item to record one
          // per item, so this is the single entry for the run.
          const errorCode = typeof content?.errorCode === "string"
            ? content.errorCode
            : "MEDIA_FAILED";
          // No provider is recorded here: a refusal happens before a binding is
          // resolved, so this entry carries the reason and no producer.
          await appendMediaLibrary(options.dataDir, [
            libraryEntryFrom({
              capability: request.capability,
              status: "failed",
              ...(prompts[0] ? { prompt: prompts[0] } : {}),
              ...(sizes[0] ? { size: sizes[0] } : {}),
              errorCode,
            }),
          ]).catch(() => undefined);
          return {
            generationId,
            ok: false,
            capability: request.capability,
            results,
            errorCode,
            message: typeof content?.message === "string"
              ? content.message
              : "The request could not be completed.",
          };
        }
        // The library remembers every item of the run once, after it finished:
        // successes carry their file path, failures and cancellations carry their
        // error code instead. One result maps to exactly one entry, so a run can
        // never be recorded as both a success and a failure.
        const libraryEntries: MediaLibraryEntry[] = [];
        for (const result of results) {
          const prompt = prompts[result.index];
          const size = sizes[result.index];
          libraryEntries.push(
            libraryEntryFrom({
              capability: request.capability,
              ...(typeof result.path === "string" ? { path: result.path } : {}),
              status: result.status,
              ...(prompt ? { prompt } : {}),
              ...(size ? { size } : {}),
              // The binding that ran is recorded with the file, so a row read
              // back after a restart names the same provider the run did.
              ...(typeof content?.providerId === "string" ? { providerId: content.providerId } : {}),
              ...(typeof content?.modelId === "string" ? { modelId: content.modelId } : {}),
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            }),
          );
        }
        // Best effort by design: an index that cannot be written must never turn a
        // finished, paid-for render into an error for the user.
        await appendMediaLibrary(options.dataDir, libraryEntries).catch(() => undefined);

        return {
          generationId,
          // A partial batch is still a usable answer: the successes carry paths.
          ok: results.some((result) => result.status === "succeeded"),
          capability: request.capability,
          ...(typeof content?.providerId === "string" ? { providerId: content.providerId } : {}),
          ...(typeof content?.modelId === "string" ? { modelId: content.modelId } : {}),
          results,
        };
      } catch (error) {
        const code = asRecord(error)?.errorCode;
        const errorCode = typeof code === "string" ? code : "MEDIA_FAILED";
        report("done");
        // A thrown run is a failed run: remember it with no file, once — and no
        // provider either, for the same reason the refusal above carries none.
        await appendMediaLibrary(options.dataDir, [
          libraryEntryFrom({
            capability: request.capability,
            status: "failed",
            ...(prompts[0] ? { prompt: prompts[0] } : {}),
            ...(sizes[0] ? { size: sizes[0] } : {}),
            errorCode,
          }),
        ]).catch(() => undefined);
        return {
          generationId,
          ok: false,
          capability: request.capability,
          results: [],
          errorCode,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        running.delete(generationId);
      }
    },
    cancel(generationId) {
      const controller = running.get(generationId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    activeCount: () => running.size,
  };
}

/**
 * A generated file this session is allowed to hand out.
 *
 * The renderer names both the session and the path, so this is the boundary that
 * decides whether a path is one the workbench wrote: it must resolve inside the
 * media library root, or inside the data directory's scratch root and that
 * session's scratch directory, and be a regular file. Anything else returns null,
 * which keeps the file channels from becoming a general file copier.
 *
 * A render the library already owns needs no session at all.
 */
export async function resolveGeneratedFile(options: {
  dataDir: string;
  /** Absent for a run without a session: a library render still resolves. */
  scratchPath?: string;
  target: string;
}): Promise<string | null> {
  const within = (base: string, candidate: string): boolean => {
    const rel = relative(base, candidate);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  };
  try {
    const file = await realpath(options.target);
    // A library asset belongs to the app rather than to a session, so it is
    // checked against the library root instead of the session directory.
    try {
      const libraryRoot = await realpath(resolve(options.dataDir, "generated"));
      if (within(libraryRoot, file)) return (await stat(file)).isFile() ? file : null;
    } catch {
      // No library directory yet: only the session path can match, and an absent
      // library must never turn a valid session file into a refusal.
    }
    // Not in the library, and no session to belong to: nothing to hand out.
    if (!options.scratchPath) return null;
    const root = await realpath(resolve(options.dataDir, "scratch"));
    const sessionDir = await realpath(options.scratchPath);
    if (!within(root, sessionDir)) return null;
    if (!within(sessionDir, file)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}
