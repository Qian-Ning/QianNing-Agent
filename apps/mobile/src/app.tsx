import { useEffect, useMemo, useState } from "react";
import {
  clearConnection,
  loadConnection,
  RacpClient,
  readPairingLink,
  saveConnection,
  type Connection,
  type HostClient,
} from "./lib/racp";
import { createTranslator, detectLang } from "./lib/i18n";
import { ConnectView } from "./views/connect";
import { ChatView } from "./views/chat";
import { SessionsView, type SessionSummary } from "./views/sessions";
import { BrowserStore } from "./agent/store";
import { LocalAgentHost, type ProviderConfig } from "./agent/host";
import { LocalClient } from "./agent/local-client";
import { clearProvider, loadProvider, saveProvider } from "./agent/settings";

type Screen = { name: "sessions" } | { name: "chat"; session: SessionSummary };

/** Which agent this phone is talking to: the one here, or the one at home. */
type Host =
  | { kind: "local"; provider: ProviderConfig }
  | { kind: "remote"; connection: Connection }
  | null;

const HOST_KEY = "qn.host";

/**
 * The phone's whole surface: pick a host once, then sessions and conversations.
 *
 * The route is a piece of state rather than a URL because the Android build runs
 * from `https://localhost` where paths are meaningless, and the Host-served build
 * has exactly two screens. A router would be a dependency with one job.
 */
export function App() {
  const [host, setHost] = useState<Host>(() => {
    const paired = readPairingLink();
    if (paired) {
      saveConnection(paired);
      localStorage.setItem(HOST_KEY, "remote");
      return { kind: "remote", connection: paired };
    }
    const chosen = localStorage.getItem(HOST_KEY);
    if (chosen === "remote") {
      const connection = loadConnection();
      return connection ? { kind: "remote", connection } : null;
    }
    const provider = loadProvider();
    return provider ? { kind: "local", provider } : null;
  });
  const [screen, setScreen] = useState<Screen>({ name: "sessions" });

  const lang = useMemo(() => detectLang(), []);
  const t = useMemo(() => createTranslator(lang), [lang]);

  /**
   * The phone's own Host is built once per provider and kept, because a running
   * session holds a live agent instance.
   */
  const localHost = useMemo(() => {
    if (host?.kind !== "local") return null;
    return new LocalAgentHost(new BrowserStore(), host.provider);
  }, [host]);

  const client: HostClient | null = useMemo(() => {
    if (host?.kind === "local" && localHost) return new LocalClient(localHost);
    if (host?.kind === "remote") return new RacpClient(host.connection);
    return null;
  }, [host, localHost]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  if (!host || !client) {
    return (
      <ConnectView
        t={t}
        onConnected={(next) => {
          saveConnection(next);
          localStorage.setItem(HOST_KEY, "remote");
          setHost({ kind: "remote", connection: next });
        }}
        onLocal={(provider) => {
          saveProvider(provider);
          localStorage.setItem(HOST_KEY, "local");
          setHost({ kind: "local", provider });
        }}
      />
    );
  }

  if (screen.name === "chat") {
    return (
      <ChatView
        client={client}
        sessionId={screen.session.id}
        title={screen.session.title}
        t={t}
        onBack={() => setScreen({ name: "sessions" })}
      />
    );
  }

  return (
    <SessionsView
      client={client}
      t={t}
      lang={lang}
      onOpen={(session) => setScreen({ name: "chat", session })}
      onSignOut={() => {
        clearConnection();
        clearProvider();
        localStorage.removeItem(HOST_KEY);
        setHost(null);
        setScreen({ name: "sessions" });
      }}
    />
  );
}
