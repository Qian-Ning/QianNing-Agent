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
import { clearProvider, isComplete, loadPrefs, loadProvider, saveProvider } from "./agent/settings";
import { emptyProvider } from "./agent/settings";
import { ProviderSheet } from "./views/provider-sheet";
import { ModelSheet } from "./views/model-sheet";
import { SettingsView } from "./views/settings";
import { SessionDrawer } from "./views/session-drawer";

type Screen = { name: "sessions" } | { name: "chat"; session: SessionSummary } | { name: "settings" };

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
  const [modelOpen, setModelOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const lang = useMemo(() => detectLang(), []);
  const t = useMemo(() => createTranslator(lang), [lang]);

  /**
   * The phone's own Host is built once per provider and kept, because a running
   * session holds a live agent instance.
   */
  const localHost = useMemo(() => {
    if (host?.kind !== "local") return null;
    return new LocalAgentHost(new BrowserStore(), host.provider, undefined, loadPrefs());
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
        onSkip={() => {
          localStorage.setItem(HOST_KEY, "local");
          setHost({ kind: "local", provider: emptyProvider });
        }}
      />
    );
  }

  const configured = host.kind !== "local" || isComplete(host.provider);
  const store = useMemo(() => new BrowserStore(), []);
  const stats = useMemo(() => {
    if (host?.kind !== "local") return undefined;
    const sessions = store.listSessions();
    const messages = sessions.reduce((total, session) => total + store.readMessages(session.id).length, 0);
    return { sessions: sessions.length, messages };
  }, [store, host, screen]);
  // The desktop shows the live model beside the composer; on the phone the same
  // label doubles as the way back into the setup sheet.
  const modelLabel = host.kind === "local" ? host.provider.modelId || t("local.model") : t("connect.modeRemote");

  const setupSheet = setupOpen ? (
    <ProviderSheet
      t={t}
      initial={host.kind === "local" ? host.provider : emptyProvider}
      onClose={() => setSetupOpen(false)}
      onSave={(provider) => {
        saveProvider(provider);
        setSetupOpen(false);
        // A new provider means a new Host: the old instance holds a model.
        setHost({ kind: "local", provider });
      }}
    />
  ) : null;

  if (screen.name === "settings") {
    return (
      <SettingsView
        t={t}
        client={host.kind === "local" ? client : undefined}
        modelLabel={modelLabel}
        thinking={host.kind === "local" ? (host.provider.thinking ?? "off") : "off"}
        onApplyModel={(patch) => {
          if (host.kind !== "local") return;
          const next = { ...host.provider, modelId: patch.modelId, thinking: patch.thinking as never };
          saveProvider(next);
          setHost({ kind: "local", provider: next });
        }}
        connection={host.kind === "remote" ? { base: host.connection.base } : undefined}
        onDisconnect={() => {
          clearConnection();
          clearProvider();
          localStorage.removeItem(HOST_KEY);
          setHost(null);
          setScreen({ name: "sessions" });
        }}
        stats={stats ?? { sessions: 0, messages: 0 }}
        onClose={() => setScreen({ name: "sessions" })}
      />
    );
  }

  if (screen.name === "chat") {
    return (
      <>
        <ChatView
          client={client}
          sessionId={screen.session.id}
          title={screen.session.title}
          t={t}
          configured={configured}
          canDiff={host.kind === "remote"}
          modelLabel={modelLabel}
          onOpenModel={host.kind === "local" ? () => setModelOpen(true) : undefined}
          onRequestSetup={() => setSetupOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        {drawerOpen ? (
          <SessionDrawer
            client={client}
            t={t}
            lang={lang}
            currentId={screen.session.id}
            onSelect={(next) => {
              setDrawerOpen(false);
              setScreen({ name: "chat", session: next });
            }}
            onNew={() => {
              setDrawerOpen(false);
              setScreen({ name: "sessions" });
            }}
            onSettings={() => {
              setDrawerOpen(false);
              setScreen({ name: "settings" });
            }}
            onClose={() => setDrawerOpen(false)}
          />
        ) : null}
        {setupSheet}
        {modelOpen && host.kind === "local" ? (
          <ModelSheet
            t={t}
            client={client}
            model={host.provider.modelId}
            thinking={host.provider.thinking ?? "off"}
            onClose={() => setModelOpen(false)}
            onApply={(patch) => {
              const next = { ...host.provider, ...patch };
              saveProvider(next);
              setHost({ kind: "local", provider: next });
              setModelOpen(false);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
    <SessionsView
      client={client}
      t={t}
      lang={lang}
      configured={configured}
      onRequestSetup={() => setSetupOpen(true)}
      onOpen={(session) => setScreen({ name: "chat", session })}
      onOpenSettings={() => setScreen({ name: "settings" })}
      onSignOut={() => {
        clearConnection();
        clearProvider();
        localStorage.removeItem(HOST_KEY);
        setHost(null);
        setScreen({ name: "sessions" });
      }}
    />
    {setupSheet}
    </>
  );
}
