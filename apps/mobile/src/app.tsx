import { useEffect, useMemo, useState } from "react";
import {
  clearConnection,
  loadConnection,
  RacpClient,
  readPairingLink,
  saveConnection,
  type Connection,
} from "./lib/racp";
import { createTranslator, detectLang } from "./lib/i18n";
import { ConnectView } from "./views/connect";
import { ChatView } from "./views/chat";
import { SessionsView, type SessionSummary } from "./views/sessions";

type Screen = { name: "sessions" } | { name: "chat"; session: SessionSummary };

/**
 * The phone's whole surface: pair once, then sessions and conversations.
 *
 * The route is a piece of state rather than a URL because the Android build runs
 * from `https://localhost` where paths are meaningless, and the Host-served build
 * has exactly two screens. A router would be a dependency with one job.
 */
export function App() {
  const [connection, setConnection] = useState<Connection | null>(() => {
    const paired = readPairingLink();
    if (paired) {
      saveConnection(paired);
      return paired;
    }
    return loadConnection();
  });
  const [screen, setScreen] = useState<Screen>({ name: "sessions" });

  const lang = useMemo(() => detectLang(), []);
  const t = useMemo(() => createTranslator(lang), [lang]);
  const client = useMemo(() => (connection ? new RacpClient(connection) : null), [connection]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  if (!connection || !client) {
    return (
      <ConnectView
        t={t}
        onConnected={(next) => {
          saveConnection(next);
          setConnection(next);
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
        setConnection(null);
        setScreen({ name: "sessions" });
      }}
    />
  );
}
