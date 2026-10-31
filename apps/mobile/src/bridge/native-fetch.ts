/**
 * CapacitorHttp buffers every non-GET response before resolving: it calls the
 * native plugin, waits for the whole body, then builds a `Response`. A chat
 * completion asks for `stream: true`, so the provider keeps the connection open
 * and the native promise never settles. On the phone that showed up as a turn
 * stuck at "正在处理…" forever.
 *
 * The request has to stay on the native path (the WebView would hit CORS), so
 * this keeps the transport but drops streaming: it rewrites the body to
 * `stream: false`, waits for the finished completion, and re-emits it as the
 * SSE chunks the OpenAI-completions parser expects.
 */

import { hasNativeHttp, nativeRequest } from "./native-http";

type Json = Record<string, unknown>;

interface ChatChunk {
  id?: unknown;
  object: "chat.completion.chunk";
  created?: unknown;
  model?: unknown;
  choices: unknown[];
  usage?: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers) as Record<string, string>;
  return { ...(headers as Record<string, string>) };
}

function isChatCompletionRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  return /\/chat\/completions(\?|$)/.test(urlOf(input));
}

/**
 * Turns one non-streamed completion into the delta sequence a streaming parser
 * consumes: assistant text first, then any tool calls, then the finish reason,
 * then usage, then `[DONE]`.
 */
export function completionToSse(completion: Json): string {
  const choices = Array.isArray(completion.choices) ? (completion.choices as Json[]) : [];
  const choice = choices[0] ?? {};
  const message = (choice.message ?? {}) as Json;

  const base = {
    id: completion.id,
    object: "chat.completion.chunk" as const,
    created: completion.created,
    model: completion.model,
  };

  const chunks: ChatChunk[] = [];
  const firstDelta: Json = { role: "assistant" };
  if (typeof message.content === "string") firstDelta.content = message.content;
  if (typeof message.reasoning_content === "string") firstDelta.reasoning_content = message.reasoning_content;
  chunks.push({ ...base, choices: [{ index: 0, delta: firstDelta, finish_reason: null }] });

  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
  toolCalls.forEach((call, index) => {
    const fn = (call.function ?? {}) as Json;
    chunks.push({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: call.id,
            type: call.type ?? "function",
            function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) },
          }],
        },
        finish_reason: null,
      }],
    });
  });

  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
  });

  if (completion.usage) {
    chunks.push({ ...base, choices: [], usage: completion.usage });
  }

  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Where a chat request should travel.
 *
 * `CapacitorWebFetch` is Capacitor's saved copy of the WebView's own fetch,
 * before the native patch replaced it. That path uses the platform network
 * stack, so a VPN or system proxy applies to it, and — unlike the native
 * plugin, which buffers the whole body before resolving — it delivers the SSE
 * stream as it arrives. That is the difference between reading the first
 * sentence in about a second and waiting for the entire answer.
 *
 * It can only be used when the endpoint allows this origin through CORS, which
 * a cheap probe decides once per origin and remembers. Otherwise the native
 * non-streaming path takes over.
 */
const TRANSPORT_KEY = "qn.local.chatTransport";
const transportByOrigin = new Map<string, boolean>();

function loadTransport(origin: string): boolean | undefined {
  const cached = transportByOrigin.get(origin);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(TRANSPORT_KEY);
    if (!raw) return undefined;
    const table = JSON.parse(raw) as Record<string, unknown>;
    const value = table[origin];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveTransport(origin: string, streaming: boolean): void {
  transportByOrigin.set(origin, streaming);
  try {
    const raw = window.localStorage.getItem(TRANSPORT_KEY);
    const table = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    table[origin] = streaming;
    window.localStorage.setItem(TRANSPORT_KEY, JSON.stringify(table));
  } catch {
    // A locked-down storage just means the probe runs again next launch.
  }
}

type WebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function webFetchOf(target: Window): WebFetch | null {
  const candidate = (target as unknown as { CapacitorWebFetch?: WebFetch }).CapacitorWebFetch;
  return typeof candidate === "function" ? candidate : null;
}

/**
 * Asks the endpoint once whether this origin may read its responses, which is
 * the only thing standing between the app and a real token stream. Also warms
 * DNS and TLS, so the first message does not pay for them.
 */
export async function primeChatTransport(
  target: Window,
  modelsUrl: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  const web = webFetchOf(target);
  if (!web) return false;
  const origin = new URL(modelsUrl).origin;
  const known = loadTransport(origin);
  if (known !== undefined) return known;

  try {
    await web.call(target, modelsUrl, {
      headers,
      signal: AbortSignal.timeout(6_000),
    });
    saveTransport(origin, true);
    return true;
  } catch {
    saveTransport(origin, false);
    return false;
  }
}

/**
 * Installs the shim on `target`. Returns a restore function.
 */
export function installNativeChatFetch(target: Window): () => void {
  const original = target.fetch;
  const web = webFetchOf(target);

  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isChatCompletionRequest(input, init) || typeof init?.body !== "string") {
      return original.call(target, input, init);
    }

    let body: Json;
    try {
      body = JSON.parse(init.body) as Json;
    } catch {
      return original.call(target, input, init);
    }
    if (body.stream !== true) return original.call(target, input, init);

    // Real streaming first: the request goes out untouched.
    if (web && loadTransport(new URL(urlOf(input)).origin) === true) {
      try {
        return await web.call(target, input, init);
      } catch {
        saveTransport(new URL(urlOf(input)).origin, false);
      }
    }

    body.stream = false;
    // `stream_options` without `stream` is rejected by several providers.
    delete body.stream_options;

    const payload = JSON.stringify(body);

    // The plugin call is the reliable transport on a phone: no localhost proxy,
    // an explicit read budget, and no dependency on how the fetch patch behaves.
    if (hasNativeHttp()) {
      const native = await nativeRequest(urlOf(input), {
        method: "POST",
        headers: headersToRecord(init.headers),
        body: payload,
        connectTimeoutMs: 8_000,
        readTimeoutMs: 120_000,
      });
      const text = typeof native.data === "string" ? native.data : JSON.stringify(native.data);
      if (native.status < 200 || native.status >= 300) {
        return new Response(text, {
          status: native.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      let completion: Json;
      try {
        completion = JSON.parse(text) as Json;
      } catch {
        return new Response(text, { status: native.status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(completionToSse(completion), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const response = await original.call(target, input, { ...init, body: payload });
    if (!response.ok) return response;

    let completion: Json;
    try {
      completion = (await response.json()) as Json;
    } catch {
      return response;
    }

    return new Response(completionToSse(completion), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  target.fetch = patched as typeof target.fetch;
  return () => {
    target.fetch = original;
  };
}

/** True on a Capacitor build, where fetch is served by the native HTTP plugin. */
export function isNativeShell(win: Window): boolean {
  const capacitor = (win as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (!capacitor) return false;
  if (typeof capacitor.isNativePlatform === "function") return capacitor.isNativePlatform();
  const platform = typeof capacitor.getPlatform === "function" ? capacitor.getPlatform() : "";
  return platform === "android" || platform === "ios";
}
