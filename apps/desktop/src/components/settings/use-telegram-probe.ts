import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import { api } from "../../lib/api";
import type { TelegramChatCandidate, TelegramProbeFailure } from "../../lib/messaging-platforms";

/** What the two inline probes on the Telegram form know right now. */
export type TelegramProbe = {
  /** Which probe is in flight, so each button can say it is working. */
  busy: "bot" | "chats" | null;
  /** The bot `getMe` confirmed, if it has been confirmed. */
  bot: { username: string; name: string } | null;
  /** Why the last probe failed, in the four shapes the page can explain. */
  failure: TelegramProbeFailure | null;
  /** The conversation `getUpdates` found, if one was found. */
  chat: TelegramChatCandidate | null;
  /** The bot is verified and nobody has messaged it yet. */
  noChat: boolean;
  /** A scannable `t.me` link for the verified bot, as a data URL. */
  qr: string | null;
  check: () => Promise<void>;
  findChat: () => Promise<void>;
};

/**
 * The two things this page can do *for* a person setting up Telegram.
 *
 * `getMe` turns "I created a bot" into a confirmed bot with a name; `getUpdates`
 * finds the chat that has messaged it, so the numeric id is discovered rather
 * than read off another bot. Both run in the desktop main process against a
 * fixed host. Nothing here saves: values land in the form, and Save is still the
 * only writer.
 *
 * This lives beside the page rather than inside it because both probes are
 * rendered next to the field they read — the token probe under the token, the
 * chat probe under the conversation — so the state has to be owned above both of
 * them instead of by a card sitting over the form.
 */
export function useTelegramProbe(options: {
  token: string;
  disabled: boolean;
  onApply: (next: { destination?: string; secrets?: Record<string, string> }) => void;
}): TelegramProbe {
  const [busy, setBusy] = useState<"bot" | "chats" | null>(null);
  const [bot, setBot] = useState<{ username: string; name: string } | null>(null);
  const [failure, setFailure] = useState<TelegramProbeFailure | null>(null);
  const [chat, setChat] = useState<TelegramChatCandidate | null>(null);
  const [noChat, setNoChat] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const applyRef = useRef(options.onApply);
  applyRef.current = options.onApply;
  const token = options.token;

  /*
    A verified bot gets a scannable link. Opening it on the phone is not a
    shortcut around configuration — it is the only way the conversation this
    page has to bind can exist at all, and it removes the need to type an
    @username into a phone keyboard.
  */
  useEffect(() => {
    if (!bot) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(`https://t.me/${bot.username}`, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 232,
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bot]);

  /*
    Nobody should have to press 查找会话 ID after scanning. The link opens the
    bot; pressing START there is the only step left, so watch for that message
    instead of asking the person to come back and click.
  */
  useEffect(() => {
    if (!waiting || !bot || chat) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const result = await api.probeTelegram(token, "chats");
        if (!stopped && result.ok && "chats" in result && result.chats[0]) {
          const found = result.chats[0];
          setChat(found);
          setWaiting(false);
          applyRef.current({ destination: found.id });
          return;
        }
      } catch {
        // A dropped probe is not a reason to stop watching.
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 3000);
    };
    timer = window.setTimeout(() => void tick(), 2500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waiting, bot, chat, token]);

  const check = async () => {
    setBusy("bot");
    setFailure(null);
    setNoChat(false);
    setChat(null);
    try {
      const result = await api.probeTelegram(token, "bot");
      if (result.ok && "bot" in result) {
        setBot({ username: result.bot.username, name: result.bot.name });
        setWaiting(true);
        applyRef.current({ secrets: { "bot-token": token.trim() } });
      } else {
        setBot(null);
        setFailure(result.ok ? "refused" : result.reason);
      }
    } catch {
      setBot(null);
      setFailure("network");
    } finally {
      setBusy(null);
    }
  };

  const findChat = async () => {
    setBusy("chats");
    setFailure(null);
    setNoChat(false);
    try {
      const result = await api.probeTelegram(token, "chats");
      if (result.ok && "chats" in result) {
        const first = result.chats[0];
        if (!first) {
          setNoChat(true);
        } else {
          setChat(first);
          applyRef.current({ destination: first.id });
        }
      } else {
        setFailure(result.ok ? "refused" : result.reason);
      }
    } catch {
      setFailure("network");
    } finally {
      setBusy(null);
    }
  };

  return { busy, bot, failure, chat, noChat, qr, check, findChat };
}
