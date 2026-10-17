/**
 * The Telegram quick-setup probe: the two calls that turn "paste a token" into
 * "your bot is real, and here is the chat id".
 *
 * The panel can only ask a user to copy values out of another product. Two of
 * those values are discoverable instead, and this module discovers them the way
 * the platform itself allows:
 *
 * - `getMe` proves the token belongs to a bot and returns the bot's own
 *   `@username`, so "create the bot" stops being a claim the user has to trust;
 * - `getUpdates` returns the chats that have messaged the bot, so the numeric
 *   chat id the record's `destination` wants is found rather than read off
 *   another bot.
 *
 * # Why this is safe enough to ship
 *
 * - The host is a CONSTANT. This module takes no endpoint argument, so it cannot
 *   be pointed at an address of an attacker's choosing and it restates no
 *   endpoint policy: only `https://api.telegram.org` is ever contacted. A user
 *   running their own Bot API server keeps the manual form.
 * - The token travels where Telegram's API requires it — in the request PATH —
 *   so redirects are disabled outright: an answer naming another host would
 *   otherwise carry the credential there.
 * - Nothing the platform returns is echoed. Results are projected onto ids and
 *   usernames; failures are typed codes, so a token can never reach a log line,
 *   a toast, an error string, or the renderer.
 * - The caller passes `fetch` in, so the whole module is testable without a
 *   network: a scripted refusal and a scripted success are both ordinary tests.
 */

/** The only host this module talks to. */
const TELEGRAM_API_BASE = "https://api.telegram.org";

/** How long one probe call may take. Short: this is a form control, not a job. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Telegram's bot token shape: the bot's numeric id, a colon, then the secret.
 * Checking it before a request means an obviously wrong paste is answered
 * instantly and never travels.
 */
const TOKEN_PATTERN = /^\d{5,16}:[A-Za-z0-9_-]{20,}$/;

export type TelegramProbeFailure = "malformed" | "unauthorized" | "network" | "refused";

export type TelegramBotIdentity = {
  id: number;
  username: string;
  name: string;
};

export type TelegramChatCandidate = {
  id: string;
  title: string;
};

export type TelegramProbeResult =
  | { ok: true; bot: TelegramBotIdentity }
  | { ok: false; reason: TelegramProbeFailure };

export type TelegramChatsResult =
  | { ok: true; chats: TelegramChatCandidate[] }
  | { ok: false; reason: TelegramProbeFailure };

export type TelegramProbeDeps = {
  /** Injected so a test can script both a success and a refusal. */
  fetch: typeof fetch;
  timeoutMs?: number;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The token's shape, checked without a request. */
export function isTelegramTokenShaped(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token.trim());
}

/**
 * One Bot API call.
 *
 * The URL is built from the constant base and the token alone — no query, no
 * host from the caller. `redirect: "error"` is load-bearing: without it a 3xx
 * would take the credential in the path to whatever host the answer named.
 */
async function callTelegram(
  token: string,
  method: "getMe" | "getUpdates",
  deps: TelegramProbeDeps,
): Promise<{ ok: true; body: UnknownRecord } | { ok: false; reason: TelegramProbeFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
  );
  let response: Response;
  try {
    response = await deps.fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch {
    // A transport failure is reported, never described: the URL carries the
    // token and any error string derived from it would carry it too.
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 404) {
    return { ok: false, reason: "unauthorized" };
  }
  if (!response.ok) return { ok: false, reason: "refused" };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "refused" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "refused" };
  // Telegram answers 200 with `{"ok":false,"error_code":401,...}` for a bad
  // token on some methods; the body, not the status line, is the verdict.
  if (parsed.ok !== true) {
    const code = parsed.error_code;
    return { ok: false, reason: code === 401 ? "unauthorized" : "refused" };
  }
  return { ok: true, body: parsed };
}

/** Who the token belongs to. This is the "bot created" confirmation. */
export async function probeTelegramBot(
  token: unknown,
  deps: TelegramProbeDeps,
): Promise<TelegramProbeResult> {
  if (!isTelegramTokenShaped(token)) return { ok: false, reason: "malformed" };
  const answer = await callTelegram(token.trim(), "getMe", deps);
  if (!answer.ok) return answer;
  const result = answer.body.result;
  if (!isRecord(result)) return { ok: false, reason: "refused" };
  const id = typeof result.id === "number" ? result.id : Number.NaN;
  const username = typeof result.username === "string" ? result.username.trim() : "";
  if (!Number.isFinite(id) || username === "") return { ok: false, reason: "refused" };
  const name =
    typeof result.first_name === "string" && result.first_name.trim() !== ""
      ? result.first_name.trim()
      : username;
  return { ok: true, bot: { id, username, name } };
}

/**
 * The chats that have messaged the bot since its last update.
 *
 * `getUpdates` is read-only here: `offset` is not advanced, so a message the bot
 * has not consumed yet stays available to the receive loop that will run once the
 * channel is enabled. Nothing is acknowledged and nothing is deleted.
 */
export async function discoverTelegramChats(
  token: unknown,
  deps: TelegramProbeDeps,
): Promise<TelegramChatsResult> {
  if (!isTelegramTokenShaped(token)) return { ok: false, reason: "malformed" };
  const answer = await callTelegram(token.trim(), "getUpdates", deps);
  if (!answer.ok) return answer;
  const updates = answer.body.result;
  if (!Array.isArray(updates)) return { ok: false, reason: "refused" };

  const seen = new Map<string, string>();
  for (const update of updates) {
    if (!isRecord(update) || !isRecord(update.message) || !isRecord(update.message.chat)) {
      continue;
    }
    const chat = update.message.chat;
    const rawId = chat.id;
    const id =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === "string" && rawId.trim() !== ""
          ? rawId.trim()
          : "";
    if (id === "" || seen.has(id)) continue;
    const title =
      (typeof chat.title === "string" && chat.title.trim()) ||
      (typeof chat.username === "string" && chat.username.trim()) ||
      (typeof chat.first_name === "string" && chat.first_name.trim()) ||
      id;
    seen.set(id, title);
  }
  return {
    ok: true,
    chats: [...seen.entries()].map(([id, title]) => ({ id, title })),
  };
}
