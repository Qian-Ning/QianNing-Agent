import {
  MessagingInboundDriver,
  MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF,
  MESSAGING_DISCORD_FORMAT,
  MESSAGING_DISCORD_FORMAT_VERSION,
  MESSAGING_DISCORD_SECTION,
  MESSAGING_HOME_ASSISTANT_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_HOME_ASSISTANT_FORMAT,
  MESSAGING_HOME_ASSISTANT_FORMAT_VERSION,
  MESSAGING_HOME_ASSISTANT_SECTION,
  MESSAGING_IRC_FORMAT,
  MESSAGING_IRC_FORMAT_VERSION,
  MESSAGING_IRC_SECTION,
  MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF,
  MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATTERMOST_FORMAT,
  MESSAGING_MATTERMOST_FORMAT_VERSION,
  MESSAGING_MATTERMOST_SECTION,
  MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATRIX_FORMAT,
  MESSAGING_MATRIX_FORMAT_VERSION,
  MESSAGING_MATRIX_SECTION,
  MESSAGING_NTFY_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_NTFY_FORMAT,
  MESSAGING_NTFY_FORMAT_VERSION,
  MESSAGING_NTFY_SECTION,
  MESSAGING_SLACK_APP_TOKEN_SECRET_REF,
  MESSAGING_SLACK_FORMAT,
  MESSAGING_SLACK_FORMAT_VERSION,
  MESSAGING_SLACK_SECTION,
  MESSAGING_TELEGRAM_FORMAT,
  MESSAGING_TELEGRAM_FORMAT_VERSION,
  MESSAGING_TELEGRAM_SECTION,
  DISCORD_DEFAULT_ENDPOINT,
  DISCORD_HANDLED_CAPACITY,
  IRC_HANDLED_CAPACITY,
  MATTERMOST_HANDLED_CAPACITY,
  MATRIX_HANDLED_CAPACITY,
  NTFY_HANDLED_CAPACITY,
  HOME_ASSISTANT_HANDLED_CAPACITY,
  createAgentHostTargets,
  createDiscordInboundPushTransport,
  createDiscordGatewayLookup,
  createHomeAssistantInboundPushTransport,
  createIrcInboundPushTransport,
  createMattermostIdentityLookup,
  createMattermostInboundPushTransport,
  createMatrixInboundPushTransport,
  createNtfyInboundPushTransport,
  ntfyApiBase,
  createSettingsHandledMessageStore,
  createSettingsSlackHandledStore,
  createSlackInboundPushTransport,
  createSlackOpenConnection,
  createTelegramInboundTransport,
  createWsDiscordSocketFactory,
  createWsHomeAssistantSocketFactory,
  createWsMattermostSocketFactory,
  createWsSlackSocketFactory,
  homeAssistantApiBase,
  homeAssistantWebSocketUrl,
  mattermostWebSocketUrl,
  matrixApiBase,
  normaliseIrcChannels,
  parseHomeAssistantService,
  readInboundLink,
  validateIrcEndpoint,
  type DiscordGatewayLookup,
  type DiscordInboundAudit,
  type HomeAssistantFetch,
  type HomeAssistantInboundAudit,
  type HomeAssistantSocketFactory,
  type DiscordSocketFactory,
  type IrcSocketFactory,
  type IrcInboundAudit,
  type MattermostIdentityLookup,
  type MattermostInboundAudit,
  type MattermostSocketFactory,
  type MatrixIdentityLookup,
  type MatrixInboundAudit,
  type NtfyFetch,
  type NtfyInboundAudit,
  type MessagingInboundAudit,
  type MessagingInboundAuditEntry,
  type MessagingInboundCursorStore,
  type MessagingInboundPushTransport,
  type MessagingInboundTransport,
  type IngressCursorStore,
  // The email channel: one IMAP pull, one SMTP submission.
  MESSAGING_EMAIL_FORMAT,
  MESSAGING_EMAIL_FORMAT_VERSION,
  MESSAGING_EMAIL_PASSWORD_SECRET_REF,
  MESSAGING_EMAIL_SECTION,
  EMAIL_HANDLED_CAPACITY,
  EMAIL_MAX_MESSAGES_PER_POLL,
  createEmailInboundPushTransport,
  normaliseAllowedSenders,
  normaliseSmtpSecurity,
  type EmailInboundAudit,
  type ImapSocketFactory,
  type SmtpSocketFactory,
  type SmtpSecurity,
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

/** The Discord channel's descriptor, selected by its own bind channel. */
export const DISCORD_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_DISCORD_SECTION,
  format: MESSAGING_DISCORD_FORMAT,
  version: MESSAGING_DISCORD_FORMAT_VERSION,
};

/** The Mattermost channel's descriptor, selected by its own bind channel. */
export const MATTERMOST_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_MATTERMOST_SECTION,
  format: MESSAGING_MATTERMOST_FORMAT,
  version: MESSAGING_MATTERMOST_FORMAT_VERSION,
};

/** The Home Assistant channel's descriptor, selected by its own bind channel. */
export const HOME_ASSISTANT_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_HOME_ASSISTANT_SECTION,
  format: MESSAGING_HOME_ASSISTANT_FORMAT,
  version: MESSAGING_HOME_ASSISTANT_FORMAT_VERSION,
};

/** The Matrix channel's descriptor, selected by its own bind channel. */
export const MATRIX_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_MATRIX_SECTION,
  format: MESSAGING_MATRIX_FORMAT,
  version: MESSAGING_MATRIX_FORMAT_VERSION,
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
 * Build the wiring every channel shares: one driver, one binding store, one
 * `run` wrapper, over the channel's own section and transport.
 *
 * The four factories below differ only in the section they read, the format they
 * check and the transport they build; the driver, the binding store, the target
 * resolver, the audit sink and the shutdown contract are the same code. That is
 * here once, so a fifth channel adds a transport factory and a channel record,
 * not a fifth copy of the wiring.
 */
function createIngressWiring(options: {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** The section and record format the channel's link is read from. */
  channel: MessagingInboundChannel;
  /** The transport the channel's configured factory built. */
  transport: MessagingInboundTransport;
  /** Where the conversation-to-session binding is written; defaults to the link's section. */
  bindingSection?: string;
  /** Whether the channel keeps a poll cursor (pull channels only). */
  cursor?: boolean;
  /** The loop's failure line, e.g. `inbound slack loop failed`. */
  failureLabel: string;
}): MessagingInboundWiring {
  const section = options.bindingSection ?? options.channel.section;
  const binding = createSettingsSessionBindingStore(options.settings, section);
  const targets = createAgentHostTargets(options.agentHost, () => binding.load());
  const driver = new MessagingInboundDriver({
    agentHost: options.agentHost,
    transport: options.transport,
    readConfig: async () => ({
      link: readInboundLink(
        readSection(await options.settings.read(), options.channel.section),
        options.channel.format,
        options.channel.version,
      ),
    }),
    targets,
    ...(options.cursor ? { cursor: createSettingsCursorStore(options.settings) } : {}),
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
        // defensive: a loop that somehow throws still resolves its owner's await
        // instead of leaving the shutdown path pending.
        options.log?.("warn", options.failureLabel, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
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
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: TELEGRAM_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredTransport(options),
    cursor: true,
    failureLabel: "inbound messaging loop failed",
  });
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
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: SLACK_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredSlackTransport(options),
    failureLabel: "inbound slack loop failed",
  });
}

/**
 * The audit sink for the Discord Gateway client: structure and ids only, never
 * message text and never the bot token.
 */
export function createDiscordInboundAudit(log?: MessagingInboundWiringLog): DiscordInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound discord channel", { ...entry });
  };
}

/** How a channel's record is read at transport start. */
function readTransportRecord(
  settings: unknown,
  sectionKey: string,
): { endpoint: string; destination: string } {
  const section = readSection(settings, sectionKey);
  return {
    endpoint: typeof section?.endpoint === "string" ? section.endpoint.trim() : "",
    destination: typeof section?.destination === "string" ? section.destination.trim() : "",
  };
}

/**
 * The Discord transport, config-gated on the bot token and the channel record.
 *
 * `start` reads both from the host's own surfaces — the token from the secret
 * store under `secret:messaging-discord:bot-token`, the endpoint from the
 * channel's settings section — and only then opens a Gateway connection. With
 * no token, or no record naming a destination, it returns without opening
 * anything: an install with no Discord channel configured starts no loop and
 * behaves exactly as it did before. Nothing is bound: the Gateway connection is
 * one the Host originates.
 */
function createConfiguredDiscordTransport(
  options: MessagingDiscordWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      if (!token || !token.trim()) return;
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readTransportRecord(settings, MESSAGING_DISCORD_SECTION);
      if (!record.destination) return;
      const endpoint = options.endpoint ?? (record.endpoint || DISCORD_DEFAULT_ENDPOINT);
      const resolveGateway =
        options.resolveGateway ?? createDiscordGatewayLookup({ endpoint });
      const connect = options.connect ?? createWsDiscordSocketFactory();
      await createDiscordInboundPushTransport({
        client: {
          token: token.trim(),
          resolveGateway,
          connect,
          handled: createSettingsHandledMessageStore({
            settings: options.settings,
            section: MESSAGING_DISCORD_SECTION,
            capacity: DISCORD_HANDLED_CAPACITY,
          }),
          audit: createDiscordInboundAudit(options.log),
        },
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound Discord channel over the Gateway websocket.
 *
 * It is the Slack wiring's shape with the channel swapped: the same
 * [`MessagingInboundDriver`], the same conversation-to-session binding store and
 * target resolver, over a Gateway push transport instead of Socket Mode. Every
 * port reads an existing surface — the `messagingDiscord` settings section for
 * the link and the binding, the settings row the durable replay guard rides, and
 * the host secret store for the bot token — so no new store, namespace,
 * operation verb or listener is introduced: composition only.
 */
export type MessagingDiscordWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** The Discord API base the Gateway lookup posts to; defaults to the record's. */
  endpoint?: string;
  /** Test seam: the `/gateway/bot` lookup, in place of the production one. */
  resolveGateway?: DiscordGatewayLookup;
  /** Test seam: the websocket client factory, in place of the production one. */
  connect?: DiscordSocketFactory;
  /** Test seam: how the reconnect loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createDiscordInboundWiring(options: MessagingDiscordWiringOptions): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: DISCORD_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredDiscordTransport(options),
    failureLabel: "inbound discord loop failed",
  });
}

/** The audit sink for the Mattermost websocket client. */
export function createMattermostInboundAudit(log?: MessagingInboundWiringLog): MattermostInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound mattermost channel", { ...entry });
  };
}

/**
 * The Mattermost transport, config-gated on the access token and a base URL.
 *
 * The base URL is the user's own server, so there is no default: with no
 * `endpoint` in the record, or no token in the secret store under
 * `secret:messaging-mattermost:access-token`, nothing is opened. The websocket
 * address is derived from the configured base through the shared endpoint rule,
 * so a plaintext server is accepted only under the relaxed LAN policy — the
 * same rule the other channels apply — and the credential never enters the URL.
 */
function createConfiguredMattermostTransport(
  options: MessagingMattermostWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      if (!token || !token.trim()) return;
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readTransportRecord(settings, MESSAGING_MATTERMOST_SECTION);
      if (!record.endpoint || !record.destination) return;
      const socketUrl = mattermostWebSocketUrl(record.endpoint, {
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
      });
      if (!socketUrl.ok) {
        options.log?.("warn", "inbound mattermost channel has an unusable endpoint", {
          error: socketUrl.error,
        });
        return;
      }
      const resolveIdentity =
        options.resolveIdentity ?? createMattermostIdentityLookup({ endpoint: record.endpoint });
      const connect = options.connect ?? createWsMattermostSocketFactory();
      await createMattermostInboundPushTransport({
        client: {
          token: token.trim(),
          resolveIdentity,
          connect,
          url: socketUrl.url,
          handled: createSettingsHandledMessageStore({
            settings: options.settings,
            section: MESSAGING_MATTERMOST_SECTION,
            capacity: MATTERMOST_HANDLED_CAPACITY,
          }),
          audit: createMattermostInboundAudit(options.log),
        },
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound Mattermost channel over its websocket. The same
 * driver, binding and target resolver as every other channel, over a websocket
 * push with REST sends; the section (`messagingMattermost`) and the secret ref
 * are the only differences.
 */
export type MessagingMattermostWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the `GET /users/me` lookup, in place of the production one. */
  resolveIdentity?: MattermostIdentityLookup;
  /** Test seam: the websocket client factory, in place of the production one. */
  connect?: MattermostSocketFactory;
  /** Test seam: how the reconnect loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createMattermostInboundWiring(
  options: MessagingMattermostWiringOptions,
): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: MATTERMOST_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredMattermostTransport(options),
    failureLabel: "inbound mattermost loop failed",
  });
}

/**
 * The sync token, persisted in the channel's own settings section under
 * `inbound.syncToken`.
 *
 * Matrix's `next_batch` is an opaque string, so it is stored verbatim and read
 * back verbatim: nothing parses it, orders it or derives anything from it. A
 * missing, non-string or blank field reads as "no position stored", which asks
 * the homeserver for everything from the beginning of its window; a write that
 * fails leaves the last good token in place, and the shared transport only ever
 * writes a token that a poll from the stored one answered.
 *
 * The cost is the same as the Telegram cursor's: a save is a `settings.set`, so
 * it re-applies the network proxy policy and re-pins the plugin market channel
 * and locale (host-core's `settings.set`). It is issued only when the token
 * actually moved, which is a message rate, not a poll rate.
 */
export function createSettingsSyncTokenStore(
  settings: HostSettingsSurface,
  sectionKey: string = MESSAGING_MATRIX_SECTION,
): IngressCursorStore<string> {
  return {
    async load(): Promise<string | null> {
      const inbound = readInbound(readSection(await settings.read(), sectionKey));
      const value = inbound?.syncToken;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
    async save(token: string): Promise<void> {
      await patchSection(
        settings,
        (_section, inbound) => ({ ...inbound, syncToken: token }),
        sectionKey,
      );
    },
  };
}

/** The audit sink for the Matrix sync client. */
export function createMatrixInboundAudit(log?: MessagingInboundWiringLog): MatrixInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound matrix channel", { ...entry });
  };
}

/**
 * The Matrix transport, config-gated on the access token and the channel record.
 *
 * The base URL is the user's own homeserver, so there is no default: with no
 * `endpoint` in the record, no destination room, or no token in the secret store
 * under `secret:messaging-matrix:access-token`, nothing is opened and nothing is
 * polled. The endpoint goes through the shared inbound rule
 * ([`matrixApiBase`]), so a plaintext homeserver is accepted only under the
 * relaxed LAN policy, and the token never enters a URL.
 *
 * The sync token and the durable replay guard both ride the channel's own
 * settings section, so no new store, namespace or operation verb is introduced.
 */
function createConfiguredMatrixTransport(
  options: MessagingMatrixWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      if (!token || !token.trim()) return;
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readTransportRecord(settings, MESSAGING_MATRIX_SECTION);
      if (!record.endpoint || !record.destination) return;
      const base = matrixApiBase(record.endpoint, {
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
      });
      if (!base.ok) {
        options.log?.("warn", "inbound matrix channel has an unusable endpoint", {
          error: base.error,
        });
        return;
      }
      await createMatrixInboundPushTransport({
        endpoint: record.endpoint,
        token: token.trim(),
        ...(options.resolveIdentity ? { resolveIdentity: options.resolveIdentity } : {}),
        handled: createSettingsHandledMessageStore({
          settings: options.settings,
          section: MESSAGING_MATRIX_SECTION,
          capacity: MATRIX_HANDLED_CAPACITY,
        }),
        cursor: createSettingsSyncTokenStore(options.settings),
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
        audit: createMatrixInboundAudit(options.log),
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound Matrix channel over the client-server API.
 *
 * The same driver, binding and target resolver as every other channel, over a
 * long poll the Host originates. The two channels that pull look different on
 * the wire and identical here: the section (`messagingMatrix`), the record's
 * format and the secret ref are the only differences.
 */
export type MessagingMatrixWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the `whoami` lookup, in place of the production one. */
  resolveIdentity?: MatrixIdentityLookup;
  /** Test seam: how the loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createMatrixInboundWiring(
  options: MessagingMatrixWiringOptions,
): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: MATRIX_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredMatrixTransport(options),
    failureLabel: "inbound matrix loop failed",
  });
}

/** The ntfy channel's descriptor, selected by its own bind channel. */
export const NTFY_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_NTFY_SECTION,
  format: MESSAGING_NTFY_FORMAT,
  version: MESSAGING_NTFY_FORMAT_VERSION,
};

/**
 * The cursor, persisted in the channel's own settings section under
 * `inbound.sinceId`.
 *
 * ntfy's `since=<id>` is an opaque message id with no order, so it is stored
 * verbatim and read back verbatim: nothing parses it or derives anything from
 * it. A missing, non-string or blank field reads as "no position stored", which
 * asks the server for what is published from now on; a write that fails leaves
 * the last good id in place, and the shared transport only ever writes an id a
 * poll from the stored one answered with.
 *
 * The cost is the same as the Telegram cursor's: a save is a `settings.set`, so
 * it re-applies the network proxy policy and re-pins the plugin market channel
 * and locale (host-core's `settings.set`). It is issued only when the id
 * actually moved, which is a message rate, not a poll rate.
 */
export function createSettingsNtfyCursorStore(
  settings: HostSettingsSurface,
): IngressCursorStore<string> {
  return {
    async load(): Promise<string | null> {
      const inbound = readInbound(readSection(await settings.read(), MESSAGING_NTFY_SECTION));
      const value = inbound?.sinceId;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
    async save(id: string): Promise<void> {
      await patchSection(
        settings,
        (_section, inbound) => ({ ...inbound, sinceId: id }),
        MESSAGING_NTFY_SECTION,
      );
    },
  };
}

/** The audit sink for the ntfy long poll. */
export function createNtfyInboundAudit(log?: MessagingInboundWiringLog): NtfyInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound ntfy channel", { ...entry });
  };
}

/**
 * The ntfy transport, config-gated on the channel's record.
 *
 * `start` reads the topic and the server's base URL from the `messagingNtfy`
 * section and the optional access token from the host's secret store under
 * `secret:messaging-ntfy:access-token`, and only then starts the long poll. With
 * no section, no topic or no usable base URL it returns without asking for
 * anything: an install with no ntfy channel configured starts no loop and
 * behaves exactly as it did before this channel existed.
 *
 * The token is optional because a topic on a public server may be open. That is
 * also why the panel says, in plain language, that a public topic is readable
 * by anyone who knows its name: the token protects a topic only when the server
 * requires it, and a self-hosted server is the honest recommendation.
 *
 * The base URL goes through the shared endpoint rule, so a plaintext server is
 * accepted only on a loopback or private-LAN host under the relaxed policy, and
 * the token never enters a URL.
 */
function createConfiguredNtfyTransport(
  options: MessagingNtfyWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readTransportRecord(settings, MESSAGING_NTFY_SECTION);
      if (!record.endpoint || !record.destination) return;
      const base = ntfyApiBase(record.endpoint, {
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
      });
      if (!base.ok) {
        options.log?.("warn", "inbound ntfy channel has an unusable endpoint", {
          error: base.error,
        });
        return;
      }
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_NTFY_ACCESS_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      await createNtfyInboundPushTransport({
        endpoint: record.endpoint,
        topic: record.destination,
        ...(token && token.trim() ? { token: token.trim() } : {}),
        handled: createSettingsHandledMessageStore({
          settings: options.settings,
          section: MESSAGING_NTFY_SECTION,
          capacity: NTFY_HANDLED_CAPACITY,
        }),
        cursor: createSettingsNtfyCursorStore(options.settings),
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
        audit: createNtfyInboundAudit(options.log),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound ntfy channel over its `/json` long poll.
 *
 * The same driver, binding store and target resolver as every other channel,
 * over a poll the Host originates. The section (`messagingNtfy`), the topic it
 * names as `destination`, and the one optional secret (the access token) are
 * the only differences.
 *
 * # The echo loop, and why the receive path can share a topic with the send path
 *
 * ntfy has no notion of authorship, so a channel that publishes to the topic it
 * reads would take its own reply back as a command. The send path tags every
 * message it posts and this receive path drops a message carrying that tag (see
 * `messaging-ntfy-send.ts`); the adapter is built with both directions on the
 * same topic, which is what makes one topic a usable conversation.
 */
export type MessagingNtfyWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the HTTP client, in place of the platform fetch. */
  fetchImpl?: NtfyFetch;
  /** Test seam: how the long-poll loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createNtfyInboundWiring(options: MessagingNtfyWiringOptions): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: NTFY_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredNtfyTransport(options),
    failureLabel: "inbound ntfy loop failed",
  });
}

/**
 * The email channel's descriptor, selected by its own bind channel.
 *
 * Email is the first channel whose record names two servers: an IMAP one it
 * polls and an SMTP one it submits to. They are separate hosts because they
 * frequently are (a mail provider routes them to different machines), and each
 * keeps its own port and security.
 */
export const EMAIL_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_EMAIL_SECTION,
  format: MESSAGING_EMAIL_FORMAT,
  version: MESSAGING_EMAIL_FORMAT_VERSION,
};

/**
 * The last seen UID, persisted in the channel's own settings section under
 * `inbound.lastUid`.
 *
 * A UID is a positive integer that a mailbox never reuses, so it is stored as a
 * number and compared as one. A missing, non-numeric or non-positive field
 * reads as "no position stored", which the adapter treats as the first poll:
 * advance to the newest unread message and answer nothing, rather than firing a
 * turn for every message a mailbox has ever received.
 */
export function createSettingsEmailCursorStore(
  settings: HostSettingsSurface,
): IngressCursorStore<number> {
  return {
    async load(): Promise<number | null> {
      const inbound = readInbound(readSection(await settings.read(), MESSAGING_EMAIL_SECTION));
      const value = inbound?.lastUid;
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
    },
    async save(uid: number): Promise<void> {
      await patchSection(
        settings,
        (_section, inbound) => ({ ...inbound, lastUid: uid }),
        MESSAGING_EMAIL_SECTION,
      );
    },
  };
}

/** The audit sink for the IMAP poll. */
export function createEmailInboundAudit(log?: MessagingInboundWiringLog): EmailInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound email channel", { ...entry });
  };
}

/** The record the transport needs, or `null` when it is not this build's. */
type EmailWiringRecord = {
  imap: { host: string; port: number };
  smtp: { host: string; port: number; security: SmtpSecurity };
  username: string;
  from?: string;
  allowedSenders: string[];
  subjectPrefix?: string;
};

/**
 * Read and validate the `messagingEmail` section.
 *
 * Every field here is one the adapter would otherwise fail on mid-poll, so the
 * gate is at the door: a record with no IMAP host, no SMTP host, no username or
 * no allowlisted sender starts nothing. The allowlist is the important one —
 * without it the mailbox is not a channel but a hole, so an empty list is an
 * incomplete record rather than "accept everyone".
 */
function readEmailRecord(settings: unknown): EmailWiringRecord | null {
  const section = readSection(settings, MESSAGING_EMAIL_SECTION);
  if (!section) return null;
  if (
    section.format !== MESSAGING_EMAIL_FORMAT ||
    section.version !== MESSAGING_EMAIL_FORMAT_VERSION
  ) {
    return null;
  }
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const port = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
  };
  const security = normaliseSmtpSecurity(section.smtpSecurity);
  const imapHost = text(section.imapHost);
  const smtpHost = text(section.smtpHost);
  const username = text(section.username);
  const allowedSenders = normaliseAllowedSenders(section.allowedSenders);
  if (imapHost === "" || smtpHost === "" || username === "" || allowedSenders.length === 0) {
    return null;
  }
  const from = text(section.from);
  const subjectPrefix = text(section.subjectPrefix);
  return {
    imap: { host: imapHost, port: port(section.imapPort, 993) },
    smtp: {
      host: smtpHost,
      port: port(section.smtpPort, security === "tls" ? 465 : 587),
      security,
    },
    username,
    ...(from !== "" ? { from } : {}),
    allowedSenders,
    ...(subjectPrefix !== "" ? { subjectPrefix } : {}),
  };
}

/**
 * The email transport, config-gated on the channel's record and its password.
 *
 * `start` reads the record and the password from the host's own surfaces and
 * only then opens anything. With no section, an incomplete one, a foreign
 * `format` or no stored password it returns without connecting: an install with
 * no email channel configured starts no loop and behaves exactly as it did
 * before this channel existed.
 *
 * Nothing is bound. The poll is an outbound TLS connection the Host originates,
 * which is why this channel needs no public address and works behind NAT.
 */
function createConfiguredEmailTransport(
  options: MessagingEmailWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readEmailRecord(settings);
      if (!record) return;
      let password: string | null = null;
      try {
        password = await options.secrets(MESSAGING_EMAIL_PASSWORD_SECRET_REF);
      } catch {
        password = null;
      }
      const trimmed = (password ?? "").trim();
      if (trimmed === "") {
        // The panel says a password (ideally an app password) is required; a
        // record without one is enabled but not set up, and the loop stays off
        // rather than retrying a login it knows will fail.
        options.log?.("warn", "inbound email channel has no password stored", {});
        return;
      }
      await createEmailInboundPushTransport({
        imap: record.imap,
        smtp: record.smtp,
        username: record.username,
        password: trimmed,
        ...(record.from !== undefined ? { from: record.from } : {}),
        allowedSenders: record.allowedSenders,
        ...(record.subjectPrefix !== undefined ? { subjectPrefix: record.subjectPrefix } : {}),
        maxMessagesPerPoll: EMAIL_MAX_MESSAGES_PER_POLL,
        handled: createSettingsHandledMessageStore({
          settings: options.settings,
          section: MESSAGING_EMAIL_SECTION,
          capacity: EMAIL_HANDLED_CAPACITY,
        }),
        cursor: createSettingsEmailCursorStore(options.settings),
        audit: createEmailInboundAudit(options.log),
        ...(options.connect ? { connect: options.connect } : {}),
        ...(options.connectSmtp ? { connectSmtp: options.connectSmtp } : {}),
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound email channel.
 *
 * The same driver, binding store and target resolver as every other channel,
 * over a poll the Host originates. The section (`messagingEmail`), the two
 * servers it names, the sender allowlist and the one password
 * (`secret:messaging-email:password`) are the only differences.
 */
export type MessagingEmailWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the IMAP connection factory, in place of the TLS one. */
  connect?: ImapSocketFactory;
  /** Test seam: the SMTP connection factory, in place of the TLS one. */
  connectSmtp?: SmtpSocketFactory;
  /** Test seam: how the poll loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createEmailInboundWiring(options: MessagingEmailWiringOptions): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: EMAIL_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredEmailTransport(options),
    failureLabel: "inbound email loop failed",
  });
}

/** The IRC channel's descriptor, selected by its own bind channel. */
export const IRC_INBOUND_CHANNEL: MessagingInboundChannel = {
  section: MESSAGING_IRC_SECTION,
  format: MESSAGING_IRC_FORMAT,
  version: MESSAGING_IRC_FORMAT_VERSION,
};

/** The audit sink for the IRC client: structure and ids only, never a password. */
export function createIrcInboundAudit(log?: MessagingInboundWiringLog): IrcInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound irc channel", { ...entry });
  };
}

/**
 * The IRC transport, config-gated on a record and a nick.
 *
 * `start` reads the channel's section from the host's own settings row and only
 * then opens a connection: no section, no server address, no nick, or no linked
 * channel means it returns without opening anything, so an install with no IRC
 * channel configured starts no loop and behaves exactly as it did before this
 * channel existed.
 *
 * The server address goes through the shared endpoint rule (TLS unless the
 * relaxed policy names a LAN host), and a refused address is logged and not
 * dialled. The optional server password is read from its own secret reference
 * and handed to the client only to be written as `PASS`; it is never placed in a
 * log entry, and the refusal reasons the client reports name the numeric, not
 * the parameter.
 *
 * Channels are the record's `channels` list plus its linked `destination`, so a
 * record that names only the linked channel joins it without repeating it.
 */
function createConfiguredIrcTransport(
  options: MessagingIrcWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const section = readSection(settings, MESSAGING_IRC_SECTION);
      if (!section) return;
      const record = readTransportRecord(settings, MESSAGING_IRC_SECTION);
      const nick = typeof section.nick === "string" ? section.nick.trim() : "";
      if (!record.endpoint || !record.destination || !nick) return;
      const checked = validateIrcEndpoint(record.endpoint, {
        allowInsecureHttp: allowInsecureUserEndpoints(settings),
      });
      if (!checked.ok) {
        options.log?.("warn", "inbound irc channel has an unusable server address", {
          error: checked.error,
        });
        return;
      }
      let password: string | null = null;
      try {
        password = await options.secrets(MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF);
      } catch {
        password = null;
      }
      const channels = normaliseIrcChannels(section.channels, record.destination);
      if (channels.length === 0) return;
      await createIrcInboundPushTransport({
        client: {
          endpoint: checked.endpoint,
          nick,
          channels,
          ...(password && password.trim() ? { password: password.trim() } : {}),
          handled: createSettingsHandledMessageStore({
            settings: options.settings,
            section: MESSAGING_IRC_SECTION,
            capacity: IRC_HANDLED_CAPACITY,
          }),
          audit: createIrcInboundAudit(options.log),
          ...(options.connect ? { connect: options.connect } : {}),
        },
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound IRC channel over a raw TLS socket.
 *
 * The same driver, binding store and target resolver as every other channel,
 * over a connection the Host originates — no port is bound and no listener
 * exists. The section (`messagingIrc`), the nick it carries in the record, and
 * the one optional secret (the server password, under its own ref) are the only
 * differences.
 */
export type MessagingIrcWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the raw socket factory, in place of the TLS one. */
  connect?: IrcSocketFactory;
  /** Test seam: how the reconnect loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createIrcInboundWiring(options: MessagingIrcWiringOptions): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: IRC_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredIrcTransport(options),
    failureLabel: "inbound irc loop failed",
  });
}

/** The audit sink for the Home Assistant client: structure and ids only. */
export function createHomeAssistantInboundAudit(
  log?: MessagingInboundWiringLog,
): HomeAssistantInboundAudit {
  if (!log) return () => {};
  return (entry) => {
    const level = entry.kind === "processed" || entry.kind === "duplicate" ? "info" : "warn";
    log(level, "inbound home assistant channel", { ...entry });
  };
}

/**
 * The Home Assistant transport, config-gated on the access token and the
 * channel record.
 *
 * It reads three things from the host's own surfaces - the base URL and the
 * linked service from the `messagingHomeAssistant` section, the long-lived
 * access token from the secret store under
 * `secret:messaging-home-assistant:access-token` - and only then opens the
 * websocket. With any of them missing it returns without opening anything, so
 * an install with no Home Assistant channel configured starts no loop and
 * behaves exactly as it did before this channel existed.
 *
 * The base URL goes through the shared endpoint rule twice: once for the REST
 * send path ([`homeAssistantApiBase`]) and once for the websocket address
 * ([`homeAssistantWebSocketUrl`]), so a plaintext Home Assistant is accepted
 * only on a loopback/`.local`/private-LAN host under the relaxed policy. The
 * service name is validated before it becomes a path. No port is bound: the
 * websocket is one the Host originates.
 */
function createConfiguredHomeAssistantTransport(
  options: MessagingHomeAssistantWiringOptions,
): MessagingInboundPushTransport {
  return {
    async start(onMessage, signal): Promise<void> {
      let token: string | null = null;
      try {
        token = await options.secrets(MESSAGING_HOME_ASSISTANT_ACCESS_TOKEN_SECRET_REF);
      } catch {
        token = null;
      }
      if (!token || !token.trim()) return;
      let settings: unknown;
      try {
        settings = await options.settings.read();
      } catch {
        return;
      }
      const record = readTransportRecord(settings, MESSAGING_HOME_ASSISTANT_SECTION);
      if (!record.endpoint || !record.destination) return;
      const allowInsecureHttp = allowInsecureUserEndpoints(settings);
      const base = homeAssistantApiBase(record.endpoint, { allowInsecureHttp });
      if (!base.ok) {
        options.log?.("warn", "inbound home assistant channel has an unusable endpoint", {
          error: base.error,
        });
        return;
      }
      const url = homeAssistantWebSocketUrl(record.endpoint, { allowInsecureHttp });
      if (!url.ok) {
        options.log?.("warn", "inbound home assistant channel has an unusable endpoint", {
          error: url.error,
        });
        return;
      }
      const service = parseHomeAssistantService(record.destination);
      if (!service.ok) {
        options.log?.("warn", "inbound home assistant channel names no usable service", {
          error: service.error,
        });
        return;
      }
      await createHomeAssistantInboundPushTransport({
        client: {
          base: base.base,
          url: url.url,
          token: token.trim(),
          service: record.destination,
          handled: createSettingsHandledMessageStore({
            settings: options.settings,
            section: MESSAGING_HOME_ASSISTANT_SECTION,
            capacity: HOME_ASSISTANT_HANDLED_CAPACITY,
          }),
          audit: createHomeAssistantInboundAudit(options.log),
          connect: options.connect ?? createWsHomeAssistantSocketFactory(),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
        ...(options.wait ? { wait: options.wait } : {}),
      }).start(onMessage, signal);
    },
  };
}

/**
 * The wiring for the inbound Home Assistant channel over its websocket.
 *
 * The same driver, binding store and target resolver as every other channel,
 * over a websocket the Host originates and a REST service call for replies. The
 * section (`messagingHomeAssistant`), the linked service it names as
 * `destination`, and the one secret (the long-lived access token) are the only
 * differences.
 *
 * # What inbound is, said plainly
 *
 * Home Assistant has no chat surface that hands a third-party agent a message.
 * This channel receives messages only when an automation in the user's Home
 * Assistant fires `qianning_message` with `data.text`. Without that automation
 * the channel still sends - every reply goes to the linked service - and
 * receives nothing. That is the honest shape of the integration, and the
 * settings panel states it instead of implying a chat window that does not
 * exist.
 */
export type MessagingHomeAssistantWiringOptions = {
  agentHost: MessagingInboundHostSurface;
  settings: HostSettingsSurface;
  secrets: HostSecretReader;
  signal: AbortSignal;
  log?: MessagingInboundWiringLog;
  /** Test seam: the websocket client factory, in place of the `ws` one. */
  connect?: HomeAssistantSocketFactory;
  /** Test seam: the HTTP client, in place of the platform fetch. */
  fetchImpl?: HomeAssistantFetch;
  /** Test seam: how the reconnect loop waits. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam: a push transport in place of the one built from the settings. */
  transport?: MessagingInboundPushTransport;
};

export function createHomeAssistantInboundWiring(
  options: MessagingHomeAssistantWiringOptions,
): MessagingInboundWiring {
  return createIngressWiring({
    agentHost: options.agentHost,
    settings: options.settings,
    signal: options.signal,
    ...(options.log ? { log: options.log } : {}),
    channel: HOME_ASSISTANT_INBOUND_CHANNEL,
    transport: options.transport ?? createConfiguredHomeAssistantTransport(options),
    failureLabel: "inbound home assistant loop failed",
  });
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
