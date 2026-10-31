/**
 * Native HTTP for the phone.
 *
 * The renderer's `fetch` is patched by CapacitorHttp, and a GET is routed
 * through a `http://localhost/_capacitor_http_proxy_` proxy. That path is a
 * dead end here: the app's origin is `https://localhost`, the proxy is plain
 * http, and a stalled proxy request never settles — discovery sat at
 * "连接中" and then reported a timeout, every time, no matter how long the
 * ceiling was.
 *
 * This calls the plugin directly. No proxy, no mixed-content rule, an explicit
 * connect/read budget, and one predictable shape for both the model probe and
 * the chat completion.
 */

interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  url: string;
}

interface CapacitorHttpPlugin {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: "text" | "json" | "arraybuffer" | "blob";
  }): Promise<NativeResponse>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { CapacitorHttp?: CapacitorHttpPlugin };
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const value = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return value ?? null;
}

export function hasNativeHttp(): boolean {
  const cap = capacitor();
  if (!cap?.Plugins?.CapacitorHttp) return false;
  if (typeof cap.isNativePlatform === "function") return cap.isNativePlatform();
  const platform = typeof cap.getPlatform === "function" ? cap.getPlatform() : "";
  return platform === "android" || platform === "ios";
}

export interface NativeRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** Time to establish the connection. */
  connectTimeoutMs?: number;
  /** Time to receive the whole body. */
  readTimeoutMs?: number;
}

export async function nativeRequest(
  url: string,
  init: NativeRequestInit,
): Promise<NativeResponse> {
  const plugin = capacitor()?.Plugins?.CapacitorHttp;
  if (!plugin) throw new Error("CapacitorHttp plugin unavailable");

  return plugin.request({
    url,
    method: init.method,
    headers: init.headers,
    data: init.body,
    connectTimeout: init.connectTimeoutMs ?? 8_000,
    readTimeout: init.readTimeoutMs ?? 20_000,
    responseType: "text",
  });
}
