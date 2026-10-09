/**
 * Video generation bindings and request shapes.
 *
 * Video is the task-shaped sibling of image generation: an OpenAI-compatible
 * provider accepts a create request, answers with a job id, and the finished
 * clip is fetched after polling. Only that contract is supported, so a gateway
 * that speaks it works without a second adapter; the shapes here stay free of
 * provider-specific fields.
 *
 * A binding is owned by the host settings store and independent of the default
 * conversation model, exactly like `ImageGenerationBinding`. The legacy single
 * binding stays supported: when the candidate list is absent it is treated as
 * the only candidate.
 */

export type VideoGenerationBinding = { providerId: string; modelId: string };
export type VideoGenerationBindings =
  | VideoGenerationBinding
  | readonly VideoGenerationBinding[];

export const MAX_VIDEO_GENERATION_MODELS = 64;

/** A batch is deliberately small: every clip is minutes long and billable. */
export const MAX_GENERATED_VIDEOS = 8;

/** Seconds; the longest clip one item may ask for. */
export const MAX_VIDEO_DURATION_SECONDS = 15;

/** Widest accepted `size`; the provider still decides what it will render. */
export const VIDEO_SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/;

/** One create request plus its whole polling loop. */
export const VIDEO_GENERATION_TIMEOUT_MS = 600_000;

/** Gap between job-status reads while a clip renders. */
export const VIDEO_POLL_INTERVAL_MS = 5_000;

/** Whole-batch ceiling: every clip at its full budget, with transport slack. */
export const VIDEO_BATCH_TIMEOUT_MS = 2_400_000;

/**
 * Multipart field names for the frames a clip is anchored to.
 *
 * The single-image OpenAI video contract has one name (`input_reference`); the
 * first-plus-last-frame style gateways each spell the pair differently, so the
 * names travel with the request instead of being frozen here. Both are only
 * sent when the caller actually supplied that frame.
 */
export const DEFAULT_VIDEO_FRAME_FIELDS = {
  first: "input_reference",
  last: "last_frame",
} as const;
/** A form field name, not a payload: letters, digits and `_ - . [ ]`. */
export const VIDEO_FRAME_FIELD_PATTERN = /^[A-Za-z0-9_.\[\]-]{1,64}$/;

export type VideoFrameFields = { first?: string; last?: string };

export type VideoGenerationItem = {
  prompt: string;
  count?: number;
  /** One local image used as the first frame. */
  image?: string;
  /** One local image used as the last frame; needs `image` too. */
  lastFrame?: string;
  durationSeconds?: number;
  size?: string;
};

export type VideoGenerationInput = { items: VideoGenerationItem[] };

export type GeneratedVideoResult = {
  index: number;
  status: "succeeded" | "failed" | "cancelled";
  path?: string;
  /**
   * A URL the renderer may play the finished clip from, set by the main process
   * only when `path` names a file inside the media library (ADR 0322). It is the
   * library-relative `video/…` path, never an absolute one, and is absent for a
   * failed or cancelled item, which produced no file.
   */
  url?: string;
  mimeType?: string;
  durationSeconds?: number;
  errorCode?: string;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

export function parseVideoGenerationBinding(value: unknown): VideoGenerationBinding | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    invalid("videoGeneration must be an object");
  const record = value as Record<string, unknown>;
  const field = (name: string, max: number) => {
    const raw = record[name];
    if (typeof raw !== "string" || !raw.trim() || raw.length > max)
      invalid(`videoGeneration.${name} is invalid`);
    return raw.trim();
  };
  return { providerId: field("providerId", 128), modelId: field("modelId", 256) };
}

export function parseVideoGenerationBindings(
  value: unknown,
): VideoGenerationBinding[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) invalid("videoGenerationModels must be an array");
  if (value.length > MAX_VIDEO_GENERATION_MODELS) {
    invalid(
      `videoGenerationModels must contain at most ${MAX_VIDEO_GENERATION_MODELS} models`,
    );
  }
  return value.map((entry) => {
    const binding = parseVideoGenerationBinding(entry);
    if (!binding) invalid("videoGenerationModels contains an invalid binding");
    return binding;
  });
}

/** Complete wire ids are identity; catalog alias matching is not. */
function sameVideoGenerationBinding(
  left: VideoGenerationBinding,
  right: VideoGenerationBinding,
): boolean {
  const requested = right.modelId.trim().toLowerCase();
  return (
    left.providerId === right.providerId &&
    requested.length > 0 &&
    left.modelId.trim().toLowerCase() === requested
  );
}

/** Resolve candidates with the legacy single-binding fallback, keeping order. */
export function videoGenerationBindings(
  candidates: readonly VideoGenerationBinding[] | null | undefined,
  active: VideoGenerationBinding | null | undefined,
): VideoGenerationBinding[] {
  const source = candidates === undefined ? (active ? [active] : []) : candidates ?? [];
  const result: VideoGenerationBinding[] = [];
  for (const candidate of source) {
    if (!result.some((entry) => sameVideoGenerationBinding(entry, candidate))) {
      result.push(candidate);
    }
  }
  if (active && !result.some((entry) => sameVideoGenerationBinding(entry, active))) {
    result.push(active);
  }
  return result;
}

export function isVideoGenerationModel(
  binding: VideoGenerationBindings | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): boolean {
  const bindings = Array.isArray(binding) ? binding : binding ? [binding] : [];
  return (
    !!providerId &&
    !!modelId &&
    bindings.some((entry) => sameVideoGenerationBinding(entry, { providerId, modelId }))
  );
}

/** Expand variants into individually accountable jobs; never silently truncate. */
export function videoGenerationItems(value: unknown): VideoGenerationItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("items are required");
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_GENERATED_VIDEOS)
    invalid(`items must contain 1–${MAX_GENERATED_VIDEOS} entries`);
  const jobs: VideoGenerationItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("invalid video item");
    const { prompt, count = 1, image, lastFrame, durationSeconds, size } =
      item as Record<string, unknown>;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32_000)
      invalid("prompt must contain 1–32000 characters");
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_GENERATED_VIDEOS
    )
      invalid(`count must be an integer from 1 to ${MAX_GENERATED_VIDEOS}`);
    if (
      image != null &&
      (typeof image !== "string" || !image.trim() || image.length > 4096)
    )
      invalid("image must be one local image path");
    if (
      lastFrame != null &&
      (typeof lastFrame !== "string" || !lastFrame.trim() || lastFrame.length > 4096)
    )
      invalid("lastFrame must be one local image path");
    if (lastFrame != null && (typeof image !== "string" || !image.trim()))
      invalid("lastFrame requires image as the first frame");
    if (
      durationSeconds != null &&
      (typeof durationSeconds !== "number" ||
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 1 ||
        durationSeconds > MAX_VIDEO_DURATION_SECONDS)
    )
      invalid(`durationSeconds must be an integer from 1 to ${MAX_VIDEO_DURATION_SECONDS}`);
    if (size != null && (typeof size !== "string" || !VIDEO_SIZE_PATTERN.test(size)))
      invalid("size must look like 1280x720");
    for (let i = 0; i < count; i++)
      jobs.push({
        prompt: prompt.trim(),
        ...(typeof image === "string" && image.trim() ? { image: image.trim() } : {}),
        ...(typeof lastFrame === "string" && lastFrame.trim()
          ? { lastFrame: lastFrame.trim() }
          : {}),
        ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
        ...(typeof size === "string" ? { size } : {}),
      });
    if (jobs.length > MAX_GENERATED_VIDEOS)
      invalid(`at most ${MAX_GENERATED_VIDEOS} videos may be generated per batch`);
  }
  return jobs;
}

export function videoGenerationPrompts(value: unknown): string[] {
  return videoGenerationItems(value).map((item) => item.prompt);
}
