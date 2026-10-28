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

(window as unknown as { piDesktop: unknown }).piDesktop = bridge.toWindowApi();
