import { WebSocket } from "ws";

import {
  SLACK_CONNECTIONS_OPEN_METHOD,
  type SlackOpenConnection,
  type SlackSocket,
  type SlackSocketFactory,
} from "./messaging-slack-inbound.js";

/**
 * The production Socket Mode seams (ADR 0326): the `apps.connections.open`
 * call and the `ws`-backed WebSocket client the inbound Slack channel needs.
 *
 * They are separated from the client logic so the client's tests never import
 * `ws` and never open a socket — the suite drives the client through the
 * injected [`SlackOpenConnection`] and [`SlackSocketFactory`] doubles instead.
 *
 * The app-level token travels only in the `Authorization` header to the
 * endpoint the user configured, and it never appears in a returned error, so a
 * failure detail cannot leak it.
 */

/** The host's own fetch, injected so tests and alternate runtimes can drive it. */
export type SlackFetch = typeof fetch;

export type SlackOpenConnectionOptions = {
  /** The API base, e.g. `https://slack.com`; the method is appended. */
  endpoint: string;
  /** How long the handshake request may take, in milliseconds. */
  requestTimeoutMs?: number;
  /** The fetch implementation; defaults to the runtime's global `fetch`. */
  fetchImpl?: SlackFetch;
};

/** The default handshake timeout, small because the call is a single round trip. */
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The production `apps.connections.open` call: one POST, classified into the
 * connection URL or a failure detail. The token is placed in the
 * `Authorization` header and is never echoed into a returned error.
 */
export function createSlackOpenConnection(options: SlackOpenConnectionOptions): SlackOpenConnection {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  return async (appToken: string) => {
    const token = appToken.trim();
    if (!token) return { ok: false, error: "the configured app-level token is empty" };
    let url: URL;
    try {
      url = new URL(`${options.endpoint.replace(/\/+$/, "")}/api/${SLACK_CONNECTIONS_OPEN_METHOD}`);
    } catch {
      return { ok: false, error: "the configured Slack endpoint is not a URL" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "the Slack endpoint must use HTTPS" };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, error: `the handshake answered a redirect (HTTP ${response.status})` };
      }
      if (!response.ok) return { ok: false, error: `the handshake answered HTTP ${response.status}` };
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || body.ok !== true) {
        const detail = isRecord(body) && typeof body.error === "string" ? body.error : "an unspecified error";
        return { ok: false, error: `the handshake was refused: ${detail}` };
      }
      const connectionUrl = typeof body.url === "string" ? body.url.trim() : "";
      if (!connectionUrl) return { ok: false, error: "the handshake returned no connection URL" };
      return { ok: true, url: connectionUrl };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "the handshake failed" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The production WebSocket client: a thin wrapper turning a `ws` instance into
 * the minimal [`SlackSocket`] the client uses. Binary frames are refused by
 * closing the socket — Socket Mode is JSON text only.
 */
export function createWsSlackSocketFactory(): SlackSocketFactory {
  return (url: string): SlackSocket => {
    const socket = new WebSocket(url);
    return {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      onMessage: (handler) => {
        socket.on("message", (data, isBinary) => {
          if (isBinary) {
            socket.close(1003, "binary frames are not accepted");
            return;
          }
          handler(typeof data === "string" ? data : data.toString("utf8"));
        });
      },
      onClose: (handler) => {
        socket.on("close", (code, reason) => handler(code, reason.toString("utf8")));
      },
      onError: (handler) => {
        socket.on("error", handler);
      },
    };
  };
}
