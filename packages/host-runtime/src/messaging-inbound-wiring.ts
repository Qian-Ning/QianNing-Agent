import {
  MessagingInboundDriver,
  MESSAGING_SLACK_APP_TOKEN_SECRET_REF,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  MESSAGING_SLACK_SECTION,
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  MESSAGING_TELEGRAM_SECTION,
  createAgentHostTargets,
  createSettingsSlackHandledStore,
  createSlackInboundPushTransport,
  createSlackOpenConnection,
  createTelegramInboundTransport,
  createWsSlackSocketFactory,
  readInboundLink,
  type MessagingInboundAudit,
  type MessagingInboundAuditEntry,
  type MessagingInboundCursorStore,
  type MessagingInboundPushTransport,
  type MessagingInboundTransport,
  type SlackInboundAudit,
  type SlackOpenConnection,
  type SlackSocketFactory,
  type TelegramPollResult,
} from "@pi-desktop/agent-host";
import type { AgentHost } from "@pi-desktop/agent-host";
import { allowInsecureUserEndpoints, ErrorCodes } from "@pi-desktop/shared";

import { requireHostRpc, type HostRpc } from "./host-ports.js";

/**
 * The production wiring for the inbound messaging command driver (ADR 0205
 * D375 item 9): the composition roots build the driver here and start and stop
 * its poll loop, so the driver is no longer reachable only by its tests.
 *
 * Everything the driver needs is injected as a port, and every port reads an
 * existing surface: the channel's settings section and the poll cursor and the
 * conversation-to-session binding all ride the `app` settings row through the
 * host's own `settings.get` / `settings.set`; the bot token comes from the
 * host's secret store; the operations are the same [`AgentHost`] the RACP
 * handlers call. No new store, namespace, operation verb, listener or
 * dependency is introduced: this module is composition only.
 *
 * # The settings row is not a remote surface
 *
 * The link, the cursor and the binding all live in the `app` settings row, so
 * their integrity rests on who may write it. `settings.set` and `settings.get`
 * are host verbs on the host's internal call path, not RACP operations:
 * `RACP_OPERATIONS` does not name them, the RACP server refuses any method not
 * in that table before a handler is looked up, and every settings write caller
 * reaches the row on the host's own internal call path — both composition
 * roots do, through `createHostSettingsSurface` in this module: the desktop
 * main process (`electron/main/bootstrap/startup.ts`) and the headless entry
 * point (`apps/pi-host/src/app.ts`). A remote RACP peer therefore cannot write
 * the row at all, and cannot move a linked chat onto another session through
 * the binding. A test in
 * `@pi-desktop/shared` asserts that `settings.set` and `settings.get` are
 * absent from `RACP_OPERATIONS`, so adding settings to the operation table
 * turns that test red.
 *
 * # What the binding does and does not protect
 *
 * The binding is the conversation-to-session mapping the driver resolves a
 * target from, and it is fail-closed: a chat with no binding yields no target
 * and every command is refused before an operation runs. It is stored in the
 * settings row beside the link (see
 * [`MessagingInboundSessionBindingStore`]) and written only through the host's
 * internal `settings.set`, by [`bindMessagingInboundSession`] — the writer the
 * desktop-main `pi-desktop/messagingInbound/bindSession` IPC channel drives.
 * That channel is a host-internal IPC handler, not a RACP operation, so the
 * write never leaves the host's internal call path.
 *
 * Since ADR 0325 the same bind write also records the session's owner: binding
 * a conversation to a session sets that session's owning subject to the linked
 * principal's subject, through the host-internal `session.setOwner` host-RPC
 * method ([`HostSessionOwnerWriter`]). That is what makes the messaging path
 * usable at all — the channel's principal cannot create a session and there is
 * no ownership-transfer operation, so the bind is the one place the ownership
 * is established. It is a host-RPC method, and `RACP_OPERATIONS` does not name
 * it, so a remote peer cannot set an owner either.
 *
 * The ownership check itself is the Agent Host's, not this module's: the Host
 * refuses a principal that is neither the session's owner nor a holder of the
 * `owner` role, on every session-addressed operation, including the snapshot
 * the target resolver reads. Nothing here restates or bypasses it. An unknown
 * session id fails the bind closed: the owner write reports `NOT_FOUND` and the
 * binding is not written.
 *
 * # Known interaction with the existing settings UI
 *
 * The channel's settings section is not isolated from the general settings UI.
 * `settings.get` returns the whole `app` row, the renderer keeps that row as
 * its settings snapshot and spreads it back on save, so a routine UI settings
 * save round-trips the `messagingTelegram` section it read earlier. If that
 * section has gone stale between the read and the save — because this wiring
 * advanced the cursor or wrote a binding in the meantime — the save silently
 * overwrites the persisted binding or cursor with the older value. This is
 * recorded as a known, reachable interaction with the existing settings UI and
 * will be addressed separately (the section needs to be excluded from the
 * renderer's round-trip, or the write needs to be scoped to the keys the UI
 * owns); no renderer or settings behaviour is changed here.
 */

/** Where the Telegram bot token lives in the host's secret store. */
export const MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF = "secret:messaging-telegram:bot-token";

/**
 * Where the Slack app-level token lives in the host's secret store (ADR 0326).
 *
 * The sibling of the bot token ref above, following the same shape the outbound
 * Slack channel's `secret:messaging-slack:bot-token` and config sync's
 * `secret:config-sync:webdav-password` use. Its definition lives beside the
 * Socket Mode client that consumes it (`@pi-desktop/agent-host`); it is
 * re-exported here so each composition root imports every messaging secret ref
 * from one module.
 */
export { MESSAGING_SLACK_APP_TOKEN_SECRET_REF };

/**
 * The host's settings surface: the shared `app` row, read whole and written
 * with a top-level patch. `settings.set` merges by top-level key, so a write
 * replaces a whole section rather than merging into it.
 */
export type HostSettingsSurface = {
  read(): Promise<unknown>;
  write(patch: Record<string, unknown>): Promise<void>;
};

/** The host's secret store read path (`secrets.getForRuntime`). */
export type HostSecretReader = (secretRef: string) => Promise<string | null>;

/** Where the wiring logs; the audit records structure and ids, never content. */
export type MessagingInboundWiringLog = (
  level: "info" | "warn",
  message: string,
  data?: Record<string, unknown>,
) => void;

/**
 * The persisted conversation-to-session binding, inside the channel's settings
 * section under `inbound`:
 *
 * ```json
 * {
 *   "messagingTelegram": {
 *     "format": "pi-desktop-messaging-telegram",
 *     "version": 1,
 *     "endpoint": "...",
 *     "destination": "<the one linked chat>",
 *     "inbound": {
 *       "linkedPrincipal": { "subject": "...", "roles": ["..."] },
 *       "permissionMode": "ask",
 *       "pollOffset": 42,
 *       "sessionId": "<the session this chat's commands act on>"
 *     }
 *   }
 * }
 * ```
 *
 * The section already names exactly one conversation (`destination`), so one
 * `sessionId` beside it is the whole mapping: the linked chat's commands act
 * on the session named here and on nothing else. The binding is written only
 * through `settings.set` on the host's internal call path — by
 * [`bindMessagingInboundSession`], which the host-internal bind IPC channel
 * drives — so a remote RACP peer cannot rebind the chat. An absent or blank
 * `sessionId` means the chat is unbound, and a command that needs a session is
 * refused (fail closed).
 */
export interface MessagingInboundSessionBindingStore {
  /** The session bound to the linked chat, or `null` when none is bound. */
  load(): Promise<string | null>;
  /** Bind the linked chat to `sessionId` through the settings row. */
  save(sessionId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The channel's settings section, or `null` when absent or not an object.
 *  Defaults to the Telegram channel's, so existing callers are unchanged. */
function readSection(
  settings: unknown,
  sectionKey: string = MESSAGING_TELEGRAM_SECTION,
): Record<string, unknown> | null {
  if (!isRecord(settings)) return null;
  const section = settings[sectionKey];
  return isRecord(section) ? section : null;
}

/** The section's `inbound` record, or `null` when absent or not an object. */
function readInbound(section: Record<string, unknown> | null): Record<string, unknown> | null {
  return section && isRecord(section.inbound) ? section.inbound : null;
}

/**
 * Replace the channel's settings section through `settings.set`.
 *
 * `settings.set` merges at the top level, so the whole section is written back
 * with the one field changed; a section that is absent leaves nothing to write
 * into, so the mutation is a no-op (an unconfigured channel has no field for a
 * cursor or a binding to occupy).
 *
 * This is a read-modify-write over the whole `messagingTelegram` section, with
 * a gap between the read and the write. Two of this module's own writers — the
 * cursor save and the bind save — can interleave across that gap and lose one
 * update. The consequence is benign, so it is deliberately not fixed here: a
 * lost cursor means a re-poll, a lost bind means the operator retries. The
 * narrow top-level write described on [`bindMessagingInboundSession`] must not
 * be read as making this section write concurrency-safe — it bounds which
 * *neighbouring* keys a write can clobber, not whether two writes to this
 * section race.
 */
async function patchSection(
  settings: HostSettingsSurface,
  mutate: (section: Record<string, unknown>, inbound: Record<string, unknown>) => Record<string, unknown>,
  sectionKey: string = MESSAGING_TELEGRAM_SECTION,
): Promise<void> {
  const section = readSection(await settings.read(), sectionKey);
  if (!section) return;
  const inbound = readInbound(section) ?? {};
  await settings.write({
    [sectionKey]: { ...section, inbound: mutate(section, inbound) },
  });
}

/**
 * A channel the bind path can write: the settings section its record lives in
 * and the record's self-identifying format. The Telegram channel is the default
 * everywhere, so every existing caller and the existing bind IPC channel keep
 * the exact shape they had; a second channel (Slack, ADR 0326) is selected by
 * passing its descriptor rather than by restating the reader.
 */
export type MessagingInboundChannel = { section: string; format: string; version: number };

/** The Telegram channel's descriptor: the default the bind path uses. */
export const TELEGRAM_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_TELEGRAM_SECTION,
  format: MESSAGING_TELEGRAM_FORMAT,
  version: MESSAGING_TELEGRAM_FORMAT_VERSION,
};

/** The Slack channel's descriptor (ADR 0326), selected by its own bind channel. */
export const SLACK_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_SLACK_SECTION,
  format: MESSAGING_SLACK_FORMAT,
  version: MESSAGING_SLACK_FORMAT_VERSION,
};

/**
 * The poll cursor, persisted in the same settings row the link is read from.
 *
 * Stored as `inbound.pollOffset`: the offset the next poll asks from, so a
 * restart resumes at the last offset the previous run saved instead of
 * replaying from zero. A missing, non-numeric or negative field reads as "no
 * position stored", which the driver treats as zero.
 *
 * Cost, recorded deliberately: a cursor advance writes through `settings.set`,
 * and a settings write re-applies the network proxy policy and re-pins the
 * plugin market channel and locale on every call (host-core's `settings.set`).
 * That cost is bounded by the message rate, not the poll rate, and an idle poll
 * writes nothing, so it is not a defect — but it is not free either, and it is
 * the reason a cursor save is not issued on every poll. Reduce it by changing
 * the settings write path, not by writing the cursor less honestly.
 */
export function createSettingsCursorStore(
  settings: HostSettingsSurface,
): MessagingInboundCursorStore {
  return {
    async load(): Promise<number | null> {
      const inbound = readInbound(readSection(await settings.read()));
      const value = inbound?.pollOffset;
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    },
    async save(offset: number): Promise<void> {
      await patchSection(settings, (_section, inbound) => ({ ...inbound, pollOffset: offset }));
    },
  };
}

/** The conversation-to-session binding, persisted beside the cursor. */
export function createSettingsSessionBindingStore(
  settings: HostSettingsSurface,
  sectionKey: string = MESSAGING_TELEGRAM_SECTION,
): MessagingInboundSessionBindingStore {
  const load = async (): Promise<string | null> => {
    const inbound = readInbound(readSection(await settings.read(), sectionKey));
    const value = inbound?.sessionId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    load,
    async save(sessionId: string): Promise<void> {
      const trimmed = sessionId.trim();
      if (!trimmed) return;
      await patchSection(settings, (_section, inbound) => ({ ...inbound, sessionId: trimmed }), sectionKey);
    },
  };
}

/**
 * The host-internal write that records a session's owning subject (ADR 0325).
 * Backed by the `session.setOwner` host-RPC method, which is not a RACP
 * operation: `RACP_OPERATIONS` does not name it and the RACP server refuses an
 * unknown method before dispatch, so only the host's own call path reaches it.
 * A writer rejects for an unknown session id, which is how the bind fails
 * closed.
 */
export type HostSessionOwnerWriter = (sessionId: string, owner: string) => Promise<void>;

/** The owner writer the composition roots give the bind path. */
export function createHostSessionOwnerWriter(getHost: () => HostRpc | null): HostSessionOwnerWriter {
  return async (sessionId, owner) => {
    await requireHostRpc(getHost).call("session.setOwner", { id: sessionId, owner });
  };
}

/**
 * Bind the linked conversation to `sessionId` — the one production writer of
 * the binding — and record the session's owner.
 *
 * The desktop-main `pi-desktop/messagingInbound/bindSession` IPC channel calls
 * this; it is the writer the wiring's binding store otherwise never had. It
 * stays on the host's internal call path: it goes through the host's own
 * `settings.set`, never through RACP, so a remote peer cannot move a linked
 * chat onto another session. Since ADR 0325 the same call also writes the
 * session's owner through `session.setOwner` (a host-RPC method, not a RACP
 * operation), so a linked principal reaches the session it is bound to without
 * needing a session-creation or ownership-transfer operation that does not
 * exist.
 *
 * The `owners` writer is required, not optional: a bind that did not record an
 * owner would leave a linked principal unable to reach the session it is bound
 * to, which is the state this whole step removes. A caller that omits it does
 * not compile.
 *
 * The owner write goes first, and the binding write follows only if it
 * succeeds: an unknown session id is refused by `session.setOwner` and no
 * binding is then written. The two writes are not transactional, so the
 * failure direction is what makes the shape safe rather than atomicity: if
 * `session.setOwner` succeeds and the settings write then fails, the session
 * is left owned with the conversation unbound — no inbound command reaches it
 * (the driver refuses an unbound conversation), and a later bind completes the
 * pair. Owner-succeeds + save-fails is thus a retriable partial state, never a
 * conversation bound to a session it does not own.
 *
 * Shape, chosen deliberately: the settings write is a single `settings.set`
 * carrying only the channel's own top-level section key. `settings.set` merges
 * at the top level, so this patch can replace the `messagingTelegram` section
 * and nothing else — it can never overwrite a neighbouring app setting (theme,
 * language, network policy, …) even if another writer changed one between the
 * read of the section and the write. The pre-existing whole-snapshot settings
 * IPC writes every key from a separately read snapshot, a read-modify-write
 * over the whole row that can clobber a concurrent write; this is deliberately
 * not that shape.
 *
 * Fail closed: a blank or non-string id is refused with `INVALID_ARGUMENT`
 * rather than written, matching the store, which never writes a blank id, and
 * a channel with no readable link names no principal to own the session, so it
 * is refused too. Nothing is written when the channel has no section — an
 * unconfigured channel has no field for a binding to occupy.
 */
export async function bindMessagingInboundSession(
  settings: HostSettingsSurface,
  sessionId: unknown,
  owners: HostSessionOwnerWriter,
  channel: MessagingInboundChannel = TELEGRAM_INBOUND_CHANNEL,
): Promise<void> {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw Object.assign(new Error("the session id to bind must be a non-empty string"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  const id = sessionId.trim();
  const link = readInboundLink(
    readSection(await settings.read(), channel.section),
    channel.format,
    channel.version,
  );
  if (!link) {
    throw Object.assign(
      new Error("the channel names no linked principal to own the session"),
      { errorCode: ErrorCodes.INVALID_ARGUMENT },
    );
  }
  await owners(id, link.principal.subject);
  await createSettingsSessionBindingStore(settings, channel.section).save(id);
}

/** The audit sink a composition root installs: structure and ids, no content. */
export function createMessagingInboundAudit(log?: MessagingInboundWiringLog): MessagingInboundAudit {
  if (!log) return () => {};
  return (entry: MessagingInboundAuditEntry) => {
    const level = entry.kind === "operation" || entry.kind === "duplicate" ? "info" : "warn";
    const data: Record<string, unknown> = { kind: entry.kind };
    if ("messageId" in entry) data.messageId = entry.messageId;
    if ("chatId" in entry) data.chatId = entry.chatId;
    if ("operation" in entry) data.operation = entry.operation;
    if ("refusalKind" in entry) data.refusalKind = entry.refusalKind;
    if ("error" in entry) data.error = entry.error;
    log(level, "inbound messaging command path", data);
  };
}

/** The operation surface the wiring drives: the same object the RACP handlers use. */
export type MessagingInboundHostSurface = Pick<
  AgentHost,
  "startTurn" | "stopTurn" | "interruptTurn" | "respondApproval" | "snapshot"
>;

export type MessagingInboundWiringOptions = {
  /** The Agent Host the commands are applied through, with the snapshot reader. */
  agentHost: MessagingInboundHostSurface;
  /** The host settings surface the link, cursor and binding ride. */
  settings: HostSettingsSurface;
  /** The host secret store, read for the bot token. */
  secrets: HostSecretReader;
  /** The owner's abort signal; the loop leaves `run` once it aborts. */
  signal: AbortSignal;
  /** Where audit records go; absent means the records are dropped. */
  log?: MessagingInboundWiringLog;
  /** Test seam: a transport in place of the one built from the settings. */
  transport?: MessagingInboundTransport;
};

/** A built driver and the loop that runs it, for the root that owns the signal. */
export type MessagingInboundWiring = {
  /** The driver, exposed for tests and for the binding write path. */
  readonly driver: MessagingInboundDriver;
  /** The conversation-to-session binding this wiring resolves targets from. */
  readonly binding: MessagingInboundSessionBindingStore;
  /** Run the poll loop until the owner's signal aborts; resolves then, never rejects. */
  run(): Promise<void>;
};

/**
 * A started inbound loop and the controller that stops it, held by the
 * composition root that owns it. Shutdown aborts the controller and awaits
 * `done`, which resolves once the loop has observed the abort and left `run`.
 */
export type MessagingInboundHandle = {
  readonly controller: AbortController;
  readonly done: Promise<void>;
};

/**
 * Wait for `work` to settle, or give up after `budgetMs` — whichever first.
 *
 * The inbound loop's own host calls (the settings read, the cursor load and
 * save, and the secret read) carry no abort signal, so once its controller
 * aborts, a single in-flight iteration can still be waiting on a host RPC,
 * bounded only by the host RPC deadline — far longer than a quit may wait.
 * Both composition roots therefore bound their stop wait with this, the way
 * `settleRunningTurnsForQuit` bounds the provider wait. Giving up resolves
 * rather than rejects, so the caller's shutdown sequence proceeds; the
 * abandoned promise settles on its own and its rejection is swallowed so it
 * cannot surface as an unhandled rejection.
 */
export function settleWithinBudget(
  work: Promise<void> | undefined,
  budgetMs: number,
): Promise<void> {
  const bounded = work ? work.catch(() => undefined) : Promise.resolve();
  return Promise.race([
    bounded,
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, budgetMs));
    }),
  ]);
}

/** The long-poll open time. This module's own; the record's send timeout is not reused. */
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** An idle poll: nothing to do, cursor unchanged. */
function idlePoll(offset: number): TelegramPollResult {
  return { ok: true, messages: [], nextOffset: offset };
}

/**
 * The production transport: one outbound long poll per call, re-reading the
 * channel's record and credential on every poll so a configuration change or a
 * rotated token takes effect without a restart.
 *
 * A channel that names no endpoint, or whose token the secret store does not
 * hold, polls nothing rather than reporting a failure every few seconds: there
 * is nothing to receive from, and the driver's own link check already refuses
 * every message while the section names no link. The token is passed straight
 * to [`createTelegramInboundTransport`], which keeps it out of every failure
 * detail; this wrapper never places it in a value it reports.
 */
function createConfiguredTransport(options: MessagingInboundWiringOptions): MessagingInboundTransport {
  return {
    async poll(offset: number, signal?: AbortSignal): Promise<TelegramPollResult> {
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return idlePoll(offset);
      }
      const section = readSection(settings);
      const endpoint = typeof section?.endpoint === "string" ? section.endpoint.trim() : "";
      if (!endpoint) return idlePoll(offset);
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      if (!token || !token.trim()) return idlePoll(offset);
      return createTelegramInboundTransport({
        endpoint,
        token: token.trim(),
        requestTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
      }).poll(offset, signal);
    },
  };
}

/**
 * Wait `ms`, or return immediately once `signal` aborts.
 *
 * The loop already re-checks the signal each iteration; this makes the wait
 * itself abort-aware so an abort during a back-off cannot leave the loop
 * sleeping for seconds after its owner has stopped it.
 */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the inbound command driver from the host's own surfaces.
 *
 * `readConfig` re-reads the link from the settings section on every message, so
 * a chat linked (or unlinked) while the loop is running takes effect without a
 * restart. The target resolver reads the persisted conversation-to-session
 * binding; the principal the driver hands it is not consulted, because the
 * binding names the session for the one linked conversation and the link has
 * already decided which conversation may act.
 */
export function createMessagingInboundWiring(
  options: MessagingInboundWiringOptions,
): MessagingInboundWiring {
  const binding = createSettingsSessionBindingStore(options.settings);
  const cursor = createSettingsCursorStore(options.settings);
  const targets = createAgentHostTargets(options.agentHost, () => binding.load());
  const driver = new MessagingInboundDriver({
    agentHost: options.agentHost,
    transport: options.transport ?? createConfiguredTransport(options),
    readConfig: async () => ({ link: readInboundLink(readSection(await options.settings.read())) }),
    targets,
    cursor,
    audit: createMessagingInboundAudit(options.log),
    wait: (ms) => waitOrAbort(ms, options.signal),
  });
  return {
    driver,
    binding,
    async run(): Promise<void> {
      try {
        await driver.run(options.signal);
      } catch (error) {
        // The driver reports its own failures and does not throw, so this is
        // defensive: a loop that somehow throws still resolves its owner's
        // await instead of leaving the shutdown path pending.
        options.log?.("warn", "inbound messaging loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** The default Slack Web API base; `apps.connections.open` is appended to it. */
const SLACK_DEFAULT_API_BASE = "https://slack.com";

/**
 * The audit sink for the Slack Socket Mode client (ADR 0326): structure and ids
 * only — never message text and never the app-level token. The client reports
 * typed entries that carry exactly those fields. A handled event (processed, or
 * a duplicate the durable guard already knew) is informational; a refused
 * handshake, a filtered or malformed frame, and a failed record are warnings.
 */
export function createSlackInboundAudit(log?: MessagingInboundWiringLog): SlackInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound slack channel", { ...entry });
  };
}

/**
 * The production Slack transport, config-gated on the app-level token (ADR 0326).
 *
 * `start` reads the app-level token from the host's secret store — the same
 * external seam the Telegram transport reads its bot token from — and only then
 * opens a Socket Mode connection. With no token configured it returns without
 * opening anything: the transport does not start, no `apps.connections.open`
 * call is made, no socket is opened, and the loop each composition root started
 * resolves at once. This is the config gate: an install with no Slack
 * app-level token configured behaves exactly as it did before this channel
 * existed — the released product's default behaviour is unchanged. Nothing is
 * opened and no port is bound: the Socket Mode connection is one the Host
 * originates, so no inbound listener is started.
 *
 * Fail-safe: a missing, malformed or refused credential, and a refused
 * `apps.connections.open`, are never propagated out of `start`. The push
 * transport's own loop reconnects after a bounded delay and the driver reports
 * its own failures without throwing, so no Slack failure can take the Host down
 * or hold up its startup.
 */
function createConfiguredSlackTransport(options: MessagingSlackWiringOptions): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_SLACK_APP_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      // The config gate: an unconfigured channel opens nothing.
      if (!token || !token.trim()) return;
      const openConnection =
        options.openConnection ??
        createSlackOpenConnection({ endpoint: options.endpoint ?? SLACK_DEFAULT_API_BASE });
      const connect = options.connect ?? createWsSlackSocketFactory();
      await createSlackInboundPushTransport({
        client: {
          appToken: token.trim(),
          openConnection,
          connect,
          handled: createSettingsSlackHandledStore(options.settings),
          audit: createSlackInboundAudit(options.log),
        },
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound Slack channel over Socket Mode (ADR 0326).
 *
 * It is the Telegram wiring's shape with the channel swapped: the same
 * [`MessagingInboundDriver`], the same conversation-to-session binding store and
 * target resolver, over the Socket Mode push transport instead of the long
 * poll. Every port reads an existing surface — the Slack settings section
 * (`messagingSlack`) for the link and the conversation-to-session binding, the
 * settings row the durable replay guard rides, and the host secret store for
 * the app-level token — so no new store, namespace, operation verb or listener
 * is introduced: this module is composition only. The transport is
 * config-gated on the app-level token (see [`createConfiguredSlackTransport`]),
 * so a Host with nothing configured starts no loop and behaves as before.
 */
export type MessagingSlackWiringOptions = {
  /** The Agent Host the commands are applied through, with the snapshot reader. */
  agentHost: MessagingInboundHostSurface;
  /** The host settings surface the link, the binding and the replay guard ride. */
  settings: HostSettingsSurface;
  /** The host secret store, read for the app-level token. */
  secrets: HostSecretReader;
  /** The owner's abort signal; the loop leaves `run` once it aborts. */
  signal: AbortSignal;
  /** Where audit records go; absent means the records are dropped. */
  log?: MessagingInboundWiringLog;
  /** The Slack Web API base the handshake posts to; defaults to Slack's own. */
  endpoint?: string;
  /** Test seam: the `apps.connections.open` call, in place of the production one. */
  openConnection?: SlackOpenConnection;
  /** Test seam: the WebSocket client factory, in place of the production one. */
  connect?: SlackSocketFactory;
  /** Test seam: how the reconnect loop waits; injected so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

/**
 * Build the inbound Slack wiring. The transport is the configured Socket Mode
 * push transport unless a test injects one; the driver, the binding and the
 * `run` contract are exactly the Telegram channel's, so the two channels share
 * one routing path and one shutdown shape.
 */
export function createSlackInboundWiring(options: MessagingSlackWiringOptions): MessagingInboundWiring {
  const binding = createSettingsSessionBindingStore(options.settings, MESSAGING_SLACK_SECTION);
  const targets = createAgentHostTargets(options.agentHost, () => binding.load());
  const driver = new MessagingInboundDriver({
    agentHost: options.agentHost,
    transport: options.transport ?? createConfiguredSlackTransport(options),
    readConfig: async () => ({
      link: readInboundLink(
        readSection(await options.settings.read(), MESSAGING_SLACK_SECTION),
        MESSAGING_SLACK_FORMAT,
        MESSAGING_SLACK_FORMAT_VERSION,
      ),
    }),
    targets,
    audit: createMessagingInboundAudit(options.log),
    wait: (ms) => waitOrAbort(ms, options.signal),
  });
  return {
    driver,
    binding,
    async run(): Promise<void> {
      try {
        await driver.run(options.signal);
      } catch (error) {
        // The driver reports its own failures and does not throw, so this is
        // defensive: a loop that somehow throws still resolves its owner's
        // await instead of leaving the shutdown path pending.
        options.log?.("warn", "inbound slack loop failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** The settings surface both composition roots give the wiring. */
export function createHostSettingsSurface(getHost: () => HostRpc | null): HostSettingsSurface {
  return {
    read: () => requireHostRpc(getHost).call("settings.get"),
    async write(patch) {
      await requireHostRpc(getHost).call("settings.set", patch);
    },
  };
}

/** The secret reader both composition roots give the wiring. */
export function createHostSecretReader(getHost: () => HostRpc | null): HostSecretReader {
  return async (secretRef) => {
    const host = getHost();
    if (!host) return null;
    const result = await host.call<{ value?: string | null }>("secrets.getForRuntime", { secretRef });
    return result?.value ?? null;
  };
}
