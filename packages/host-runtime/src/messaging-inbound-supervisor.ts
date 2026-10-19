/**
 * Who starts a channel's inbound loop, and who stops it when the channel's
 * record stops being startable.
 *
 * # The defect this exists to close
 *
 * Every composition root started its inbound loops once, at boot, and handed
 * their `AbortController`s to shutdown. Nothing else could stop one. The
 * channel's settings section is replaced whole on every save, and a channel is
 * turned off by clearing it (`settings.set { section: null }`), so a record
 * could be removed — or replaced with one the transport can no longer start
 * from — while the loop that record configured kept running. The panel then
 * showed `启用 = 已关闭` beside `网关 = 运行中`, which should be impossible: the
 * first is derived from "there is no saved record", the second from "a loop is
 * alive". A push channel in that state still holds the socket and the
 * credential it started with, so it can keep receiving messages for a channel
 * the person believes they disabled.
 *
 * # The rule
 *
 * A loop runs only while its channel's record says it can. `reconcileAll` is
 * the invariant, not a command: it reads each channel's record, starts the
 * loops whose channel is startable and not running, and stops the loops whose
 * channel is no longer startable. `reconcile(channel)` is the targeted form the
 * settings write path calls, because a replaced record must be re-read by the
 * transport (each push transport reads its record once, at start).
 *
 * Readiness is the transport's own start gate, expressed once:
 * [`MESSAGING_INBOUND_START_GATES`] mirrors the fields and secrets each
 * `createConfigured…Transport` refuses to start without. A transport still
 * gates itself — that gate is the enforcement, this one is the decision — so a
 * gap between the two starts nothing rather than opening something.
 *
 * # What it deliberately does not do
 *
 * - It never reports a channel stopped before the loop stopped. A stop that does
 *   not settle within its budget leaves the channel marked running, because it
 *   is: the loop ignored its abort, and saying otherwise is the same lie the
 *   registry was built to end.
 * - It never runs two loops for one channel. A channel whose stop did not settle
 *   is not restarted.
 * - It leaves a channel alone when readiness cannot be determined (a settings
 *   read that failed), rather than stopping a working loop on a transient error.
 *
 * The gateway flag the renderer reads is this module's evidence: the loop is
 * untracked the moment it is observed to have stopped, so `enabled = off`
 * cannot sit beside `gateway = running` for a loop that is genuinely gone.
 */

import {
  MESSAGING_API_SERVER_FORMAT,
  MESSAGING_API_SERVER_FORMAT_VERSION,
  MESSAGING_API_SERVER_SECTION,
  MESSAGING_API_SERVER_TOKEN_SECRET_REF,
  MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF,
  MESSAGING_DISCORD_FORMAT,
  MESSAGING_DISCORD_FORMAT_VERSION,
  MESSAGING_DISCORD_SECTION,
  MESSAGING_EMAIL_FORMAT,
  MESSAGING_EMAIL_FORMAT_VERSION,
  MESSAGING_EMAIL_PASSWORD_SECRET_REF,
  MESSAGING_EMAIL_SECTION,
  MESSAGING_HOME_ASSISTANT_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_HOME_ASSISTANT_FORMAT,
  MESSAGING_HOME_ASSISTANT_FORMAT_VERSION,
  MESSAGING_HOME_ASSISTANT_SECTION,
  MESSAGING_IRC_FORMAT,
  MESSAGING_IRC_FORMAT_VERSION,
  MESSAGING_IRC_SECTION,
  MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATTERMOST_FORMAT,
  MESSAGING_MATTERMOST_FORMAT_VERSION,
  MESSAGING_MATTERMOST_SECTION,
  MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATRIX_FORMAT,
  MESSAGING_MATRIX_FORMAT_VERSION,
  MESSAGING_MATRIX_SECTION,
  MESSAGING_NTFY_FORMAT,
  MESSAGING_NTFY_FORMAT_VERSION,
  MESSAGING_NTFY_SECTION,
  MESSAGING_SLACK_APP_TOKEN_SECRET_REF,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  MESSAGING_SLACK_SECTION,
  MESSAGING_SIGNAL_FORMAT,
  MESSAGING_SIGNAL_FORMAT_VERSION,
  MESSAGING_SIGNAL_SECTION,
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  MESSAGING_TELEGRAM_SECTION,
} from "@pi-desktop/agent-host";

import type { MessagingGatewayChannel } from "./messaging-gateway-registry.js";
import {
  MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF,
  type HostSecretReader,
  type HostSettingsSurface,
  type MessagingInboundWiringLog,
} from "./messaging-inbound-wiring.js";

/**
 * How long a stop waits for the loop to leave `run` before giving up and
 * reporting it still running. The same order as the quit path's budget: one
 * in-flight iteration is one host RPC, and a settings save must not hang on it.
 */
export const MESSAGING_INBOUND_STOP_BUDGET_MS = 2_000;

/**
 * What a channel's record must carry before its loop may start, expressed as
 * the transport's own gate.
 *
 * `fields` are the record's own required values (the ones each
 * `createConfigured…Transport` refuses to open without); `secrets` are the
 * credential refs it reads and cannot start without. Credentials a transport
 * treats as optional are absent from `secrets` — a public ntfy topic and an
 * open IRC server are startable without one, and stopping those loops because
 * no password was stored would break them.
 */
export type MessagingInboundStartGate = {
  /** The settings section the channel's record lives in. */
  readonly section: string;
  /** The record's self-identifying format and version. */
  readonly format: string;
  readonly version: number;
  /** Record values the transport's start gate requires to be non-empty. */
  readonly fields: readonly string[];
  /** Secret refs the transport's start gate requires a value for. */
  readonly secrets: readonly string[];
};

/**
 * One row per channel with an inbound loop, mirroring the transport each row's
 * starter builds.
 *
 * Telegram is the exception that proves the rule: its poll transport re-reads
 * the record every iteration and idles when it cannot, so an unstartable record
 * never opened anything — but the loop itself still ran, which is exactly the
 * `off`/`running` pair this table now prevents.
 */
export const MESSAGING_INBOUND_START_GATES: Record<MessagingGatewayChannel, MessagingInboundStartGate> = {
  telegram: {
    section: MESSAGING_TELEGRAM_SECTION,
    format: MESSAGING_TELEGRAM_FORMAT,
    version: MESSAGING_TELEGRAM_FORMAT_VERSION,
    fields: ["endpoint"],
    secrets: [MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF],
  },
  // Socket Mode opens against Slack's own API base, so the record names no
  // endpoint; the app-level token is the whole gate.
  slack: {
    section: MESSAGING_SLACK_SECTION,
    format: MESSAGING_SLACK_FORMAT,
    version: MESSAGING_SLACK_FORMAT_VERSION,
    fields: [],
    secrets: [MESSAGING_SLACK_APP_TOKEN_SECRET_REF],
  },
  discord: {
    section: MESSAGING_DISCORD_SECTION,
    format: MESSAGING_DISCORD_FORMAT,
    version: MESSAGING_DISCORD_FORMAT_VERSION,
    fields: ["destination"],
    secrets: [MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF],
  },
  mattermost: {
    section: MESSAGING_MATTERMOST_SECTION,
    format: MESSAGING_MATTERMOST_FORMAT,
    version: MESSAGING_MATTERMOST_FORMAT_VERSION,
    fields: ["endpoint", "destination"],
    secrets: [MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF],
  },
  matrix: {
    section: MESSAGING_MATRIX_SECTION,
    format: MESSAGING_MATRIX_FORMAT,
    version: MESSAGING_MATRIX_FORMAT_VERSION,
    fields: ["endpoint", "destination"],
    secrets: [MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF],
  },
  irc: {
    section: MESSAGING_IRC_SECTION,
    format: MESSAGING_IRC_FORMAT,
    version: MESSAGING_IRC_FORMAT_VERSION,
    fields: ["endpoint", "destination", "nick"],
    secrets: [],
  },
  homeAssistant: {
    section: MESSAGING_HOME_ASSISTANT_SECTION,
    format: MESSAGING_HOME_ASSISTANT_FORMAT,
    version: MESSAGING_HOME_ASSISTANT_FORMAT_VERSION,
    fields: ["endpoint", "destination"],
    secrets: [MESSAGING_HOME_ASSISTANT_ACCESS_TOKEN_SECRET_REF],
  },
  ntfy: {
    section: MESSAGING_NTFY_SECTION,
    format: MESSAGING_NTFY_FORMAT,
    version: MESSAGING_NTFY_FORMAT_VERSION,
    fields: ["endpoint", "destination"],
    secrets: [],
  },
  email: {
    section: MESSAGING_EMAIL_SECTION,
    format: MESSAGING_EMAIL_FORMAT,
    version: MESSAGING_EMAIL_FORMAT_VERSION,
    // The allowlist is required, not a convenience: without it the mailbox is
    // reachable by anyone, which is why the email transport refuses to start.
    fields: ["imapHost", "smtpHost", "username", "allowedSenders"],
    secrets: [MESSAGING_EMAIL_PASSWORD_SECRET_REF],
  },
  // Signal is a bridge the user runs, so the account and its address are the
  // record's two required values. The bridge token is optional: a listener on
  // loopback normally has none, and requiring one would keep a working channel
  // from starting.
  signal: {
    section: MESSAGING_SIGNAL_SECTION,
    format: MESSAGING_SIGNAL_FORMAT,
    version: MESSAGING_SIGNAL_FORMAT_VERSION,
    fields: ["endpoint", "account"],
    secrets: [],
  },
  // The local API channel's record must name a port and its token must exist,
  // because the transport refuses to bind without either. The record's linked
  // identity and its bound session are checked by the transport itself: they
  // live inside `inbound`, which this table reads only as a top-level field.
  apiServer: {
    section: MESSAGING_API_SERVER_SECTION,
    format: MESSAGING_API_SERVER_FORMAT,
    version: MESSAGING_API_SERVER_FORMAT_VERSION,
    fields: ["port"],
    secrets: [MESSAGING_API_SERVER_TOKEN_SECRET_REF],
  },
};

/** The channel whose record lives in `section`, or `null` for a non-channel. */
export function messagingChannelForSection(section: string): MessagingGatewayChannel | null {
  for (const [channel, gate] of Object.entries(MESSAGING_INBOUND_START_GATES)) {
    if (gate.section === section) return channel as MessagingGatewayChannel;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a required record value is present: non-blank string, non-empty list, finite number. */
function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/**
 * Why a channel's record does not start, or that it does.
 *
 * `absent` is the panel's `启用 = 已关闭`; `foreign` is its `无法读取`; the two
 * both mean no loop. `incomplete` is a record that is this build's own but
 * missing something its transport cannot start without. Only `ready` may start
 * a loop.
 */
export type MessagingInboundRecordState = "absent" | "foreign" | "incomplete" | "ready";

/**
 * Read one channel's record out of a settings snapshot.
 *
 * Pure, so a start decision costs one settings read for all nine channels and
 * can be asserted directly by a test.
 */
export function readMessagingInboundRecordState(
  channel: MessagingGatewayChannel,
  settings: unknown,
): MessagingInboundRecordState {
  const gate = MESSAGING_INBOUND_START_GATES[channel];
  const section = isRecord(settings) ? settings[gate.section] : null;
  if (!isRecord(section)) return "absent";
  if (section.format !== gate.format || section.version !== gate.version) return "foreign";
  if (!gate.fields.every((field) => hasValue(section[field]))) return "incomplete";
  return "ready";
}

/**
 * Whether a channel's record plus its stored credentials say its loop can run.
 *
 * `null` means "cannot tell" — a settings or secret read failed — and every
 * caller treats that as "leave the loop as it is": a transient host RPC failure
 * must not stop a working channel.
 */
export type MessagingInboundReadiness = (
  channel: MessagingGatewayChannel,
) => Promise<boolean | null>;

export function createMessagingInboundReadiness(options: {
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
}): MessagingInboundReadiness {
  return async (channel) => {
    let settings: unknown;
    try {
      settings = await options.settings.read();
    } catch {
      return null;
    }
    const gate = MESSAGING_INBOUND_START_GATES[channel];
    if (readMessagingInboundRecordState(channel, settings) !== "ready") return false;
    for (const secretRef of gate.secrets) {
      let value: string | null;
      try {
        value = await options.secrets(secretRef);
      } catch {
        return null;
      }
      if (value === null || value.trim() === "") return false;
    }
    return true;
  };
}

/** What a composition root's channel factory returns: a loop, ready to run. */
export type MessagingInboundStarter = (signal: AbortSignal) => { run(): Promise<void> };

export type MessagingInboundSupervisorOptions = {
  /** One factory per channel this composition root can start. */
  starters: Partial<Record<MessagingGatewayChannel, MessagingInboundStarter>>;
  readiness: MessagingInboundReadiness;
  /** The registry the renderer's "is the gateway running" answer reads. */
  gateway: {
    track(channel: MessagingGatewayChannel, handle: { readonly done: Promise<void> } | null | undefined): void;
    untrack(channel: MessagingGatewayChannel): void;
  };
  /** Overridable for tests; defaults to [`MESSAGING_INBOUND_STOP_BUDGET_MS`]. */
  stopBudgetMs?: number;
  log?: MessagingInboundWiringLog;
};

type RunningLoop = { readonly controller: AbortController; readonly done: Promise<void> };

/**
 * Wait for `work` to settle, and say whether it did within `budgetMs`.
 *
 * Unlike [`settleWithinBudget`] the answer is the point: a loop that did not
 * stop must not be reported stopped, nor replaced by a second one.
 */
function settlesWithin(work: Promise<void>, budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, budgetMs));
    work.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/**
 * Owns every inbound loop this process started: start, stop, and the reconcile
 * that keeps the two in step with the saved records.
 */
export class MessagingInboundSupervisor {
  private readonly options: MessagingInboundSupervisorOptions;
  private readonly running = new Map<MessagingGatewayChannel, RunningLoop>();
  /** The serialisation chain every lifecycle change is appended to. */
  private tail: Promise<void> = Promise.resolve();
  /** The channels this root can start, in gate-table order. */
  readonly channels: readonly MessagingGatewayChannel[];

  constructor(options: MessagingInboundSupervisorOptions) {
    this.options = options;
    this.channels = Object.keys(MESSAGING_INBOUND_START_GATES).filter(
      (channel): channel is MessagingGatewayChannel =>
        options.starters[channel as MessagingGatewayChannel] !== undefined,
    );
  }

  /** Whether this supervisor currently holds a loop for the channel. */
  isRunning(channel: MessagingGatewayChannel): boolean {
    return this.running.has(channel);
  }

  /**
   * Start a channel's loop if its record is startable and no loop is running.
   * Resolves once the loop has been launched, not when it ends.
   */
  start(channel: MessagingGatewayChannel): Promise<void> {
    return this.serialize(() => this.startNow(channel));
  }

  /**
   * Stop a channel's loop and wait, bounded, for it to leave `run`.
   *
   * Resolves `true` when no loop is left for that channel — including when none
   * was running — and `false` when the loop ignored its abort and is still
   * alive. The gateway mark is dropped only in the `true` case, so the flag
   * never claims a stopped loop while one is still running, and never keeps
   * claiming one after it has gone.
   */
  stop(channel: MessagingGatewayChannel): Promise<boolean> {
    return this.serialize(() => this.stopNow(channel));
  }

  private async stopNow(channel: MessagingGatewayChannel): Promise<boolean> {
    const loop = this.running.get(channel);
    if (!loop) {
      // Nothing of ours is running. Clear the mark anyway: it can only be stale
      // from a loop this supervisor already saw settle.
      this.options.gateway.untrack(channel);
      return true;
    }
    loop.controller.abort();
    const stopped = await settlesWithin(
      loop.done,
      this.options.stopBudgetMs ?? MESSAGING_INBOUND_STOP_BUDGET_MS,
    );
    if (!stopped) {
      this.options.log?.("warn", "inbound messaging loop did not stop within its budget", {
        channel,
      });
      return false;
    }
    if (this.running.get(channel) === loop) this.running.delete(channel);
    this.options.gateway.untrack(channel);
    return true;
  }

  /**
   * Replace a channel's loop: stop it, then start it again if its record is
   * still startable. This is what a settings write for that channel calls,
   * because every push transport reads its record once — at start — so a
   * replaced record only takes effect through a fresh loop.
   */
  reconcile(channel: MessagingGatewayChannel): Promise<void> {
    return this.serialize(async () => {
      // Not two loops for one channel: a loop that ignored its abort is never
      // replaced, because the replacement would run beside it.
      const stopped = await this.stopNow(channel);
      if (!stopped) return;
      await this.startNow(channel);
    });
  }

  /**
   * Bring every channel's loop into line with its saved record.
   *
   * This is the invariant, and it is idempotent: a running loop whose record is
   * still startable is left alone, so a settings write that does not touch
   * messaging costs one settings read and disturbs nothing. A channel whose
   * readiness cannot be determined is skipped.
   */
  reconcileAll(): Promise<void> {
    return this.serialize(async () => {
      for (const channel of this.channels) {
        const ready = await this.readiness(channel);
        if (ready === null) continue;
        if (ready) {
          if (!this.running.has(channel)) this.launch(channel);
          continue;
        }
        if (this.running.has(channel)) await this.stopNow(channel);
      }
    });
  }

  /** Stop every loop this supervisor owns. Shutdown's single call. */
  stopAll(): Promise<void> {
    return this.serialize(async () => {
      for (const channel of this.channels) {
        await this.stopNow(channel);
      }
    });
  }

  /**
   * Run one lifecycle change at a time.
   *
   * A settings save, a secret write and a quit can overlap, and two overlapping
   * stops would each abort and then each start a loop: two loops for one
   * channel, which is the failure this class exists to prevent. Serialising is
   * enough because every operation here is short (a reconcile reads settings,
   * aborts, and waits bounded).
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startNow(channel: MessagingGatewayChannel): Promise<void> {
    if (this.running.has(channel)) return;
    const ready = await this.readiness(channel);
    if (ready !== true) return;
    this.launch(channel);
  }

  private async readiness(channel: MessagingGatewayChannel): Promise<boolean | null> {
    try {
      return await this.options.readiness(channel);
    } catch {
      return null;
    }
  }

  /** Build and launch one loop. Synchronous: the signal is live before `run` is called. */
  private launch(channel: MessagingGatewayChannel): void {
    if (this.running.has(channel)) return;
    const starter = this.options.starters[channel];
    if (!starter) return;
    const controller = new AbortController();
    let done: Promise<void>;
    try {
      done = starter(controller.signal).run();
    } catch (error) {
      this.options.log?.("warn", "inbound messaging loop failed to start", {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const loop: RunningLoop = { controller, done };
    this.running.set(channel, loop);
    this.options.gateway.track(channel, loop);
    // A loop that ends on its own (a transport that started nothing, or a
    // socket the peer closed) leaves no entry behind, so a later reconcile can
    // start it again without believing it is already running.
    void done.then(
      () => this.forget(channel, loop),
      () => this.forget(channel, loop),
    );
  }

  private forget(channel: MessagingGatewayChannel, loop: RunningLoop): void {
    if (this.running.get(channel) === loop) this.running.delete(channel);
  }
}
