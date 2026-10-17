import { WebSocket } from "ws";

import type {
  DiscordFetch,
  DiscordGatewayLookup,
  DiscordGatewayResult,
  DiscordSocket,
  DiscordSocketFactory,
} from "./messaging-discord-inbound.js";
import type {
  MattermostFetch,
  MattermostIdentityLookup,
  MattermostIdentityResult,
  MattermostSocket,
  MattermostSocketFactory,
} from "./messaging-mattermost-inbound.js";

/**
 * The production network seams for the two gateway channels (Discord and
 * Mattermost): the `ws`-backed websocket client, the Discord `/gateway/bot`
 * lookup and the Mattermost `GET /users/me` identity lookup.
 *
 * They are separated from the client logic so a client's tests never import
 * `ws` and never open a socket — the suites drive the clients through injected
 * doubles instead.
 *
 * Each credential travels only in the platform's own place: Discord's bot token
 * in the `Authorization: Bot …` header, Mattermost's access token in
 * `Authorization: Bearer …`. Neither appears in a URL, and neither appears in a
 * returned error: a failure detail names the status or the transport class
 * only, so an error string can never leak a token.
 */

/** A websocket factory over `ws`, shaped for either channel's client. */
function wsSocketFactory<T extends DiscordSocket | MattermostSocket>(): (url: string) => T {
  return (url: string): T => {
    const socket = new WebSocket(url);
    const wrapper = {
      send: (data: string) => socket.send(data),
      close: () => socket.close(),
      onMessage: (handler: (data: string) => void) => {
        socket.on("message", (data, isBinary) => {
          if (isBinary) {
            socket.close(1003, "binary frames are not accepted");
            return;
          }
          handler(typeof data === "string" ? data : data.toString("utf8"));
        });
      },
      onClose: (handler: (code?: number, reason?: string) => void) => {
        socket.on("close", (code, reason) => handler(code, reason.toString("utf8")));
      },
      onError: (handler: (error: unknown) => void) => {
        socket.on("error", handler);
      },
    };
    return wrapper as T;
  };
}

/** The production websocket client for the Discord Gateway. */
export function createWsDiscordSocketFactory(): DiscordSocketFactory {
  return wsSocketFactory<DiscordSocket>();
}

/** The production websocket client for the Mattermost API. */
export function createWsMattermostSocketFactory(): MattermostSocketFactory {
  return wsSocketFactory<MattermostSocket>();
}

export type DiscordGatewayLookupOptions = {
  /** The API base, e.g. `https://discord.com/api/v10`; `/gateway/bot` is appended. */
  endpoint: string;
  requestTimeoutMs?: number;
  fetchImpl?: DiscordFetch;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `GET /gateway/bot`, classified into the WSS URL or a status-only detail. */
export function createDiscordGatewayLookup(
  options: DiscordGatewayLookupOptions,
): DiscordGatewayLookup {
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (token: string): Promise<DiscordGatewayResult> => {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: "the configured bot token is empty" };
    const base = options.endpoint.trim().replace(/\/+$/, "");
    if (!base) return { ok: false, error: "the configured endpoint is empty" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${base}/gateway/bot`, {
        method: "GET",
        headers: { Authorization: `Bot ${trimmed}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, error: `the gateway lookup answered a redirect (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { ok: false, error: `the gateway lookup answered HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const url = isRecord(body) && typeof body.url === "string" ? body.url.trim() : "";
      if (!url) return { ok: false, error: "the gateway lookup returned no URL" };
      return { ok: true, url };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error && error.name === "AbortError"
          ? "the gateway lookup timed out"
          : "the gateway lookup failed",
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type MattermostIdentityLookupOptions = {
  /** The base URL the user configured, e.g. `https://chat.example.com`. */
  endpoint: string;
  requestTimeoutMs?: number;
  fetchImpl?: MattermostFetch;
};

/** One `GET /users/me`, classified into the bot's own user id or a detail. */
export function createMattermostIdentityLookup(
  options: MattermostIdentityLookupOptions,
): MattermostIdentityLookup {
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (token: string): Promise<MattermostIdentityResult> => {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: "the configured access token is empty" };
    const base = options.endpoint.trim().replace(/\/+$/, "");
    if (!base) return { ok: false, error: "the configured endpoint is empty" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${base}/api/v4/users/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok) {
        return { ok: false, error: `the identity lookup answered HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const userId = isRecord(body) && typeof body.id === "string" ? body.id.trim() : "";
      if (!userId) return { ok: false, error: "the identity lookup returned no user id" };
      return { ok: true, userId };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error && error.name === "AbortError"
          ? "the identity lookup timed out"
          : "the identity lookup failed",
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
