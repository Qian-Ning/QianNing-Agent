import {
  DEFAULT_VIDEO_FRAME_FIELDS,
  VIDEO_FRAME_FIELD_PATTERN,
  VIDEO_GENERATION_TIMEOUT_MS,
  VIDEO_POLL_INTERVAL_MS,
  videoGenerationItems,
  type GeneratedVideoResult,
  type VideoFrameFields,
  type VideoGenerationItem,
} from "@pi-desktop/shared";
import {
  downloadGeneratedVideo,
  generatedVideoType,
  videoError,
  type VideoDownloadOptions,
} from "./download.js";
export { generatedVideoType, MAX_VIDEO_BYTES } from "./download.js";

export type VideoEndpoint = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/** One local image used as a clip's first or last frame. */
export type VideoFirstFrame = { bytes: Uint8Array; mimeType: string; extension: string };

/**
 * Resolve the multipart names for the supplied frames.
 *
 * A name is only kept when it is a plain form field name; anything else falls
 * back to the default for that frame, so a hostile or fat-fingered value can
 * never rename the request's own body.
 */
export function resolveFrameFields(fields?: VideoFrameFields): { first: string; last: string } {
  const pick = (value: string | undefined, fallback: string) =>
    typeof value === "string" && VIDEO_FRAME_FIELD_PATTERN.test(value) ? value : fallback;
  return {
    first: pick(fields?.first, DEFAULT_VIDEO_FRAME_FIELDS.first),
    last: pick(fields?.last, DEFAULT_VIDEO_FRAME_FIELDS.last),
  };
}

/** Status payloads stay small; a bigger body is not a job record. */
const VIDEO_JSON_MAX_BYTES = 262_144;

/**
 * Job states differ in spelling between gateways: an OpenAI-compatible video
 * endpoint answers `queued` / `in_progress` / `completed` / `failed`, and the
 * gateways in front of it occasionally rename them. Every terminal spelling is
 * accepted, and an unrecognized or absent status stays pending until the budget
 * ends rather than being reported as a failure the provider never sent.
 */
const SUCCESS_STATUSES = new Set(["completed", "succeeded", "success", "done", "complete", "ready"]);
const FAILURE_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "expired",
  "rejected",
]);

/** Root base URL acquires `/v1`; an explicit path prefix is retained. */
export function videoGenerationUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw videoError("VIDEO_INVALID_ENDPOINT");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/videos`;
  return url.href;
}

export function videoJobUrl(baseUrl: string, id: string): string {
  return `${videoGenerationUrl(baseUrl)}/${encodeURIComponent(id)}`;
}

function authCode(status: number): string | null {
  return status === 401 || status === 403 ? "VIDEO_AUTH_FAILED" : null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get("content-length")) > VIDEO_JSON_MAX_BYTES) {
    await response.body?.cancel();
    throw videoError("VIDEO_INVALID_RESPONSE");
  }
  const raw = await response.text();
  if (raw.length > VIDEO_JSON_MAX_BYTES) throw videoError("VIDEO_INVALID_RESPONSE");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw videoError("VIDEO_INVALID_RESPONSE");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw videoError("VIDEO_INVALID_RESPONSE");
  return payload as Record<string, unknown>;
}

/** A result URL, either at the top level or inside the `data` array. */
function videoUrl(payload: Record<string, unknown>): string | null {
  if (typeof payload.url === "string" && payload.url) return payload.url;
  const data = payload.data;
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const url = (first as Record<string, unknown>).url;
      if (typeof url === "string" && url) return url;
    }
  }
  return null;
}

function statusOf(payload: Record<string, unknown>): string | null {
  const raw = payload.status;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

/** The create request: JSON for a text-only prompt, multipart with a first frame. */
export async function submitVideoJob(
  endpoint: VideoEndpoint,
  item: VideoGenerationItem,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  firstFrame?: VideoFirstFrame,
  lastFrame?: VideoFirstFrame,
  frameFields?: VideoFrameFields,
): Promise<{ id?: string; url?: string }> {
  const headers = new Headers(endpoint.headers);
  if (endpoint.apiKey) headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  const fields: Record<string, string> = { model: endpoint.modelId, prompt: item.prompt };
  if (item.durationSeconds) fields.seconds = String(item.durationSeconds);
  if (item.size) fields.size = item.size;
  let body: BodyInit = JSON.stringify(fields);
  if (firstFrame || lastFrame) {
    const names = resolveFrameFields(frameFields);
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    if (firstFrame) {
      form.set(
        names.first,
        new Blob([new Uint8Array(firstFrame.bytes)], { type: firstFrame.mimeType }),
        `frame.${firstFrame.extension}`,
      );
    }
    if (lastFrame) {
      form.set(
        names.last,
        new Blob([new Uint8Array(lastFrame.bytes)], { type: lastFrame.mimeType }),
        `last-frame.${lastFrame.extension}`,
      );
    }
    headers.delete("Content-Type");
    body = form;
  } else {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetchImpl(videoGenerationUrl(endpoint.baseUrl), {
    method: "POST",
    headers,
    redirect: "error",
    signal,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw videoError(authCode(response.status) ?? `VIDEO_HTTP_${response.status}`);
  }
  const payload = await readJson(response);
  const url = videoUrl(payload);
  const id = typeof payload.id === "string" && payload.id ? payload.id : undefined;
  if (!id && !url) throw videoError("VIDEO_INVALID_RESPONSE");
  const status = statusOf(payload);
  if (!id && status && FAILURE_STATUSES.has(status)) throw videoError("VIDEO_JOB_FAILED");
  return { ...(id ? { id } : {}), ...(url ? { url } : {}) };
}

/** Wait, but wake immediately when the caller aborts. */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Poll until the job reports a result, for at most `budgetMs`.
 *
 * Returns the URL the finished clip can be fetched from. An abort ends the loop
 * at the next checkpoint; an unknown state keeps polling; a terminal failure
 * carries a stable code and never the provider's raw error text.
 */
export async function pollVideoJob(
  endpoint: VideoEndpoint,
  id: string,
  signal: AbortSignal,
  options: {
    fetchImpl?: typeof fetch;
    budgetMs?: number;
    /** Injectable so a test never sleeps the shipped interval. */
    pollIntervalMs?: number;
  } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const budgetMs = options.budgetMs ?? VIDEO_GENERATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? VIDEO_POLL_INTERVAL_MS;
  const headers = new Headers(endpoint.headers);
  if (endpoint.apiKey) headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  const deadline = Date.now() + budgetMs;
  while (true) {
    signal.throwIfAborted();
    const response = await fetchImpl(videoJobUrl(endpoint.baseUrl, id), {
      method: "GET",
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw videoError("VIDEO_JOB_NOT_FOUND");
      throw videoError(authCode(response.status) ?? `VIDEO_HTTP_${response.status}`);
    }
    const payload = await readJson(response);
    const url = videoUrl(payload);
    const status = statusOf(payload);
    if (url && (!status || SUCCESS_STATUSES.has(status))) return url;
    if (status && FAILURE_STATUSES.has(status)) throw videoError("VIDEO_JOB_FAILED");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw videoError("VIDEO_TIMEOUT");
    await waitFor(Math.min(pollIntervalMs, remaining), signal);
  }
}

export async function generateOneVideo(
  endpoint: VideoEndpoint,
  item: VideoGenerationItem,
  signal: AbortSignal,
  options: {
    fetchImpl?: typeof fetch;
    downloadOptions?: VideoDownloadOptions;
    firstFrame?: VideoFirstFrame;
    lastFrame?: VideoFirstFrame;
    frameFields?: VideoFrameFields;
    budgetMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<{ bytes: Uint8Array; mimeType: string; extension: string; durationSeconds?: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const firstFrame = options.firstFrame;
  const job = await submitVideoJob(
    endpoint,
    item,
    signal,
    fetchImpl,
    firstFrame,
    options.lastFrame,
    options.frameFields,
  );
  let url = job.url ?? null;
  if (!url) {
    if (!job.id) throw videoError("VIDEO_INVALID_RESPONSE");
    url = await pollVideoJob(endpoint, job.id, signal, {
      fetchImpl,
      budgetMs: options.budgetMs,
      pollIntervalMs: options.pollIntervalMs,
    });
  }
  const bytes = await downloadGeneratedVideo(url, signal, {
    ...options.downloadOptions,
    fetchImpl: options.downloadOptions?.fetchImpl ?? fetchImpl,
  });
  return {
    bytes,
    ...generatedVideoType(bytes),
    ...(item.durationSeconds ? { durationSeconds: item.durationSeconds } : {}),
  };
}

/**
 * Two workers, stable result ordering, no automatic retry of billable requests.
 *
 * A video job is minutes long, so the batch is deliberately small (see
 * `MAX_GENERATED_VIDEOS`) and each job carries its own submit-plus-poll budget.
 */
export async function generateVideoBatch(options: {
  input: unknown;
  endpoint: VideoEndpoint;
  signal: AbortSignal;
  save: (
    video: Awaited<ReturnType<typeof generateOneVideo>>,
    index: number,
  ) => Promise<string>;
  fetchImpl?: typeof fetch;
  downloadOptions?: VideoDownloadOptions;
  loadFrame?: (item: VideoGenerationItem) => Promise<VideoFirstFrame | undefined>;
  /** The closing frame of a first-plus-last-frame clip, when the item names one. */
  loadLastFrame?: (item: VideoGenerationItem) => Promise<VideoFirstFrame | undefined>;
  /** Multipart names for the frames; the OpenAI-compatible defaults apply when absent. */
  frameFields?: VideoFrameFields;
  /** Per-job budget and poll cadence; the shipped defaults apply when absent. */
  budgetMs?: number;
  pollIntervalMs?: number;
  /** One callback per job, so a minutes-long batch can be reported while it runs. */
  onItemEvent?: (event: {
    index: number;
    status: "running" | GeneratedVideoResult["status"];
    total: number;
  }) => void;
}): Promise<GeneratedVideoResult[]> {
  const budgetMs = options.budgetMs ?? VIDEO_GENERATION_TIMEOUT_MS;
  const items = videoGenerationItems(options.input);
  const results: GeneratedVideoResult[] = new Array(items.length);
  let next = 0;
  let authFailed = false;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      if (options.signal.aborted || authFailed) {
        results[index] = {
          index,
          status: "cancelled",
          errorCode: authFailed ? "VIDEO_AUTH_FAILED" : "VIDEO_CANCELLED",
        };
        options.onItemEvent?.({ index, status: "cancelled", total: items.length });
        continue;
      }
      options.onItemEvent?.({ index, status: "running", total: items.length });
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), budgetMs);
      try {
        const item = items[index];
        const frame = item.image ? await options.loadFrame?.(item) : undefined;
        if (item.image && !frame) throw videoError("VIDEO_FRAME_UNAVAILABLE");
        const lastFrame = item.lastFrame ? await options.loadLastFrame?.(item) : undefined;
        if (item.lastFrame && !lastFrame) throw videoError("VIDEO_FRAME_UNAVAILABLE");
        signal.throwIfAborted();
        const video = await generateOneVideo(
          options.endpoint,
          item,
          signal,
          {
            fetchImpl: options.fetchImpl,
            downloadOptions: options.downloadOptions,
            firstFrame: frame,
            lastFrame,
            frameFields: options.frameFields,
            budgetMs,
            pollIntervalMs: options.pollIntervalMs,
          },
        );
        const path = await options.save(video, index);
        results[index] = {
          index,
          status: "succeeded",
          path,
          mimeType: video.mimeType,
          ...(video.durationSeconds ? { durationSeconds: video.durationSeconds } : {}),
        };
        options.onItemEvent?.({ index, status: "succeeded", total: items.length });
      } catch (error) {
        const code = options.signal.aborted
          ? "VIDEO_CANCELLED"
          : controller.signal.aborted
            ? "VIDEO_TIMEOUT"
            : error &&
                typeof error === "object" &&
                "errorCode" in error &&
                typeof error.errorCode === "string"
              ? error.errorCode
              : "VIDEO_REQUEST_FAILED";
        if (code === "VIDEO_AUTH_FAILED") authFailed = true;
        results[index] = {
          index,
          status: options.signal.aborted ? "cancelled" : "failed",
          errorCode: code,
        };
        options.onItemEvent?.({
          index,
          status: options.signal.aborted ? "cancelled" : "failed",
          total: items.length,
        });
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}
