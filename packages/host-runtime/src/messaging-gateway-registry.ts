/**
 * What the desktop main process knows about the inbound messaging loops it
 * started, and nothing more.
 *
 * The three state dimensions the Messaging platforms panel shows are derived
 * from three different kinds of evidence. Two of them come from the settings
 * row (`enabled`, `setup`); the third cannot, because "is the gateway running"
 * is a fact about this process, not about a stored record. Before this registry
 * the panel had no honest answer to it, and the page said so in prose: state was
 * "what the host starts on its next load, not whether a connection is live
 * right now".
 *
 * This module is the missing evidence. A composition root hands it the handle it
 * starts for a channel ([`MessagingInboundHandle`]); the registry reports the
 * channel as running until that loop settles. Nothing here probes the network,
 * opens a socket or reads settings: the loop's own lifetime is the signal.
 *
 * It lives beside the supervisor that owns those loops
 * ([`MessagingInboundSupervisor`]) rather than in the desktop main process, so
 * the pair can be exercised by the same tests. The desktop keeps one instance
 * (`electron/main/messaging-gateway.ts`) because the composition root that
 * starts the loops and the IPC handler that answers the renderer must share it.
 *
 * `booted` records whether host-core and the Agent Host came up at all. With them
 * down no loop can exist, and a panel should say "the gateway is not running"
 * rather than blame the channel's configuration.
 */

/** The channels with an inbound loop in this build. */
export type MessagingGatewayChannel =
  | "telegram"
  | "slack"
  | "discord"
  | "mattermost"
  | "matrix"
  | "irc"
  | "homeAssistant"
  | "ntfy"
  | "email"
  | "signal";

/** The answer the renderer reads. */
export type MessagingGatewaySnapshot = {
  booted: boolean;
  telegram: boolean;
  slack: boolean;
  discord: boolean;
  mattermost: boolean;
  matrix: boolean;
  irc: boolean;
  homeAssistant: boolean;
  ntfy: boolean;
  email: boolean;
  signal: boolean;
};

/** The part of a started loop this registry needs: its lifetime. */
export type MessagingGatewayHandle = {
  readonly done: Promise<void>;
};

/**
 * The two writes the supervisor needs. [`MessagingGatewayRegistry`] is the
 * production implementation; a test can supply the same two methods and read
 * its own record.
 */
export type MessagingGatewayPort = {
  track(channel: MessagingGatewayChannel, handle: MessagingGatewayHandle | null | undefined): void;
  untrack(channel: MessagingGatewayChannel): void;
};

/**
 * Tracks which channel loops are alive.
 *
 * A handle is registered when its loop starts and removed when its `done`
 * resolves — which the loops do on shutdown, and which a transport that starts
 * nothing does immediately, because it returns without opening a connection. A
 * settled loop is therefore reported as stopped for the right reason in both
 * cases, and a channel that was never started is indistinguishable from one
 * whose loop has finished, which is what the panel wants to say.
 */
export class MessagingGatewayRegistry implements MessagingGatewayPort {
  private booted = false;
  private readonly running = new Set<MessagingGatewayChannel>();

  /** Record that host-core and the Agent Host came up. Idempotent. */
  markBooted(): void {
    this.booted = true;
  }

  /**
   * Register a channel's loop. A `null`/`undefined` handle means the
   * composition root did not start one, which leaves the channel stopped.
   *
   * The removal is attached to the loop's own promise, so it happens whether the
   * loop ends normally or by abort; a rejection is swallowed here because the
   * loop's own caller owns its failures.
   */
  track(channel: MessagingGatewayChannel, handle: MessagingGatewayHandle | null | undefined): void {
    if (!handle) return;
    this.running.add(channel);
    void handle.done.then(
      () => this.running.delete(channel),
      () => this.running.delete(channel),
    );
  }

  /**
   * Drop a channel's running mark. Called by the supervisor once it has
   * observed the loop settle, so the flag falls at the moment the loop stops
   * rather than whenever the settled promise happens to be observed.
   */
  untrack(channel: MessagingGatewayChannel): void {
    this.running.delete(channel);
  }

  snapshot(): MessagingGatewaySnapshot {
    return {
      booted: this.booted,
      telegram: this.running.has("telegram"),
      slack: this.running.has("slack"),
      discord: this.running.has("discord"),
      mattermost: this.running.has("mattermost"),
      matrix: this.running.has("matrix"),
      irc: this.running.has("irc"),
      homeAssistant: this.running.has("homeAssistant"),
      ntfy: this.running.has("ntfy"),
      email: this.running.has("email"),
      signal: this.running.has("signal"),
    };
  }
}
