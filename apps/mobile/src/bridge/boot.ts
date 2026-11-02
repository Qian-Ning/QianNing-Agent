import { LocalAgentHost, type ProviderConfig } from "../agent/host";
import { loadProvider } from "../agent/settings";
import { requestNoticePermission } from "../agent/system-notices";
import { BrowserStore } from "../agent/store";
import { PhoneBridge } from "./desktop-bridge";
import { installNativeChatFetch, isNativeShell, primeChatTransport } from "./native-fetch";
import { ProviderBook } from "./providers";

/**
 * Turns the shared renderer's host into the phone's host.
 *
 * The desktop interface asks `window.piDesktop` for everything. On a phone the
 * answers come from this page: the mobile store, and the mobile agent host when
 * a provider is configured (ADR 0339). This file runs before the renderer's own
 * script, so the object exists by the time the first component mounts.
 */
const VERSION = "2.2.0";

/*
  Tell the shared renderer it is running on a phone.

  Every mobile layout rule is gated on `:root[data-surface="mobile"]`, and the
  renderer only sets that attribute from a `?surface=` query parameter. The
  desktop app never needs one; the audit harness and the smoke test always pass
  one; the installed phone loads `index.html` from the bundle with no query
  string at all. So on a real device the attribute stayed unset, the whole
  mobile stylesheet was inert, and the desktop layout rendered into a 390px
  screen — two-column settings panes stacked on each other and list rows
  overlapping, which no CSS fix could reach because none of it applied.

  This file runs before the renderer's own script, so setting it here lands
  before the first paint. An explicit query parameter still wins, so the audit
  and smoke harnesses keep controlling the surface they render.
*/
const querySurface = new URLSearchParams(window.location.search).get("surface");
document.documentElement.dataset.surface = querySurface || "mobile";

/*
  Chat turns on a phone go through CapacitorHttp, which buffers the whole body
  before the promise settles. A streaming completion never settles, so the turn
  spun at "正在处理…" forever. Install the non-streaming bridge before anything
  can issue a model request.
*/
if (isNativeShell(window)) installNativeChatFetch(window);

const store = new BrowserStore();

// A phone that was set up before the shared surface kept its service in
// `qn.local.provider`. Carry it into the provider list so nothing has to be
// re-entered after the upgrade.
const book = new ProviderBook(store);
const legacy = loadProvider();
if (legacy && book.list().length === 0) {
  book.create({
    name: legacy.baseUrl,
    baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey,
    models: [{ id: legacy.modelId }],
    defaultModelId: legacy.modelId,
  });
}

const active = book.active();
/*
  Warm the chat transport while the shell is still painting: this asks the
  provider whether the WebView's own network stack may read its responses. When
  it may, chat rides the platform stack (VPN/proxy aware, real token stream);
  when it may not, the native buffered path takes over. Fire and forget — the
  first message awaits the same promise, so nothing is wasted.
*/
if (active?.baseUrl) {
  const base = active.baseUrl.replace(/\/+$/, "");
  const modelsUrl = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  void primeChatTransport(
    window,
    modelsUrl,
    active.apiKey ? { Authorization: `Bearer ${active.apiKey}` } : undefined,
  );
}
const initialConfig: ProviderConfig | null =
  active && active.baseUrl && active.apiKey && active.defaultModelId
    ? { baseUrl: active.baseUrl, apiKey: active.apiKey, modelId: active.defaultModelId }
    : null;

const bridge = new PhoneBridge({
  store,
  platform: "android",
  version: VERSION,
  // No provider configured yet: the bridge still answers, and prompting says by
  // name that there is no runtime, instead of failing as a network error.
  host: initialConfig ? new LocalAgentHost(store, initialConfig) : undefined,
  // The settings page adds the first service after boot; the host attaches then.
  createHost: (config) => new LocalAgentHost(store, { ...config, modelId: config.modelId }),
});

const api = bridge.toWindowApi() as {
  invoke: (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; data?: unknown }>;
};

// A bridge that answers `undefined` looks like a missing feature to the
// interface. That is worth one line in the console when someone is looking,
// and silence the rest of the time.
if (new URLSearchParams(location.search).has("bridgeDebug")) {
  const real = api.invoke;
  api.invoke = async (channel, ...args) => {
    const result = await real(channel, ...args);
    if (result.ok && result.data === undefined) console.warn("[bridge] empty answer:", channel);
    if (!result.ok) console.warn("[bridge] refused:", channel);
    return result;
  };
}

(window as unknown as { piDesktop: unknown }).piDesktop = api;

// Ask for the notification permission on first start: the notification centre
// is only useful outside the app when the tray is allowed to speak.
void requestNoticePermission();

/**
 * A keyboard that opens on its own is a bug: opening a dialog is not a request to
 * type. Every focus that arrives without a tap in the last moment is dropped
 * before the soft keyboard can settle. A tap still focuses normally.
 */
const GESTURE_WINDOW_MS = 600;
let lastGestureAt = 0;
for (const type of ["pointerdown", "touchstart", "keydown"]) {
  window.addEventListener(type, () => {
    lastGestureAt = Date.now();
  }, true);
}

document.addEventListener(
  "focusin",
  (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA")) return;
    if (target instanceof HTMLInputElement && target.type === "range") return;
    if (Date.now() - lastGestureAt < GESTURE_WINDOW_MS) return;
    target.blur();
  },
  true,
);
