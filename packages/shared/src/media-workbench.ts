/**
 * The media workbench: generating images and videos from inside the app.
 *
 * The Agent tools (`GenerateImages`, `GenerateVideos`) stay what they are — a
 * model asking to generate. The workbench is the user asking. It reuses the
 * same service functions, so configuration, credential handling, containment,
 * download rules and per-item failure reporting are identical; only the caller
 * differs, and with it the approval step, which belongs to agent-initiated
 * calls rather than to a button the user pressed.
 *
 * A request names one capability. A workbench run owns its output: the render
 * lands in the app's media library, so generating needs no chat session to
 * exist. The reference images the caller may pass are resolved against the
 * library, the session's project and scratch, and the attachment store exactly
 * as the tools resolve them.
 */
import type { GeneratedImageResult, ImageGenerationInput } from "./image-generation.js";
import type {
  GeneratedVideoResult,
  VideoFrameFields,
  VideoGenerationInput,
} from "./video-generation.js";

export const MEDIA_WORKBENCH_CAPABILITIES = ["image", "video"] as const;
export type MediaWorkbenchCapability = (typeof MEDIA_WORKBENCH_CAPABILITIES)[number];

/** The model the workbench will run, chosen from the user's own providers. */
export type MediaWorkbenchModelChoice = { providerId: string; modelId: string };

export type MediaWorkbenchRequest = {
  capability: MediaWorkbenchCapability;
  sessionId: string;
  /**
   * The model picked in the workbench. Absent means the configured default
   * binding, exactly as the Agent tools resolve it; when present it is still
   * validated against that provider's own model list.
   */
  model?: MediaWorkbenchModelChoice;
  /** Multipart names for a clip's frames; the OpenAI-compatible defaults apply when absent. */
  frames?: VideoFrameFields;
  /** Image prompts count up to `MAX_GENERATED_IMAGES` outputs, video up to `MAX_GENERATED_VIDEOS`. */
  input: ImageGenerationInput | VideoGenerationInput;
};

/** One finished output, or the reason that one did not finish. */
export type MediaWorkbenchItemResult = GeneratedImageResult | GeneratedVideoResult;

export type MediaLibraryCapability = "image" | "video";

/**
 * How many remembered renders the index keeps; the oldest fall off the end. The
 * files themselves are never removed by the cap. Shared so the main process and
 * the renderer bound the history with the same number.
 */
export const MAX_LIBRARY_ENTRIES = 500;

/**
 * One render the app remembers. The file itself lives under the data
 * directory's library root; this is the record of what it is, so the workbench
 * can list its history after a restart without scanning directories.
 */
export type MediaLibraryEntry = {
  id: string;
  capability: MediaLibraryCapability;
  /**
   * Absolute path of the render, always inside the library root. Present only
   * for a `succeeded` run: a failed or cancelled run produced no file, so there
   * is nothing to point at.
   */
  path?: string;
  /**
   * A URL the renderer may load the file from, e.g.
   * `media-asset://library/video/<name>` (ADR 0322). Set by the main process
   * only for an entry whose `path` names a file inside the library root; it
   * carries the library-relative path, never an absolute one, so a failed or
   * cancelled entry (which has no `path`) carries no URL either.
   */
  url?: string;
  /**
   * The URL of the derived small copy a history row leads with, written beside
   * the render when it lands (`<capability>/thumbs/…`, served by the same scheme
   * and the same containment as `url`). Set only when that copy exists, so a row
   * that has one loads it instead of the full-size file; an entry recorded before
   * thumbnails existed carries none and the row falls back to `url`. Images only
   * for now: a clip's poster frame is a separate item.
   */
  thumbUrl?: string;
  status: "succeeded" | "failed" | "cancelled";
  prompt?: string;
  /**
   * The provider that actually ran the request, recorded beside the model
   * because a model id alone is ambiguous — several providers serve the same
   * id. A history row restored after a restart therefore names the same binding
   * the run did. Absent on an entry an earlier build wrote, and on a run that
   * failed before a provider was resolved: both read as unknown, never as some
   * other provider's name.
   */
  providerId?: string;
  modelId?: string;
  size?: string;
  errorCode?: string;
  /** ISO 8601, so the renderer can show a local time without guessing. */
  createdAt: string;
};

/**
 * The library as the renderer receives it. Entries whose file is gone, or that
 * point outside the library, are already filtered out by the main process.
 */
export type MediaLibraryResult = { entries: MediaLibraryEntry[] };

/** Forget the named entries; their files are sent to the OS trash. */
export type MediaLibraryRemoveRequest = { ids: string[] };

/**
 * The library after a remove or a clear: the survivors for a remove, an empty
 * list for a clear.
 */
export type MediaLibraryClearResult = MediaLibraryResult;

export type MediaWorkbenchResult = {
  /** True when at least one item succeeded; a partial batch stays usable. */
  ok: boolean;
  capability: MediaWorkbenchCapability;
  /** The binding that actually ran, so the workbench can show what produced the file. */
  providerId?: string;
  modelId?: string;
  results: MediaWorkbenchItemResult[];
  errorCode?: string;
  message?: string;
};

/**
 * Progress for a request that is still running.
 *
 * A video render takes minutes, so the workbench cannot present a spinner and
 * nothing else: the phases name what is happening, and `completed`/`total`
 * carry how much of the batch is accounted for.
 */
export type MediaWorkbenchProgress = {
  generationId: string;
  capability: MediaWorkbenchCapability;
  phase: "submitting" | "running" | "done";
  /** Items that already reached a terminal state. */
  completed: number;
  total: number;
  /** The item this event is about, when it is about a single one. */
  item?: {
    index: number;
    status: "running" | "succeeded" | "failed" | "cancelled";
  };
};

export type MediaWorkbenchProgressEvent = MediaWorkbenchProgress & { sessionId: string };
