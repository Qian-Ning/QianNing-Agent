import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateVideoBatch } from "@pi-desktop/agent-runtime";
import {
  videoGenerationPrompts,
  type VideoFrameFields,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler } from "../agent-sidecar";
import { imageInputLoader } from "./image-inputs";
import { resolveGenerationEndpoint, type GenerationModelChoice } from "./generation-endpoint";

function failure(errorCode: string, content: string) {
  return {
    ok: false,
    isError: true,
    errorCode,
    content: { kind: "video-generation-error", errorCode, message: content },
  };
}

/**
 * `GenerateVideos` for Electron main.
 *
 * Same shape as the image service: the binding is read from host settings, the
 * provider row decides the endpoint and credential, and every output file lands
 * inside the session scratch directory under a fresh name. The difference is
 * time — a clip is minutes, so the batch is small and each job carries its own
 * submit-plus-poll budget.
 */
export function createVideoGenerationTool(options: {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** A run that belongs to the media library instead of a chat session. */
  outputDir?: string;
  fetchImpl?: typeof fetch;
  allowFakeIp?: () => boolean;
  /** The workbench names the model; the Agent tools take the configured binding. */
  choice?: GenerationModelChoice;
  /** Multipart names for a clip's frames; OpenAI-compatible defaults when absent. */
  frameFields?: VideoFrameFields;
  /** One callback per clip, so a minutes-long batch can be reported while it runs. */
  onItemEvent?: (event: {
    index: number;
    status: "running" | "succeeded" | "failed" | "cancelled";
    total: number;
  }) => void;
}): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    videoGenerationPrompts(args);
    const host = options.getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const endpoint = await resolveGenerationEndpoint({
      host,
      kind: "video",
      ...(options.choice ? { choice: options.choice } : {}),
    });
    if ("errorCode" in endpoint) return failure(endpoint.errorCode, endpoint.message);
    const { providerId, modelId, baseUrl, headers, apiKey } = endpoint;
    // A workbench run writes into the app's own media library and needs no chat
    // session; the Agent tools keep writing into the session scratch. The session
    // scratch stays an input root whenever the run does have a session, so a
    // library run can still use a reference the user made in a chat.
    const library = options.outputDir ? resolve(options.dataDir, "generated") : null;
    const root = library ?? resolve(options.dataDir, "scratch");
    const scratchCall = host.call<{ path: string }>("session.getScratchPath", { sessionId });
    const sessionScratch = library
      ? await scratchCall
          .then((result) => (typeof result?.path === "string" ? result.path : null))
          .catch(() => null)
      : (await scratchCall).path;
    const path = options.outputDir ?? sessionScratch;
    const within = (base: string, target: string) => {
      const rel = relative(base, target);
      return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
    };
    if (typeof path !== "string" || !within(root, resolve(path)))
      return failure("INVALID_ARGUMENT", "Invalid video output directory.");
    await mkdir(path, { recursive: true });
    const realRoot = await realpath(root);
    const realDir = await realpath(path);
    if (!within(realRoot, realDir))
      return failure("INVALID_ARGUMENT", "Invalid video output directory.");
    signal.throwIfAborted();
    // Only a library run gets the library as an input root; a session run keeps
    // exactly the roots it had, so the Agent tools cannot read more than before.
    const inputRoots: string[] = [];
    if (library) {
      inputRoots.push(realRoot);
      if (sessionScratch) {
        try {
          inputRoots.push(await realpath(sessionScratch));
        } catch {
          // A session directory that no longer exists is simply not a root.
        }
      }
    }
    const session = options.outputDir
      ? undefined
      : (await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId }))
          .session;
    // Only the session-backed path can lose its session; a library run never had one.
    if (!options.outputDir && !session)
      return failure("SESSION_NOT_FOUND", "The video session no longer exists.");
    // A first frame is an ordinary image reference: the same loader, the same
    // containment roots (project, scratch, attachment store), so a clip cannot
    // read a file the image tool could not.
    const loadImage = imageInputLoader({
      dataDir: options.dataDir,
      scratchPath: realDir,
      extraRoots: inputRoots,
      projectPath: session?.projectPath,
    });
    // One stable code for "the named frame is not a readable image inside the
    // session roots"; the loader's message is not echoed.
    const loadFrameFile = async (path: string) => {
      try {
        const [frame] = await loadImage([path]);
        return frame;
      } catch {
        throw Object.assign(new Error("VIDEO_FRAME_UNAVAILABLE"), {
          errorCode: "VIDEO_FRAME_UNAVAILABLE",
        });
      }
    };
    const results = await generateVideoBatch({
      input: args,
      endpoint: {
        baseUrl,
        modelId,
        ...(apiKey ? { apiKey } : {}),
        headers,
      },
      signal,
      fetchImpl: options.fetchImpl,
      downloadOptions: { allowFakeIp: options.allowFakeIp?.() === true },
      loadFrame: async (item) => (item.image ? loadFrameFile(item.image) : undefined),
      loadLastFrame: async (item) =>
        item.lastFrame ? loadFrameFile(item.lastFrame) : undefined,
      frameFields: options.frameFields,
      onItemEvent: options.onItemEvent,
      save: async (video) => {
        const target = join(realDir, `generated-${randomUUID()}.${video.extension}`);
        await writeFile(target, video.bytes, { flag: "wx" });
        return target;
      },
    });
    const ok = results.some((result) => result.status === "succeeded");
    return {
      ok,
      isError: !ok,
      content: {
        kind: "generated-videos",
        providerId,
        modelId,
        results,
      },
    };
  };
}
