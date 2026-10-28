import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The mobile shell loads the client page from its own bundle, not from the Host,
 * so the app opens instantly and then asks which computer to talk to. Pointing
 * `server.url` at the Host would make the app a browser window with extra steps
 * — and it would only work while the Host was reachable.
 */
const config: CapacitorConfig = {
  appId: "app.qianning.agent",
  appName: "QianNing Agent",
  webDir: "dist",
  plugins: {
    // The shared surface is the desktop renderer, whose CSP allows same-origin
    // requests only. Model calls go to the user's provider, so they are made
    // natively instead of through the WebView's fetch.
    CapacitorHttp: { enabled: true },
  },
  android: {
    // The Host's certificate is self-signed and pinned by the user installing it;
    // cleartext is never allowed, so a misconfigured address fails loudly.
    allowMixedContent: false,
  },
};

export default config;
