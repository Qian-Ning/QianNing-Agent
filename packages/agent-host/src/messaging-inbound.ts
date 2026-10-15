import type {
  RacpPermissionMode,
  RacpRequestContext,
  RacpRole,
} from "@pi-desktop/shared";
import { classifyIpLiteral, RACP_PERMISSION_MODES, RACP_ROLES } from "@pi-desktop/shared";

import type { AgentHost } from "./agent-host.js";
import {
  mapMessagingCommand,
  type MessagingCommandRefusal,
  type MessagingCommandRefusalKind,
  type MessagingCommandRequest,
  type MessagingCommandTarget,
} from "./messaging-commands.js";
import { RandomIds, type IdSource, type Principal } from "./ports.js";

/**
 * The inbound command path for the messaging integration (ADR 0205 D375 item 9,
 * rollout R3), Telegram only.
 *
 * A linked chat's message is mapped by the existing command vocabulary
 * ([`mapMessagingCommand`]) onto the four operations the Host already exposes,
 * and each operation is invoked through the *same* Agent Host surface the RACP
 * websocket handlers call — `AgentHost.startTurn`, `stopTurn`, `interruptTurn`,
 * `respondApproval` — with an explicit [`Principal`] and a
 * [`RacpRequestContext`]. There is no parallel admission path, no new operation
 * verb, no own permission policy, and no second registry: the module only
 * decides which of the existing operations a message names, who it runs as, and
 * which ids it acts on. The role gate those methods apply is the whole
 * permission decision this path gets.
 *
 * The receive loop reaches Telegram by an *outbound* long poll — an ordinary
 * HTTPS request the Host originates. Nothing here binds a port, accepts a
 * connection, or opens a listener, so the acceptance precondition "no inbound
 * port is open on the Host machine" stays true.
 *
 * # Boundaries, stated once
 *
 * - **Slack inbound is deferred.** Its socket mode needs a websocket client and
 *   the tree has none; adding that dependency is the maintainer's decision.
 *   Outbound Slack is unchanged.
 * - No inbound listener, no bound port, no accepting socket.
 * - No new operation verb, no parallel admission path, no permission policy
 *   beyond the role gate, and no raw transcript content on the wire: a message
 *   carries only its own text, and only the message's own text is read.
 * - No second enqueue path and no second registry.
 * - The mapper's output is what is routed; command parsing is never restated.
 *
 * # Wiring
 *
 * The driver is constructed by `createMessagingInboundWiring` in
 * `@pi-desktop/host-runtime`, which both composition roots call: the desktop
 * main process (`electron/main/bootstrap/startup.ts`) and the headless entry
 * point (`apps/pi-host/src/app.ts`). That factory hands the driver the
 * channel's settings section read through the host's settings surface, the bot
 * token read through the secret store, a cursor store and a
 * conversation-to-session binding store over that same settings row, the audit
 * sink, and an abort signal the root owns. Each root aborts its own controller
 * on shutdown and awaits the loop's completion, bounded by a short budget the
 * way a quit bounds its wait on an unresponsive provider. The loop re-checks
 * the signal *between* iterations, so after an abort it leaves `run` as soon as
 * the current iteration returns; a single in-flight iteration can still be
 * waiting on a host RPC whose own deadline is far longer, which is exactly why
 * the roots bound that wait rather than awaiting it unbounded. Nothing here
 * depends on that step: the operation surface, the transport, the link, the
 * cursor and the binding are all injected, so the wiring is composition only.
 *
 * The binding has a production writer: the host-internal
 * `pi-desktop/messagingInbound/bindSession` IPC handler calls
 * [`bindMessagingInboundSession`] in `@pi-desktop/host-runtime`, which writes
 * `inbound.sessionId` in the channel's settings section through the host's own
 * `settings.set`. Until that writer lands, a linked chat has no binding and
 * every command is refused, so the loop can only refuse; with it, a bound
 * conversation reaches an operation.
 *
 * The poll cursor is persisted, not only held in memory: the wiring's cursor
 * store rides the same `app` settings row the link is read from, so a restart
 * resumes at the last offset the driver saved instead of replaying from zero. A
 * store that lives only in memory would leave a restart free to replay whatever
 * the platform redelivers.
 *
 * The current-session lookup is the persisted conversation-to-session binding
 * ([`InboundSessionDirectory`]), stored per linked conversation in the same
 * settings row; the rest of the target is read from the Agent Host's own
 * snapshot, read under the acting principal, so the Host's ownership rule
 * applies before a target is built. This module performs no session-ownership
 * check of its own, and must not: the boundary is the Host's, and a channel
 * that restated it would be a second policy. The Host admits a principal to a
 * session when it holds the `owner` role or when its subject is the session's
 * recorded owner (ADR 0325), and the wiring makes the linked principal that
 * owner when the operator binds the conversation. A session with no recorded
 * owner is host-local. What still protects the session choice is that the
 * binding is written only through the host's internal `settings.set` path,
 * which no RACP peer can reach (the operation table does not name `settings`,
 * pinned by a test in `@pi-desktop/shared`); and that a chat with no binding
 * yields no target and is refused before any operation runs.
 *
 * # The lock rule
 *
 * No host state is held across the long poll. [`MessagingInboundDriver::pollOnce`]
 * awaits the transport and calls no Agent Host method while that poll is
 * outstanding; an operation runs only after a poll has returned with messages.
 * A poll failure is reported through the audit sink and never propagates out of
 * [`MessagingInboundDriver::run`], so a channel that is unreachable or answers
 * garbage cannot take the Host down, and a slow poll cannot hold up a local
 * turn.
 *
 * # The transport refuses the wrong destination before it sends a token
 *
 * [`createTelegramInboundTransport`] parses the configured address with the
 * platform's own URL API (`new URL`) and applies the endpoint rule the Rust
 * channels apply: the scheme must be HTTPS, or plaintext HTTP only for a
 * loopback, `.local`, or private LAN host under the relaxed network policy;
 * userinfo is refused; a host is required.
 *
 * The plaintext LAN-host exception has one authoritative copy: the Rust helper
 * the config-sync transport and the outbound webhook channel both reuse, kept in
 * one place there so those two plaintext exceptions cannot drift apart. This
 * module cannot call it, so [`isLanHttpHost`] restates it and must stay equal to
 * it — including the corner where the two classifiers would otherwise differ. An
 * IPv4-mapped or IPv4-compatible literal such as `[::ffff:127.0.0.1]` or
 * `[::10.0.0.1]` is an ordinary IPv6 address to Rust: its loopback test is
 * false and its network prefix is neither ULA nor link-local, so Rust refuses
 * it. The shared classifier instead folds the embedded IPv4 into the IPv4
 * policy and would accept a mapped loopback or private address, so that fold is
 * undone here and the plaintext exception is no wider on this side than on the
 * Rust side. [`isLanHttpHost`] is the copy; the Rust helper is the source of
 * truth, and a change to one must change the other.
 *
 * The rule judges the endpoint before the bot token is appended to its path, so
 * the token only ever reaches an address that already passed. Redirect following
 * is disabled outright, because the token sits in the request path and a
 * redirect would carry it to whatever host the answer names: a redirect is
 * reported as a failure rather than followed.
 *
 * # The replay guard, and the cursor that outlives it
 *
 * The guard is a bounded in-memory log keyed on the conversation together with
 * the message id — the platform's message id is unique per conversation, not
 * globally, so the conversation is part of the key. A message is recorded only
 * once it has been accepted for handling, i.e. once its conversation has matched
 * the link; a message from an unlinked conversation is never recorded and leaves
 * no trace in the log.
 *
 * The log does not survive a process restart: after a restart it is empty. What
 * stops a restart from replaying history is the *cursor*, not the guard. The
 * poll offset is persisted through a [`MessagingInboundCursorStore`] — the
 * settings surface the link already rides, so the cursor needs no new store and
 * no new verb — and [`MessagingInboundDriver::run`] reloads it before the first
 * poll, so a restart resumes from the last offset this driver saved instead of
 * from zero, and the platform suppresses the updates it has already had
 * confirmed.
 *
 * The poll applies a returned batch in full and only then advances and saves the
 * cursor, which makes this path **at-least-once**. A crash in the window between
 * applying the batch and saving the cursor causes those commands to be offered
 * again on the next run. Nothing suppresses that copy: the guard is empty after
 * a restart, so it is re-applied, and the ordering still cannot cause a command
 * to be silently dropped. (Had
 * the cursor been saved before the batch was applied, a crash in the window
 * before the batch ran would drop those commands with no trace; that ordering is
 * deliberately not used.) The save is conditional on the offset having actually
 * moved, so an idle poll writes nothing. A cursor store that cannot be written is
 * reported through the audit sink and the last good offset stays in place: a
 * persistently failing store degrades to a replay from the last offset that did
 * save — a re-application nothing can suppress after a restart — and it never
 * advances the cursor past an unsaved batch.
 *
 * The guard is a second line for a redelivery that arrives *within one run*,
 * including one arriving while the first copy is still being applied; it does
 * not stop a redelivery that spans a restart — nothing here does — which is why
 * the cursor is the part that must be durable and the guard is documented as
 * best-effort per run.
 *
 * The guard is bounded to [`DEFAULT_HANDLED_CAPACITY`] keys, oldest evicted
 * first: after that many messages have been accepted, a redelivery of an older
 * message is no longer recognised as a duplicate. The bound exists so a chatty
 * or hostile channel cannot grow the log without limit.
 *
 * The message's own id is the guard because the request context does not cover
 * this path: `startTurn` alone reads `context.idempotencyKey`, `respondApproval`
 * never reads the response context, and `turn/stop` and `turn/interrupt` take
 * only a turn id. A driver-side log of handled messages is therefore what stops
 * a redelivered message acting twice within a run, and it covers every operation
 * this path can invoke — not just the one the context would have covered.
 *
 * # Limits
 *
 * Every transport test runs against a plaintext loopback server, so the `https`
 * transport path is never exercised end to end: only the endpoint rule is
 * covered for HTTPS, not a real TLS exchange against a remote host. A TLS test
 * fixture is not built here, so the secure transport is validated by the
 * endpoint rule and by construction rather than by an end-to-end test.
 */

/** The settings section the Telegram channel's record lives in, inside `app`. */
export const MESSAGING_TELEGRAM_SECTION = "messagingTelegram";
/** The record's self-identifying format, beside the outbound channel's own. */
export const MESSAGING_TELEGRAM_FORMAT = "pi-desktop-messaging-telegram";
/** The record version this build reads. */
export const MESSAGING_TELEGRAM_FORMAT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRole(value: unknown): RacpRole | null {
  return typeof value === "string" && (RACP_ROLES as readonly string[]).includes(value)
    ? (value as RacpRole)
    : null;
}

function readPermissionMode(value: unknown): RacpPermissionMode | null {
  return typeof value === "string" && (RACP_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as RacpPermissionMode)
    : null;
}

/**
 * The chat-to-principal link: the conversation an inbound command may come
 * from, the principal it runs as, and the permission mode a contract approval
 * carries.
 *
 * The mode travels out of band, as a channel setting beside the link — never
 * through the message text, whose vocabulary is unchanged.
 */
export type MessagingInboundLink = {
  /** The one conversation whose messages may act: the record's `destination`. */
  chatId: string;
  /** The principal an admitted command runs as. */
  principal: Principal;
  /** The mode a contract approval's positive decision carries, when configured. */
  permissionMode?: RacpPermissionMode;
};

/**
 * Read the inbound link out of the channel's settings section, or `null` when
 * the conversation is not linked.
 *
 * The section is the one the outbound channel already writes
 * (`messagingTelegram`, read from the shared `app` settings row), so the link
 * rides the existing settings surface and the existing `settings.set` verb; no
 * new store and no new namespace. The record's `format` and `version` are
 * checked, so a record this build cannot read is not linked rather than
 * half-read.
 *
 * Fail closed: every way of not being a complete link — an absent or null
 * section, a foreign format, a read-version mismatch, no `destination`, no
 * `inbound` object, no `inbound.linkedPrincipal.subject`, or an empty role list
 * — yields `null`, which the driver treats as "not linked" and audits. A mode
 * that is not one of the accepted modes is dropped, not trusted.
 */
export function readInboundLink(section: unknown): MessagingInboundLink | null {
  if (!isRecord(section)) return null;
  if (section.format !== MESSAGING_TELEGRAM_FORMAT) return null;
  if (section.version !== MESSAGING_TELEGRAM_FORMAT_VERSION) return null;

  const chatId = typeof section.destination === "string" ? section.destination.trim() : "";
  if (!chatId) return null;

  const inbound = section.inbound;
  if (!isRecord(inbound)) return null;

  const linked = inbound.linkedPrincipal;
  if (!isRecord(linked)) return null;

  const subject = typeof linked.subject === "string" ? linked.subject.trim() : "";
  if (!subject) return null;

  const roles = Array.isArray(linked.roles)
    ? linked.roles.map(readRole).filter((role): role is RacpRole => role !== null)
    : [];
  if (roles.length === 0) return null;

  const permissionMode = readPermissionMode(inbound.permissionMode);
  return {
    chatId,
    principal: { subject, roles },
    ...(permissionMode ? { permissionMode } : {}),
  };
}

/** One inbound message, as the channel's receive loop sees it. */
export type TelegramInboundMessage = {
  /** The platform's update id, the long poll's cursor. */
  updateId: number;
  /** The message's own id; with the conversation, the replay guard's key. */
  messageId: string;
  /** The conversation the message came from. */
  chatId: string;
  /** The message text exactly as received. */
  text: string;
};

/** One long poll's answer. */
export type TelegramPollResult =
  | { ok: true; messages: TelegramInboundMessage[]; nextOffset: number }
  | { ok: false; error: string; retryAfterMs?: number };

/**
 * How the receive loop reaches the channel. An implementation performs one
 * outbound long poll and returns; it opens no listener and holds no Host state.
 * A failure is reported in the result, never thrown, so the loop owns its own
 * error handling.
 */
export interface TelegramInboundTransport {
  poll(offset: number, signal?: AbortSignal): Promise<TelegramPollResult>;
}

/** Where the current link is read from, once per message. */
export type MessagingInboundConfig = { link: MessagingInboundLink | null };
export type MessagingInboundConfigSource = () => Promise<MessagingInboundConfig | null>;

/**
 * Where the poll cursor is persisted so a restart resumes instead of replaying.
 *
 * `load` answers the offset the next poll should ask from, or `null` when no
 * position has been stored yet; `save` writes the offset a poll advanced to. The
 * wiring backs this with the same `app` settings row the link is read from, so
 * the cursor rides the existing settings surface and the existing `settings.set`
 * verb — no new store and no new namespace. The driver reads it once, at the
 * start of [`MessagingInboundDriver::run`], and writes it after a poll's batch
 * has been applied, whenever the offset has advanced.
 */
export interface MessagingInboundCursorStore {
  load(): Promise<number | null>;
  save(offset: number): Promise<void>;
}

/**
 * Resolve the operation target for a principal.
 *
 * A chat message carries no ids, so an operation that names no target acts on
 * the session the linked chat is bound to and that session's active turn — this
 * is the one place that decision is made. The wiring resolves the session from
 * the persisted conversation-to-session binding (see the wiring note), never
 * from the message: the message text carries no ids, and a chat with no binding
 * yields no target at all.
 */
export interface InboundSessionDirectory {
  resolve(principal: Principal): Promise<MessagingCommandTarget>;
}

/** One audit record. Structure and ids only — never message text. */
export type MessagingInboundAuditEntry =
  | { kind: "unlinked-chat"; chatId: string; messageId: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "refused"; messageId: string; refusalKind: MessagingCommandRefusalKind; detail: string }
  | { kind: "operation"; messageId: string; operation: MessagingCommandRequest["operation"] }
  | { kind: "operation-failed"; messageId: string; operation: string; error: string }
  | { kind: "cursor-save-failed"; error: string }
  | { kind: "poll-failed"; error: string };

export type MessagingInboundAudit = (entry: MessagingInboundAuditEntry) => void;

/** What handling one message did. */
export type MessagingInboundOutcome =
  | { kind: "duplicate"; messageId: string }
  | { kind: "unlinked"; messageId: string }
  | { kind: "refused"; messageId: string; refusal: MessagingCommandRefusal }
  | { kind: "invoked"; messageId: string; operation: MessagingCommandRequest["operation"] }
  | { kind: "failed"; messageId: string; error: string };

/** The operation surface the driver routes into. */
export type MessagingInboundOperationSurface = Pick<
  AgentHost,
  "startTurn" | "stopTurn" | "interruptTurn" | "respondApproval"
>;

export type MessagingInboundOptions = {
  /** The existing Agent Host surface; the same object the RACP handlers call. */
  agentHost: MessagingInboundOperationSurface;
  transport: TelegramInboundTransport;
  readConfig: MessagingInboundConfigSource;
  targets: InboundSessionDirectory;
  audit?: MessagingInboundAudit;
  ids?: IdSource;
  /** How many accepted messages the replay log remembers before evicting. */
  handledCapacity?: number;
  /** Where the poll cursor is persisted; absent means this run only, from zero. */
  cursor?: MessagingInboundCursorStore;
  /** How the loop waits between polls; injectable so tests run without sleeps. */
  wait?: (ms: number) => Promise<void>;
};

/** How many accepted messages the replay log remembers before evicting the oldest. */
const DEFAULT_HANDLED_CAPACITY = 4096;
/** How long the loop waits after a failed poll before trying again. */
const POLL_FAILURE_DELAY_MS = 5_000;
/** The least the loop waits between polls, so a fast answer cannot spin it. */
const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * The driver-side replay log. Keyed on the conversation together with the
 * message id, because the platform's message id is unique per conversation and
 * not globally. Bounded, so a chatty or hostile channel cannot grow it without
 * limit; the oldest key is evicted first, which keeps the guard meaningful for
 * the window a redelivery can plausibly arrive in.
 */
class HandledMessageLog {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.seen.has(key);
  }

  record(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}

/** The guard's key: the conversation and the message id, which is unique only per chat. */
function handledKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

/**
 * The inbound command driver: one linked conversation, one long-poll loop, the
 * four existing operations as its only effects.
 */
export class MessagingInboundDriver {
  private readonly agentHost: MessagingInboundOperationSurface;
  private readonly transport: TelegramInboundTransport;
  private readonly readConfig: MessagingInboundConfigSource;
  private readonly targets: InboundSessionDirectory;
  private readonly audit: MessagingInboundAudit;
  private readonly ids: IdSource;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly handled: HandledMessageLog;
  private readonly cursor: MessagingInboundCursorStore | null;
  private offset = 0;

  constructor(options: MessagingInboundOptions) {
    this.agentHost = options.agentHost;
    this.transport = options.transport;
    this.readConfig = options.readConfig;
    this.targets = options.targets;
    this.audit = options.audit ?? (() => {});
    this.ids = options.ids ?? new RandomIds();
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.handled = new HandledMessageLog(options.handledCapacity ?? DEFAULT_HANDLED_CAPACITY);
    this.cursor = options.cursor ?? null;
  }

  /** The poll cursor: the offset the next poll asks from. */
  get nextOffset(): number {
    return this.offset;
  }

  /**
   * Handle one inbound message.
   *
   * The guard is keyed on the conversation together with the message id, and a
   * message is recorded only once it has been accepted for handling — i.e. once
   * its conversation has matched the link. A message from an unlinked
   * conversation is never recorded, so it leaves no trace in the guard; a
   * redelivered copy of an accepted message is recognised as a duplicate, for
   * every operation this path can invoke and not only the one the request
   * context would have covered. The guard is in memory and covers one run: a
   * restart is covered by the persisted cursor, not by the guard (see the module
   * note). A linked record that is absent or incomplete is ignored and audited
   * and never reaches an operation. A refusal from the mapper, and any error the
   * Host raises while applying a command, are outcomes of this call, never
   * exceptions.
   */
  async handleMessage(message: TelegramInboundMessage): Promise<MessagingInboundOutcome> {
    const key = handledKey(message.chatId, message.messageId);
    if (this.handled.has(key)) {
      this.audit({ kind: "duplicate", messageId: message.messageId });
      return { kind: "duplicate", messageId: message.messageId };
    }

    const config = await this.readConfig().catch(() => null);
    const link = config?.link ?? null;
    if (!link || link.chatId !== message.chatId) {
      // Absent configuration means not linked. An unlinked chat is ignored and
      // audited — never admitted, never an error the remote side can probe, and
      // never recorded in the guard, so it consumes no guard entry.
      this.audit({ kind: "unlinked-chat", chatId: message.chatId, messageId: message.messageId });
      return { kind: "unlinked", messageId: message.messageId };
    }
    // Accepted for handling: record the key now, before any operation runs, so a
    // redelivery arriving while this copy is being applied is a duplicate.
    this.handled.record(key);

    const target = await this.targets.resolve(link.principal).catch(() => ({}));
    const context: RacpRequestContext = { requestId: this.ids.next("msg") };
    const mapped = mapMessagingCommand({
      text: message.text,
      principal: link.principal,
      target,
      context,
      ...(link.permissionMode ? { permissionMode: link.permissionMode } : {}),
    });
    if (!mapped.accepted) {
      this.audit({
        kind: "refused",
        messageId: message.messageId,
        refusalKind: mapped.refusal.kind,
        detail: mapped.refusal.detail,
      });
      return { kind: "refused", messageId: message.messageId, refusal: mapped.refusal };
    }

    return this.invoke(message.messageId, link.principal, mapped.request);
  }

  /** Apply one mapped request through the existing operation surface. */
  private async invoke(
    messageId: string,
    principal: Principal,
    request: MessagingCommandRequest,
  ): Promise<MessagingInboundOutcome> {
    try {
      switch (request.operation) {
        case "turn/start":
          await this.agentHost.startTurn(principal, {
            sessionId: request.sessionId,
            input: { text: request.input.text },
            context: request.context,
          });
          break;
        case "turn/stop":
          await this.agentHost.stopTurn(principal, request.turnId);
          break;
        case "turn/interrupt":
          await this.agentHost.interruptTurn(principal, request.turnId);
          break;
        case "approval/respond":
          await this.agentHost.respondApproval(principal, {
            approvalId: request.approvalId,
            decision: request.decision,
            // The mode rides only where the mapper kept it: the one decision
            // that cannot be expressed without it.
            ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
            context: request.context,
          });
          break;
      }
    } catch (error) {
      // A role refusal, a busy session, a stale target: an outcome, not a
      // crash. The loop must survive any of them.
      const detail = error instanceof Error ? error.message : String(error);
      this.audit({
        kind: "operation-failed",
        messageId,
        operation: request.operation,
        error: detail,
      });
      return { kind: "failed", messageId, error: detail };
    }
    this.audit({ kind: "operation", messageId, operation: request.operation });
    return { kind: "invoked", messageId, operation: request.operation };
  }

  /**
   * One long poll, then one handling pass per message it returned.
   *
   * The transport is awaited here and no Agent Host state is touched while it
   * is outstanding; a failed poll is audited and reported, and advances no
   * cursor. The batch is applied first and the cursor is advanced and saved only
   * afterwards, so the path is at-least-once: a crash in the window before the
   * save offers the batch again on the next run rather than dropping it (see the
   * module note). The offset only ever moves forward.
   */
  async pollOnce(
    signal?: AbortSignal,
  ): Promise<{ polled: boolean; outcomes: MessagingInboundOutcome[]; retryAfterMs?: number }> {
    const result = await this.transport.poll(this.offset, signal);
    if (!result.ok) {
      this.audit({ kind: "poll-failed", error: result.error });
      return {
        polled: false,
        outcomes: [],
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }
    const outcomes: MessagingInboundOutcome[] = [];
    for (const message of result.messages) {
      outcomes.push(await this.handleMessage(message));
    }
    // Advance and save only after the whole batch has been applied, and only
    // forward: a transport that answers a lower offset must not move the
    // persisted cursor backwards and make the platform replay updates this run
    // has already handled.
    if (result.nextOffset > this.offset) {
      this.offset = result.nextOffset;
      await this.saveCursor();
    }
    return { polled: true, outcomes };
  }

  /**
   * Reload the persisted poll cursor before the first poll of a run.
   *
   * A store that cannot be read leaves the cursor at zero, so the run starts
   * from the beginning of whatever the platform still holds — the state a run
   * had before a cursor store existed. A store that answers a stored position
   * moves the cursor there, so a restart does not replay updates the previous
   * run already confirmed.
   */
  private async loadCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      const saved = await this.cursor.load();
      if (typeof saved === "number" && Number.isFinite(saved) && saved > this.offset) {
        this.offset = saved;
      }
    } catch {
      // Nothing to recover here: the cursor stays where it is.
    }
  }

  /**
   * Persist the current cursor.
   *
   * A store that cannot be written is reported through the audit sink and the
   * last good offset stays in place: the next advance retries the write, and a
   * persistently failing store degrades to a replay from the last offset that
   * did save, which the in-run guard and the platform's own confirmation
   * suppress. It never advances the cursor past an unsaved batch.
   */
  private async saveCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      await this.cursor.save(this.offset);
    } catch (error) {
      this.audit({
        kind: "cursor-save-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Poll until `signal` aborts. Never throws: a failed poll waits a bounded
   * delay and tries again, so an unreachable channel can neither take the Host
   * down nor spin the CPU. The loop also waits a minimum interval after a poll
   * that returned, so a fast-returning channel cannot spin it either; a platform
   * back-off a poll carried (a `retryAfterMs`) is honoured as the longer wait.
   */
  async run(signal?: AbortSignal): Promise<void> {
    await this.loadCursor();
    while (!signal?.aborted) {
      let polled = false;
      let retryAfterMs = 0;
      try {
        const outcome = await this.pollOnce(signal);
        polled = outcome.polled;
        retryAfterMs = outcome.retryAfterMs ?? 0;
      } catch (error) {
        // Defensive: a transport that throws instead of returning is still a
        // poll failure, not a Host failure.
        this.audit({ kind: "poll-failed", error: error instanceof Error ? error.message : String(error) });
      }
      const floor = polled ? MIN_POLL_INTERVAL_MS : POLL_FAILURE_DELAY_MS;
      if (!signal?.aborted) await this.wait(Math.max(floor, retryAfterMs));
    }
  }
}

/**
 * The production target resolver: the session the wiring names as the
 * principal's current one, and that session's active turn and oldest open
 * approval, read from the Agent Host's own snapshot.
 *
 * The Host reads the session under the acting principal, so the ownership rule
 * applies before a target is built; the wiring supplies the session (the one
 * this chat is bound to) rather than deriving it from the catalog.
 */
export function createAgentHostTargets(
  agentHost: Pick<AgentHost, "snapshot">,
  currentSessionFor: (principal: Principal) => Promise<string | null>,
): InboundSessionDirectory {
  return {
    async resolve(principal: Principal): Promise<MessagingCommandTarget> {
      const sessionId = await currentSessionFor(principal);
      if (!sessionId) return {};
      const snapshot = await agentHost.snapshot(principal, sessionId);
      const target: MessagingCommandTarget = { sessionId };
      if (snapshot.activeTurn?.id) target.turnId = snapshot.activeTurn.id;
      const approvalId = snapshot.pendingApprovals[0]?.id;
      if (approvalId) target.approvalId = approvalId;
      return target;
    },
  };
}

/** How the production transport reaches the platform's inbound API. */
export type TelegramInboundTransportConfig = {
  /** The service endpoint, e.g. `https://api.telegram.org`. */
  endpoint: string;
  /** The bot token; appended to the path, the platform's own location. */
  token: string;
  /** How long one poll may stay open, in milliseconds. */
  requestTimeoutMs: number;
  /** The network policy's answer: is a plaintext hop to the user's own LAN allowed? */
  allowInsecureHttp?: boolean;
};

/**
 * The reason a configured endpoint was refused, or the endpoint to poll.
 *
 * The rule is the one the Rust channels apply, expressed here with the
 * platform's own URL API (`new URL`) and the shared address classifier rather
 * than by matching the address as a string: HTTPS is required, and a plaintext
 * `http` endpoint is accepted only for a loopback, `.local`, or private LAN host
 * under the relaxed network policy; a host is required; userinfo is refused
 * because it would be a credential in the URL. The plaintext LAN-host exception
 * is [`isLanHttpHost`], a copy of Rust's authoritative rule (see the module
 * note); it refuses an IPv4-mapped or IPv4-compatible literal that the shared
 * classifier would otherwise fold into the IPv4 policy, so a plaintext hop is
 * never wider here than on the Rust side. The query and fragment are dropped, so
 * the endpoint cannot smuggle a query into the poll URL. The rule judges the
 * endpoint on its own, before the bot token is appended to its path.
 */
export function validateInboundEndpoint(
  raw: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "the configured endpoint is not a URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "the endpoint must use HTTPS" };
  }
  if (!parsed.hostname) return { ok: false, error: "the endpoint must name a host" };
  if (parsed.username || parsed.password) {
    return { ok: false, error: "the endpoint must not contain userinfo" };
  }
  if (parsed.protocol === "http:") {
    if (options.allowInsecureHttp !== true) {
      return { ok: false, error: "plaintext HTTP requires the relaxed network policy" };
    }
    if (!isLanHttpHost(parsed.hostname)) {
      return {
        ok: false,
        error: "plaintext HTTP is limited to localhost, .local, or private LAN addresses",
      };
    }
  }
  parsed.search = "";
  parsed.hash = "";
  return { ok: true, url: parsed };
}

/**
 * Whether a plaintext `http` hop to `hostname` stays on the user's own machine
 * or LAN.
 *
 * This restates the authoritative Rust LAN-host helper that the config-sync
 * transport and the outbound webhook channel share; that copy is the source of
 * truth and this one must stay equal to it. The one place they would otherwise
 * differ is an IPv4-mapped or IPv4-compatible IPv6 literal (a `::ffff:...` or a
 * `::...` spelling of an IPv4 address): Rust parses it as an ordinary IPv6
 * address, whose loopback test is false and whose prefix is neither ULA nor
 * link-local, and refuses it, while the shared classifier folds the embedded
 * IPv4 into the IPv4 policy and would accept a mapped loopback or private
 * address. For an IPv6 literal this accepts only the exact loopback `::1`, a ULA
 * address, or a link-local address — the same set Rust accepts — so the
 * plaintext exception is no wider here. WHATWG URL canonicalises a mapped or
 * compatible literal to a `::`-prefixed form, so that shape test is exact.
 */
function isLanHttpHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "");
  if (host === "localhost" || host === "localhost.localdomain" || host.endsWith(".local")) {
    return true;
  }
  if (host.includes(":")) {
    // Canonical WHATWG spellings of an IPv4-mapped or IPv4-compatible literal
    // all begin with "::"; the only "::"-prefixed form both rules accept is the
    // exact loopback ::1, so any other "::" prefix is the embedded-IPv4 shape
    // Rust refuses.
    if (host === "::1") return true;
    if (host.startsWith("::")) return false;
    const kind = classifyIpLiteral(host);
    return kind === "ula" || kind === "link-local";
  }
  const kind = classifyIpLiteral(host);
  return kind === "loopback" || kind === "private" || kind === "link-local" || kind === "ula";
}

/**
 * The default transport: one outbound HTTPS long poll per call, over the
 * platform's own poll method.
 *
 * It opens no listener, binds no port, and holds nothing between calls. The
 * endpoint passes [`validateInboundEndpoint`] before the token is placed in the
 * request path — the platform's own credential location — so the token only
 * reaches an address that already passed the rule, and it never appears in a
 * returned error, so a failure detail cannot leak it. Redirect following is
 * disabled explicitly: because the token sits in the request path, a redirect
 * would carry it to whatever host the answer names, so a 3xx is reported as a
 * failure rather than followed. A non-2xx, an unreadable body, and a network
 * failure all become `{ ok: false }`, so the loop owns its own retry policy.
 */
export function createTelegramInboundTransport(
  config: TelegramInboundTransportConfig,
): TelegramInboundTransport {
  return {
    async poll(offset: number, signal?: AbortSignal): Promise<TelegramPollResult> {
      const token = config.token.trim();
      if (!token) return { ok: false, error: "the configured bot token is empty" };
      const endpoint = validateInboundEndpoint(config.endpoint, {
        allowInsecureHttp: config.allowInsecureHttp,
      });
      if (!endpoint.ok) return { ok: false, error: endpoint.error };
      const longPollSeconds = Math.max(0, Math.floor(config.requestTimeoutMs / 1000));
      const url = endpoint.url;
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/bot${token}/getUpdates`;
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("timeout", String(longPollSeconds));
      url.searchParams.set("allowed_updates", '["message"]');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          // The token is in the path, so a followed redirect could carry it to
          // another host; a redirect is answered as a failure, not followed.
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          return { ok: false, error: `the channel answered a redirect (HTTP ${response.status})` };
        }
        if (!response.ok) return { ok: false, error: `the channel answered HTTP ${response.status}` };
        const body = (await response.json()) as unknown;
        return parseUpdates(body, offset);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "the long poll failed",
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Project one poll body onto the messages it carries. */
function parseUpdates(body: unknown, offset: number): TelegramPollResult {
  if (!isRecord(body)) return { ok: false, error: "the channel response was not an object" };
  if (body.ok !== true) {
    const detail = typeof body.description === "string" ? body.description : "an unspecified error";
    // The platform's own back-off: `parameters.retry_after` in seconds asks the
    // loop to wait that long before polling again.
    const parameters = isRecord(body.parameters) ? body.parameters : undefined;
    const retryAfter = typeof parameters?.retry_after === "number" ? parameters.retry_after : null;
    return {
      ok: false,
      error: `the channel refused the poll: ${detail}`,
      ...(retryAfter !== null && retryAfter >= 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    };
  }
  const raw = Array.isArray(body.result) ? body.result : [];
  const messages: TelegramInboundMessage[] = [];
  let nextOffset = offset;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const updateId = typeof entry.update_id === "number" ? entry.update_id : null;
    if (updateId === null) continue;
    nextOffset = Math.max(nextOffset, updateId + 1);
    const message = entry.message;
    if (!isRecord(message)) continue;
    const messageId = typeof message.message_id === "number" ? String(message.message_id) : "";
    const chat = isRecord(message.chat) ? message.chat : undefined;
    const chatId = typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
    const text = typeof message.text === "string" ? message.text : "";
    if (!messageId || !chatId) continue;
    messages.push({ updateId, messageId, chatId, text });
  }
  return { ok: true, messages, nextOffset };
}
