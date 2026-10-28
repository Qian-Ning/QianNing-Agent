import { LocalAgentHost } from "../agent/host";
import { loadProvider } from "../agent/settings";
import { BrowserStore } from "../agent/store";
import { PhoneBridge } from "./desktop-bridge";

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
const provider = loadProvider();

const bridge = new PhoneBridge({
  store,
  platform: "android",
  version: VERSION,
  // No provider configured yet: the bridge still answers, and prompting says by
  // name that there is no runtime, instead of failing as a network error.
  host: provider ? new LocalAgentHost(store, provider) : undefined,
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
