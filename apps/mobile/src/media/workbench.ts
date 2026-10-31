/**
 * The media workbench on the phone.
 *
 * The desktop runs image generation through the Agent's own tool and a host-side
 * library. A phone has neither a host process nor a library directory it can
 * serve over a custom scheme, so this module keeps the same *contract* — the
 * `workbench/*` channels the renderer already speaks — and implements the parts
 * that matter at phone scale:
 *
 *   - the request goes straight to the OpenAI-compatible images endpoint the
 *     configured provider exposes, which is what the desktop's tool speaks too;
 *   - each finished render is written to the app's own files directory and the
 *     bytes are kept in memory as a data URL, because a WebView cannot load a
 *     file path and there is no custom protocol to serve one from;
 *   - the library index lives beside the provider record, so history survives a
 *     restart exactly as it does on the desktop.
 */

import { loadProvider } from "../agent/settings";
import { nativeRequest } from "../bridge/native-http";

type Capability = "image" | "video";

export type WorkbenchRequest = {
  capability?: Capability;
  sessionId?: string;
  model?: { providerId?: string; modelId?: string };
  input?: {
    items?: Array<{ prompt?: string; count?: number; size?: string; images?: string[] }>;
  };
};

export type WorkbenchItem = {
  index: number;
  status: "succeeded" | "failed" | "cancelled";
  path?: string;
  url?: string;
  prompt?: string;
  size?: string;
  errorCode?: string;
};

export type WorkbenchResult = {
  ok: boolean;
  capability: Capability;
  providerId?: string;
  modelId?: string;
  results: WorkbenchItem[];
  errorCode?: string;
  message?: string;
};

type LibraryEntry = {
  id: string;
  capability: Capability;
  path?: string;
  status: "succeeded" | "failed" | "cancelled";
  prompt?: string;
  providerId?: string;
  modelId?: string;
  size?: string;
  errorCode?: string;
  createdAt: string;
};

const LIBRARY_KEY = "qn.media.library";
const MAX_ENTRIES = 200;
/** How many renders are hydrated into data URLs per listing; each one is megabytes. */
const HYDRATE_LIMIT = 12;
/** 20 outputs per run is the desktop's cap; a phone keeps the same ceiling. */
const MAX_OUTPUTS = 20;

/** Data URLs kept by path, so a list refresh does not re-read every file. */
const hydrated = new Map<string, string>();

type FilesPlugin = {
  writeBase64?(options: { name: string; data: string; folder?: string }): Promise<{
    path: string;
    size: number;
  }>;
  readDataUrl(options: {
    path: string;
    mimeType?: string;
  }): Promise<{ kind: string; dataUrl?: string; size?: number }>;
};

function files(): FilesPlugin | null {
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (capacitor?.Plugins?.QnFiles as FilesPlugin | undefined) ?? null;
}

function readIndex(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(entries: LibraryEntry[]): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `{baseUrl}/images/generations`, built the same way the desktop's tool builds
 * it: a trailing slash or a `/v1` suffix both land on the same path.
 */
export function imageEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("the provider address is not http(s)");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/images/generations`;
  return url.href;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One image, as bytes plus the mime type the provider implied. */
function decodeImage(payload: Record<string, unknown>): { dataUrl: string } | null {
  const b64 = typeof payload.b64_json === "string" ? payload.b64_json : null;
  if (b64) return { dataUrl: `data:image/png;base64,${b64}` };
  return null;
}

/** Retry a 429/5xx once; image endpoints rate-limit on bursts. */
async function post(url: string, body: string, apiKey: string): Promise<{ status: number; data: unknown; text: string }> {
  let last: { status: number; data: unknown; text: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await nativeRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
      connectTimeoutMs: 15_000,
      readTimeoutMs: 180_000,
    });
    const text = typeof answer.data === "string" ? answer.data : JSON.stringify(answer.data ?? null);
    let parsed: unknown = answer.data;
    if (typeof answer.data === "string") {
      try {
        parsed = JSON.parse(answer.data);
      } catch {
        parsed = null;
      }
    }
    last = { status: answer.status, data: parsed, text };
    if (answer.status !== 429 && answer.status < 500) return last;
  }
  return last!;
}

function providerMessage(text: string): string {
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  const record = asRecord(parsed);
  const error = asRecord(record?.error);
  const message = typeof error?.message === "string" ? error.message : record?.message;
  if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
  return text.trim().slice(0, 200) || "the provider returned nothing";
}

let cancelRequested = false;

export function cancelWorkbench(): { cancelled: boolean } {
  // The HTTP call itself cannot be aborted through CapacitorHttp, so a cancel
  // stops the batch between items; the item in flight still finishes and is
  // reported, which is what the page's own progress line expects.
  cancelRequested = true;
  return { cancelled: true };
}

export async function generate(request: WorkbenchRequest): Promise<WorkbenchResult> {
  const capability: Capability = request.capability === "video" ? "video" : "image";
  if (capability === "video") {
    return {
      ok: false,
      capability,
      results: [],
      errorCode: "VIDEO_UNAVAILABLE",
      message: "这台手机还没有视频生成通道",
    };
  }

  const provider = loadProvider();
  if (!provider) {
    return {
      ok: false,
      capability,
      results: [],
      errorCode: "PROVIDER_MISSING",
      message: "先在设置里配置模型服务，图片要用同一个地址和密钥",
    };
  }

  const modelId = request.model?.modelId?.trim() || provider.modelId;
  const items = request.input?.items ?? [];
  const prompts = items
    .map((item) => ({
      prompt: typeof item.prompt === "string" ? item.prompt.trim() : "",
      count: Math.max(1, Math.min(MAX_OUTPUTS, Number(item.count) || 1)),
      size: typeof item.size === "string" && /^\d{2,5}x\d{2,5}$/.test(item.size) ? item.size : "",
    }))
    .filter((item) => item.prompt.length > 0);
  if (prompts.length === 0) {
    return { ok: false, capability, results: [], errorCode: "PROMPT_MISSING", message: "写一句提示词再生成" };
  }

  let endpoint: string;
  try {
    endpoint = imageEndpoint(provider.baseUrl);
  } catch (cause) {
    return {
      ok: false,
      capability,
      results: [],
      errorCode: "IMAGE_INVALID_ENDPOINT",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  cancelRequested = false;
  const results: WorkbenchItem[] = [];
  const fresh: LibraryEntry[] = [];
  let index = 0;

  for (const item of prompts) {
    for (let copy = 0; copy < item.count; copy += 1) {
      const position = index;
      index += 1;
      if (cancelRequested) {
        results.push({ index: position, status: "cancelled", prompt: item.prompt });
        continue;
      }
      const body = JSON.stringify({
        model: modelId,
        prompt: item.prompt,
        n: 1,
        ...(item.size ? { size: item.size } : {}),
        ...(modelId.startsWith("dall-e-") ? { response_format: "b64_json" } : {}),
      });
      try {
        const answer = await post(endpoint, body, provider.apiKey);
        if (answer.status >= 400) {
          const message = providerMessage(answer.text);
          results.push({
            index: position,
            status: "failed",
            prompt: item.prompt,
            errorCode: `HTTP_${answer.status}`,
            ...(message ? {} : {}),
          });
          fresh.push({
            id: newId(),
            capability,
            status: "failed",
            prompt: item.prompt,
            providerId: provider.baseUrl,
            modelId,
            errorCode: `HTTP_${answer.status}`,
            createdAt: new Date().toISOString(),
          });
          continue;
        }
        const payload = asRecord(answer.data);
        const list = Array.isArray(payload?.data) ? payload.data : [];
        const first = asRecord(list[0]);
        const decoded = first ? decodeImage(first) : null;
        const remote = typeof first?.url === "string" ? first.url : null;
        let dataUrl = decoded?.dataUrl ?? null;
        if (!dataUrl && remote) {
          // Some gateways answer with a link instead of bytes; pull it down.
          const download = await nativeRequest(remote, {
            method: "GET",
            readTimeoutMs: 60_000,
          });
          const raw = typeof download.data === "string" ? download.data : "";
          if (download.status < 400 && raw.startsWith("data:")) dataUrl = raw;
          else if (download.status < 400 && /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 1000) {
            dataUrl = `data:image/png;base64,${raw.replace(/\s+/g, "")}`;
          }
        }
        if (!dataUrl) {
          results.push({ index: position, status: "failed", prompt: item.prompt, errorCode: "NO_IMAGE" });
          fresh.push({
            id: newId(),
            capability,
            status: "failed",
            prompt: item.prompt,
            modelId,
            errorCode: "NO_IMAGE",
            createdAt: new Date().toISOString(),
          });
          continue;
        }
        const id = newId();
        const plugin = files();
        let path: string | undefined;
        if (plugin?.writeBase64) {
          try {
            const written = await plugin.writeBase64({
              name: `${id}.png`,
              data: dataUrl,
              folder: "media",
            });
            path = written.path;
            hydrated.set(path, dataUrl);
          } catch {
            path = undefined;
          }
        }
        results.push({
          index: position,
          status: "succeeded",
          prompt: item.prompt,
          url: dataUrl,
          ...(path ? { path } : {}),
        });
        fresh.push({
          id,
          capability,
          status: "succeeded",
          prompt: item.prompt,
          providerId: provider.baseUrl,
          modelId,
          ...(item.size ? { size: item.size } : {}),
          ...(path ? { path } : {}),
          createdAt: new Date().toISOString(),
        });
      } catch (cause) {
        results.push({
          index: position,
          status: "failed",
          prompt: item.prompt,
          errorCode: "REQUEST_FAILED",
        });
        fresh.push({
          id: newId(),
          capability,
          status: "failed",
          prompt: item.prompt,
          modelId,
          errorCode: cause instanceof Error ? cause.message.slice(0, 80) : "REQUEST_FAILED",
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  writeIndex([...fresh, ...readIndex()]);
  const ok = results.some((item) => item.status === "succeeded");
  return {
    ok,
    capability,
    modelId,
    results,
    ...(ok
      ? {}
      : {
          errorCode: results[0]?.errorCode ?? "IMAGE_FAILED",
          message: results.some((item) => item.status === "cancelled")
            ? "已取消"
            : "没有生成出图片，检查模型是否支持图片接口",
        }),
  };
}

/** Turn a stored record into what the renderer paints, bytes included. */
async function toView(entry: LibraryEntry): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    id: entry.id,
    capability: entry.capability,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.prompt ? { prompt: entry.prompt } : {}),
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.size ? { size: entry.size } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.path ? { path: entry.path } : {}),
  };
  if (!entry.path) return base;
  const cached = hydrated.get(entry.path);
  if (cached) return { ...base, url: cached, thumbUrl: cached };
  const plugin = files();
  if (!plugin) return base;
  try {
    const read = await plugin.readDataUrl({ path: entry.path, mimeType: "image/png" });
    if (read.kind === "image" && read.dataUrl) {
      hydrated.set(entry.path, read.dataUrl);
      return { ...base, url: read.dataUrl, thumbUrl: read.dataUrl };
    }
  } catch {
    return base;
  }
  return base;
}

export async function library(): Promise<{ entries: Array<Record<string, unknown>> }> {
  const entries = readIndex();
  const out: Array<Record<string, unknown>> = [];
  let hydratedCount = 0;
  for (const entry of entries) {
    if (entry.path && hydratedCount >= HYDRATE_LIMIT) {
      out.push({ ...entry });
      continue;
    }
    if (entry.path) hydratedCount += 1;
    out.push(await toView(entry));
  }
  return { entries: out };
}

export async function removeFromLibrary(ids: string[]): Promise<{ entries: Array<Record<string, unknown>> }> {
  const drop = new Set(ids);
  const entries = readIndex();
  const kept = entries.filter((entry) => !drop.has(entry.id));
  writeIndex(kept);
  for (const entry of entries) {
    if (entry.path && drop.has(entry.id)) hydrated.delete(entry.path);
  }
  return library();
}

export async function clearLibrary(): Promise<{ entries: Array<Record<string, unknown>> }> {
  writeIndex([]);
  hydrated.clear();
  return { entries: [] };
}
