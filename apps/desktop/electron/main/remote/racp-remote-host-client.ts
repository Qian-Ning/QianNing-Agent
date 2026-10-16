/**
 * RACP-WS-backed {@link RemoteHostClient}: adapts the single-callback
 * `RacpClient.onEvent` seam into the multi-listener `subscribe()` shape
 * `RemoteHostConnection` consumes. This is the only file in
 * `electron/main/remote/` that speaks the `@pi-desktop/racp` protocol
 * package; everything above it is transport-agnostic.
 *
 * Ownership stays inside Electron Main. The transport factory is injected —
 * production wires it to {@link wsClientTransport} against a paired host, and
 * tests wire it to the in-memory `MemoryLink` from
 * `packages/racp/src/test-harness.ts` so the adapter exercises the real
 * `RacpClient` state machine without a socket.
 */
import {
  RacpClient,
  wsClientTransport,
  type ClientTransportFactory,
  type RacpClientState,
} from "@pi-desktop/racp";
import { ErrorCodes, type RacpEventEnvelope, type RemoteHostLinkState } from "@pi-desktop/shared";
import type { RemoteHostClient } from "./remote-host-connection.js";

export type PairingExchangeOptions = {
  /** Loopback RACP endpoint, either pasted by the user or forwarded by us. */
  url: string;
  /** Single-use `ppt1.` token the host printed at start. */
  pairingToken: string;
  /** Device label the host records against the minted device. */
  label: string;
  clientInfo: { name: string; version: string };
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/**
 * Spend a single-use pairing token on a throwaway connection and return the
 * durable `pdt1.` device token the host minted (spec §3.4).
 *
 * The connection is closed on every path — success, refusal, and transport
 * failure — because the token is consumed by the exchange and a lingering
 * unprivileged socket would only keep a half-paired session open.
 */
export async function exchangePairingToken(options: PairingExchangeOptions): Promise<string> {
  const pairing = createRacpRemoteHostClient({
    transport: wsClientTransport({ url: options.url, token: options.pairingToken }),
    clientInfo: options.clientInfo,
    log: options.log,
  });
  try {
    await pairing.connect();
    const result = (await pairing.client.request("connection/pair", {
      deviceLabel: options.label,
    })) as { deviceToken?: unknown };
    if (typeof result?.deviceToken !== "string" || result.deviceToken.length === 0) {
      throw Object.assign(new Error("pi-host did not return a device token"), {
        errorCode: ErrorCodes.PAIRING_FAILED,
      });
    }
    return result.deviceToken;
  } finally {
    await pairing.close().catch(() => undefined);
  }
}

export type RacpRemoteHostClientOptions = {
  transport: ClientTransportFactory;
  /** Identity sent in `connection/initialize`; the host records it as the device label. */
  clientInfo: { name: string; version: string };
  /** Deadline for a single request; the RACP default of 15s is used when omitted. */
  requestTimeoutMs?: number;
  /** Reconnect policy; the RACP client stays disconnected when omitted. */
  reconnect?: {
    enabled: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  /**
   * Answers a server-initiated request (`tool/execute`, and later the approval
   * and input requests). Returning `undefined` — the shape the reverse-tool-relay
   * handler uses for a method it does not own — is answered with
   * `METHOD_NOT_FOUND`, as the client core does when no handler is wired at all.
   */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown> | undefined;
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type RacpRemoteHostClient = {
  /** The multi-listener {@link RemoteHostClient} the connection module consumes. */
  readonly client: RemoteHostClient;
  /** Underlying RACP client state, for boot diagnostics and the future host card. */
  readonly state: () => RacpClientState;
  /** Open the transport and initialize the RACP session. */
  connect(): Promise<void>;
  /** Close the transport; safe to call before {@link connect} and after failure. */
  close(): Promise<void>;
};

/** RacpClient states mapped onto the renderer-visible link vocabulary. */
function toLinkState(state: RacpClientState): RemoteHostLinkState {
  switch (state) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "error":
      return "failed";
    default:
      return "disconnected";
  }
}

/**
 * The adapter multiplexes {@link RacpClient.onEvent} — a single-slot callback
 * — into the `subscribe()` API {@link RemoteHostConnection} expects. Fan-out
 * is intentional: Stage 5 (terminal) and Stage 3b (resync watchdog) will
 * attach their own listeners on the same client.
 */
export function createRacpRemoteHostClient(
  options: RacpRemoteHostClientOptions,
): RacpRemoteHostClient {
  const listeners = new Set<(envelope: RacpEventEnvelope) => void>();
  // Fan-out for the two lifecycle seams the connection layer needs:
  // `subscribeReconnected` (re-subscribe + re-attach after the transport comes
  // back) and `subscribeState` (surface connecting/reconnecting/failed to the
  // UI). Both are per-listener, mirroring `subscribe`, so Stage 3b's resync
  // watchdog does not have to share a single callback with the event bridge.
  const reconnectedListeners = new Set<() => void>();
  const stateListeners = new Set<(state: RemoteHostLinkState) => void>();
  const racp = new RacpClient({
    transport: options.transport,
    client: options.clientInfo,
    onEvent: (envelope) => {
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch (error) {
          options.log?.("warn", "remote event listener threw", { error: String(error) });
        }
      }
    },
    onReconnected: () => {
      for (const listener of reconnectedListeners) {
        try {
          listener();
        } catch (error) {
          options.log?.("warn", "remote reconnect listener threw", { error: String(error) });
        }
      }
    },
    onStateChange: (state) => {
      const link = toLinkState(state);
      for (const listener of stateListeners) {
        try {
          listener(link);
        } catch (error) {
          options.log?.("warn", "remote state listener threw", { error: String(error) });
        }
      }
    },
    ...(options.onServerRequest
      ? {
          onServerRequest: async (method: string, params: unknown) => {
            const answered = await options.onServerRequest!(method, params);
            if (answered === undefined) {
              throw Object.assign(new Error(`${method} is not handled by this client`), {
                errorCode: "METHOD_NOT_FOUND",
              });
            }
            return answered;
          },
        }
      : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const client: RemoteHostClient = {
    request: (method, params) => racp.request(method, params),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeReconnected(listener) {
      reconnectedListeners.add(listener);
      return () => {
        reconnectedListeners.delete(listener);
      };
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    // The durable cursors the RACP client already tracks per session (and for
    // the host stream) — the resync path re-subscribes from these so a
    // reconnect replays the gap instead of the whole history.
    cursorFor: (sessionId) => racp.cursorFor(sessionId),
    cursorForHost: () => racp.cursorForHost(),
  };
  return {
    client,
    state: () => racp.state,
    async connect() {
      await racp.connect();
    },
    async close() {
      await racp.close();
    },
  };
}
