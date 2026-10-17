import {
  MESSAGING_DISCORD_FORMAT,
  MESSAGING_DISCORD_FORMAT_VERSION,
  MESSAGING_DISCORD_SECTION,
  MESSAGING_MATTERMOST_FORMAT,
  MESSAGING_MATTERMOST_FORMAT_VERSION,
  MESSAGING_MATTERMOST_SECTION,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  MESSAGING_SLACK_SECTION,
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  MESSAGING_TELEGRAM_SECTION,
  MessagingRedactor,
  type Principal,
  type HostRpcPort,
} from "@pi-desktop/agent-host";
import type { AgentHost } from "@pi-desktop/agent-host";

import { requireHostRpc, type HostRpc } from "./host-ports.js";
import type { HostSettingsSurface, MessagingInboundWiringLog } from "./messaging-inbound-wiring.js";

/**
 * The production wiring for the outbound messaging relay (ADR 0205 D375 item 9,
 * rollout R3 §1): the composition roots subscribe the Host-side redactor here,
 * so the relay is no longer reachable by its own tests alone.
 *
 * R3 delivers "the integration adapter beside the Host, with no transport and
 * no inbound listener". Two halves make it up, and both are callers of existing
 * surfaces rather than new infrastructure:
 *
 * - the Host-side redactor, [`MessagingRedactor`] in `@pi-desktop/agent-host`,
 *   is a [`SubscriptionSink`] on the module's own host-scope event surface. For
 *   each forwarded kind it builds a summary of structure and metadata only and
 *   hands it to the durable delivery ledger with one `messaging.enqueue` call
 *   over the host's existing stdio JSON-RPC channel; and
 * - the durable ledger in host-core, which owns the delivery state machine:
 *   the attempt bound, the retry and backoff schedule, and the terminal
 *   `failed` state. `messaging.enqueue` writes through the adapter contract's
 *   existing hand-off, so nothing here retries, sleeps, or tracks a delivery.
 *
 * # What this module is
 *
 * Composition only. It reads the settings row the channels already read, and
 * for each channel the Host has a record for it subscribes one redactor on the
 * host-scope surface. No new store, namespace, operation verb, listener,
 * dependency, or timer is introduced: the subscription is the Host's public
 * `AgentHost.subscribe`, the enqueue rides the existing host-RPC port, and the
 * channel name it enqueues under is the one host-core registered the adapter
 * as, so a call to a channel with no adapter is refused there rather than
 * thought about here.
 *
 * # The config gate
 *
 * A channel is subscribed only when the Host has a record for it: the settings
 * row carries the channel's own section, and that section names the channel's
 * own `format` and `version`. The check is the one host-core's
 * `messaging_webhook::stored_record` / `messaging_telegram::stored_record` /
 * `messaging_slack::stored_record` make before registering an adapter, restated
 * here because the relay starts before the Host has registered anything and
 * must agree with it. With nothing configured, no subscription is created, no
 * `messaging.enqueue` is issued, and no Host call happens at all beyond the one
 * settings read: an install with no outbound channel configured behaves exactly
 * as it did before this wiring existed.
 *
 * Because the gate is read once, at start, a channel configured later takes
 * effect at the next Host start rather than mid-run. That is deliberate: this
 * module holds no loop, and the alternative — polling the settings row — would
 * add a timer and a second writer to a row the inbound wiring already writes.
 *
 * # Fail-safe
 *
 * Startup is not allowed to fail or to be held up by this wiring. The settings
 * read, each subscribe, and every later hand-off are all caught: a Host that is
 * not up yet, a subscription the Host refuses, a channel whose adapter was
 * never registered, and a refused hand-off each cost at most a log line. A
 * failure in the relay therefore cannot take the process down, cannot block
 * boot, and never delays a turn — the hand-off is fired asynchronously from the
 * publish loop by the redactor itself, which was built for exactly that.
 *
 * # While the note said otherwise
 *
 * The redactor's doc comment used to carry a removal condition: that the
 * subscription was reached by its tests only until the Host subscribed it. The
 * Host subscribes it now, from both composition roots — the desktop main
 * process (`electron/main/bootstrap/startup.ts`) and the headless entry point
 * (`apps/pi-host/src/app.ts`) — so that note is gone.
 */

/** The host-scope event surface the relay subscribes on, and releases. */
export type MessagingOutboundRelayHost = Pick<AgentHost, "subscribe" | "unsubscribe">;

/**
 * One outbound channel: the name host-core registers its adapter under, and the
 * settings section whose presence, `format` and `version` say the channel is
 * configured.
 *
 * Each descriptor mirrors the channel's own record in host-core — its
 * `SETTINGS_SECTION`, `FORMAT` and `FORMAT_VERSION`, and the registry name it
 * registers under (`CHANNEL`), which is also the ledger's channel. The Telegram,
 * Slack, Discord and Mattermost values are imported from the module that owns
 * them rather than restated; the webhook channel is host-core's alone
 * (`crates/host-core/src/messaging_webhook.rs`) and has no TypeScript home, so
 * its three strings are written out here beside its sibling's imports.
 */
export type MessagingOutboundChannel = {
  /** The registry name the ledger's channel takes; `messaging.enqueue` sends to it. */
  channel: string;
  /** The `app` settings section the channel's record lives under. */
  section: string;
  /** The record's self-identifying format. */
  format: string;
  /** The record version this build reads. */
  version: number;
};

/** Every outbound channel this build can relay to, in a fixed order. */
export const MESSAGING_OUTBOUND_CHANNELS: readonly MessagingOutboundChannel[] = [
  {
    channel: "webhook",
    section: "messagingWebhook",
    format: "pi-desktop-messaging-webhook",
    version: 1,
  },
  {
    channel: "telegram",
    section: MESSAGING_TELEGRAM_SECTION,
    format: MESSAGING_TELEGRAM_FORMAT,
    version: MESSAGING_TELEGRAM_FORMAT_VERSION,
  },
  {
    channel: "slack",
    section: MESSAGING_SLACK_SECTION,
    format: MESSAGING_SLACK_FORMAT,
    version: MESSAGING_SLACK_FORMAT_VERSION,
  },
  {
    channel: "discord",
    section: MESSAGING_DISCORD_SECTION,
    format: MESSAGING_DISCORD_FORMAT,
    version: MESSAGING_DISCORD_FORMAT_VERSION,
  },
  {
    channel: "mattermost",
    section: MESSAGING_MATTERMOST_SECTION,
    format: MESSAGING_MATTERMOST_FORMAT,
    version: MESSAGING_MATTERMOST_FORMAT_VERSION,
  },
];

/**
 * The principal the relay subscribes as. `events/subscribe` is a viewer
 * operation and host scope names no session, so the narrowest role is the whole
 * requirement — and the relay is a subscriber of the Host's other surface, not
 * a client of any session: it reads the host-scope stream and nothing else. The
 * subscription is held in the process that owns the AgentHost, so no credential
 * and no transport is involved.
 */
export const MESSAGING_OUTBOUND_RELAY_PRINCIPAL: Principal = {
  subject: "messaging",
  roles: ["viewer"],
};

export type MessagingOutboundRelayOptions = {
  /** The Agent Host whose host-scope surface the redactors subscribe on. */
  agentHost: MessagingOutboundRelayHost;
  /** The host settings surface the config gate reads. */
  settings: HostSettingsSurface;
  /** The host the ledger hand-off calls, exactly as the settings surface reaches it. */
  getHost: () => HostRpc | null;
  /** Where the relay's own records go; absent means the records are dropped. */
  log?: MessagingInboundWiringLog;
  /** Test seam: the channels to consider; defaults to every channel this build has. */
  channels?: readonly MessagingOutboundChannel[];
  /** Test seam: the principal to subscribe as; defaults to the relay's own. */
  principal?: Principal;
};

/**
 * A started relay and the release that stops it, held by the composition root
 * that owns it.
 *
 * `started` settles when the single start attempt has finished — subscriptions
 * in place, or the attempt refused and reported. Shutdown calls `stop()`, which
 * releases every subscription it took, and awaits `done` under the same bounded
 * budget the other messaging loops use. `stop()` is synchronous and cannot
 * throw, so shutdown never waits on it: `done` exists so the release is
 * observed on the shutdown path the same way the loops' `done` is.
 */
export type MessagingOutboundRelay = {
  /** The channels this relay subscribed, in order; empty when none is configured. */
  readonly subscribed: readonly string[];
  /** Settles once the start attempt finished; never rejects. */
  readonly started: Promise<void>;
  /** Release every subscription taken. Idempotent; never throws. */
  stop(): void;
  /** Settles once `stop` has released the subscriptions; never rejects. */
  readonly done: Promise<void>;
};

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the Host has a record for this channel, read exactly as host-core
 * reads it before registering the adapter: the section's presence, its `format`
 * and its `version`. A section that is absent, null, not an object, of another
 * format, or of a version this build does not read leaves the channel
 * unconfigured — the relay then does not subscribe it, and a Host with no
 * channel configured subscribes nothing at all.
 */
function isChannelConfigured(settings: unknown, channel: MessagingOutboundChannel): boolean {
  if (!isRecord(settings)) return false;
  const section = settings[channel.section];
  if (!isRecord(section)) return false;
  return section.format === channel.format && section.version === channel.version;
}

/**
 * Start the outbound relay over the surfaces the Host already owns, and return
 * the release that stops it.
 *
 * The start attempt is kicked off here and its promise is exposed as `started`;
 * nothing about it can reject, so a caller may ignore it. `stop()` releases
 * every subscription that was taken: one created after `stop()` ran — the
 * narrow window while the settings read is in flight — is released on the spot
 * rather than recorded, so a stop racing the start leaves no subscription
 * behind.
 */
export function createMessagingOutboundRelay(
  options: MessagingOutboundRelayOptions,
): MessagingOutboundRelay {
  const log = options.log;
  const channels = options.channels ?? MESSAGING_OUTBOUND_CHANNELS;
  const principal = options.principal ?? MESSAGING_OUTBOUND_RELAY_PRINCIPAL;
  const subscriptions: string[] = [];
  const subscribed: string[] = [];
  let stopped = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const release = (subscriptionId: string): void => {
    try {
      options.agentHost.unsubscribe(subscriptionId);
    } catch (error) {
      // A release that fails costs the subscription itself, never shutdown.
      log?.("warn", "outbound messaging relay could not unsubscribe", {
        error: detail(error),
      });
    }
  };

  const started = (async (): Promise<void> => {
    let settings: unknown;
    try {
      settings = await options.settings.read();
    } catch (error) {
      // An unreadable row reads as "nothing configured" — the same behaviour
      // an install with no channel has, and never a failed boot.
      log?.("warn", "outbound messaging relay could not read settings", {
        error: detail(error),
      });
      return;
    }
    const port: HostRpcPort = {
      // `async` on purpose: a host that is not up yet must be reported through
      // the hand-off's rejected promise, never thrown synchronously back into
      // the surface's publish loop.
      async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        return requireHostRpc(options.getHost).call<T>(method, params);
      },
    };
    for (const channel of channels) {
      if (!isChannelConfigured(settings, channel)) continue;
      const redactor = new MessagingRedactor(port, channel.channel, (error, envelope) => {
        // The hand-off is fire-and-forget: the ledger owns the retry, so a
        // refused call is recorded here and nothing else happens. Structure and
        // ids only — the redactor never hands over transcript content, and
        // neither does this record.
        log?.("warn", "outbound messaging hand-off failed", {
          channel: channel.channel,
          eventId: envelope.eventId,
          kind: envelope.kind,
          error: detail(error),
        });
      });
      let subscriptionId: string;
      try {
        const result = await options.agentHost.subscribe(principal, { scope: "host" }, redactor);
        subscriptionId = result.subscriptionId;
      } catch (error) {
        // A refused subscription costs this channel's deliveries, not the boot.
        log?.("warn", "outbound messaging relay could not subscribe", {
          channel: channel.channel,
          error: detail(error),
        });
        continue;
      }
      if (stopped) {
        // `stop()` ran while the subscribe was in flight: release at once so no
        // subscription outlives the root that owns it.
        release(subscriptionId);
        return;
      }
      subscriptions.push(subscriptionId);
      subscribed.push(channel.channel);
      log?.("info", "outbound messaging relay subscribed", { channel: channel.channel });
    }
  })();

  return {
    subscribed,
    started,
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const subscriptionId of subscriptions.splice(0)) release(subscriptionId);
      settle();
    },
    done,
  };
}
