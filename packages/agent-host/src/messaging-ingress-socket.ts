/**
 * The socket transport: one long-lived connection the Host opens, reconnected
 * with one backoff policy, serving frames to a client that is only responsible
 * for its platform's framing.
 *
 * Discord, Mattermost and Slack's Socket Mode all have the same shape — open a
 * connection, serve frames until it closes, wait, reconnect — and each carried
 * its own copy of that loop, its own close-waiter bookkeeping, and its own
 * `finishClose`/`send` plumbing. This module holds the one copy.
 *
 * # Two pieces, split by ownership
 *
 * [`SocketIngressClient`] owns the *connection lifecycle*: attach one socket,
 * track whether it is ready and whether it has closed, wake every waiter on
 * close, and send a frame without throwing when the socket is already gone. A
 * platform subclass supplies only `connect` (its handshake) and `handleFrame`
 * (its framing).
 *
 * [`createSocketIngressTransport`] owns the *reconnect discipline*: one client
 * per attempt, wait for its close, close it, and wait the shared jittered
 * exponential delay before the next attempt. A connection whose handshake was
 * accepted resets the backoff, so a healthy channel reconnects at the base delay
 * while a refused credential escalates to the cap.
 *
 * A reconnect cannot duplicate a subscription: each attempt attaches exactly one
 * socket and one frame handler, and the previous one is closed before the delay
 * begins. A redelivery the platform makes across the reconnect is caught by the
 * durable guard the client's gate consults, not by the transport.
 */

import {
  ingressAudit,
  ingressErrorMessage,
  ingressReconnectDelayMs,
  INGRESS_MAX_RECONNECT_DELAY_MS,
  INGRESS_MIN_RECONNECT_DELAY_MS,
  type IngressAudit,
  type IngressMessage,
  type MessagingIngressClient,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";

/**
 * The minimal WebSocket client surface every socket client uses, so a client can
 * be driven by a fake. A production implementation wraps `ws`; the shape is
 * deliberately small — send a frame, close, and three event subscriptions.
 */
export interface IngressSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** Opens a socket to a URL; injected so a suite needs no socket. */
export type IngressSocketFactory = (url: string) => IngressSocket;

export type SocketIngressClientOptions = {
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
};

/**
 * The shared connection lifecycle for a socket channel.
 *
 * A subclass implements `connect` (credential check, handshake, then
 * [`attach`]) and `handleFrame` (its own framing). Everything a connection
 * needs afterwards — readiness, close waiters, `send` that tolerates a dead
 * socket — is here, so three channels cannot disagree about what a close means
 * or forget to wake a waiter.
 */
export abstract class SocketIngressClient implements MessagingIngressClient {
  private socket: IngressSocket | null = null;
  private ready = false;
  private closed = true;
  private closeWaiters: Array<() => void> = [];
  protected readonly audit: IngressAudit;

  constructor(options: SocketIngressClientOptions = {}) {
    this.audit = ingressAudit(options.audit);
  }

  /** Whether a ready frame (or an accepted handshake) has been seen. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Whether a socket is currently attached and not yet closed. */
  protected get hasConnection(): boolean {
    return !this.closed && this.socket !== null;
  }

  /** Open one connection. A refusal is audited by the subclass and thrown. */
  abstract connect(): Promise<void>;

  /** Route one raw frame. The subclass owns its platform's envelope shapes. */
  abstract handleFrame(raw: string): Promise<void>;

  /**
   * Adopt a freshly opened socket and wire its three events.
   *
   * An `error` is normally followed by a `close`; if it is not, the wait must end
   * anyway or the reconnect loop would sit in [`waitForClose`] until abort, so
   * the error ends the wait as well and the following close is a no-op.
   */
  protected attach(socket: IngressSocket): void {
    this.socket = socket;
    this.closed = false;
    this.ready = false;
    socket.onMessage((data) => {
      void this.handleFrame(data);
    });
    socket.onClose((code, reason) => {
      this.finishClose(reason ?? (code !== undefined ? `closed (${code})` : "closed"));
    });
    socket.onError((error) => {
      this.audit({ kind: "connect-failed", error: ingressErrorMessage(error) });
      this.finishClose(ingressErrorMessage(error));
    });
  }

  /** Mark the connection ready once the platform's handshake frame arrived. */
  protected markReady(): void {
    this.ready = true;
  }

  /** Resolves once the current socket closes, or `signal` aborts. */
  waitForClose(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.socket === null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.closeWaiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Close the socket; the next `connect` is a fresh connection. */
  close(): void {
    this.finishClose("closed by the caller");
  }

  /** A hook for state that must be torn down with the connection. */
  protected onDisconnect(): void {}

  protected finishClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.onDisconnect();
    this.audit({ kind: "disconnect", reason });
    try {
      this.socket?.close();
    } catch {
      // A socket that throws on close is already gone; there is nothing to do.
    }
    this.socket = null;
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Send one frame; a dead socket is not an error, its close drives reconnect. */
  protected send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // The socket is gone; the close handler drives the reconnect.
    }
  }
}

export type SocketIngressTransportOptions = {
  /** The first reconnect delay; the loop doubles it per failure up to the cap. */
  reconnectDelayMs?: number;
  /** The most the loop waits between attempts, however many have failed. */
  maxReconnectDelayMs?: number;
  /** How the loop waits; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
};

/** A push transport: the driver hands it the one handler its routing path uses. */
export interface SocketIngressTransport {
  start(onMessage: (message: IngressMessage) => Promise<void>, signal?: AbortSignal): Promise<void>;
}

/**
 * The production socket transport: open a connection, serve it, reconnect until
 * `signal` aborts.
 *
 * The driver hands `start` the one handler its routing path uses, and the client
 * binds it as its message handler, so every platform's message goes through the
 * same routing path and no second one exists. A refused handshake, a socket
 * error and a platform `disconnect` all leave the loop to wait and reconnect, so
 * an unreachable platform can neither take the Host down nor spin the CPU.
 */
export function createSocketIngressTransport(
  adapter: SocketIngressAdapter,
  options: SocketIngressTransportOptions = {},
): SocketIngressTransport {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = Math.max(
    INGRESS_MIN_RECONNECT_DELAY_MS,
    options.reconnectDelayMs ?? INGRESS_MIN_RECONNECT_DELAY_MS,
  );
  const max = Math.max(base, options.maxReconnectDelayMs ?? INGRESS_MAX_RECONNECT_DELAY_MS);
  return {
    async start(onMessage, signal) {
      let failures = 0;
      while (!signal?.aborted) {
        const client = adapter.openClient(onMessage);
        let established = false;
        try {
          await client.connect();
          established = true;
          await client.waitForClose(signal);
        } catch {
          // A refused handshake or a failed connect: fall through to the wait and
          // try again. The client already audited the reason.
        } finally {
          client.close();
        }
        if (signal?.aborted) break;
        // A connection whose handshake was accepted is not the failure loop a bad
        // credential is, so it resets the back-off to the base delay.
        if (established) failures = 0;
        await wait(ingressReconnectDelayMs(failures, base, max));
        if (!established) failures += 1;
      }
    },
  };
}
