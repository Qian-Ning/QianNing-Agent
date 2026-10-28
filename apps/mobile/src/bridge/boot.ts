import { LocalAgentHost, type ProviderConfig } from "../agent/host";
import { loadProvider } from "../agent/settings";
import { requestNoticePermission } from "../agent/system-notices";
import { BrowserStore } from "../agent/store";
import { PhoneBridge } from "./desktop-bridge";
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
