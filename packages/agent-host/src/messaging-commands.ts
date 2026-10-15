import { RACP_PERMISSION_MODES } from "@pi-desktop/shared";
import type {
  RacpApprovalDecision,
  RacpPermissionMode,
  RacpRequestContext,
} from "@pi-desktop/shared";

import type { Principal } from "./ports.js";

/**
 * The fixed command vocabulary the outbound messaging integration accepts from
 * a linked chat (ADR 0205 D375 item 9, rollout R3 §1): a closed set of plain
 * lowercase words, one word per operation, each written after a leading slash.
 *
 * Accepted syntax (closed — nothing outside this list is a command):
 *
 *   /start <text>   turn/start; `<text>` is the prompt and is required
 *   /stop           turn/stop for the target turn
 *   /interrupt      turn/interrupt for the target turn
 *   /approve        approval/respond with decision "approve"
 *   /reject         approval/respond with decision "reject"
 *   /allow-once     approval/respond with decision "allow-once"
 *   /allow-session  approval/respond with decision "allow-session"
 *   /deny           approval/respond with decision "deny"
 *
 * The leading slash is required: a command is unambiguously addressed, so an
 * ordinary sentence is never mistaken for one. The word is the first
 * whitespace-delimited token of the slash-prefixed message; the text after it
 * is the argument text. Only `/start` takes argument text, and it is required;
 * every other word takes none. A message without a leading slash is ordinary
 * chat and is refused as not-a-command, never as an unknown command.
 */
export const MESSAGING_COMMAND_WORDS = [
  "start",
  "stop",
  "interrupt",
  "approve",
  "reject",
  "allow-once",
  "allow-session",
  "deny",
] as const;

export type MessagingCommandWord = (typeof MESSAGING_COMMAND_WORDS)[number];

/**
 * The permission modes an approval response may carry. Exposed so a channel can
 * offer them as the choices for a contract approval; the mode itself is always
 * supplied by the caller and never invented here.
 */
export const MESSAGING_PERMISSION_MODES = RACP_PERMISSION_MODES;

/** The decision a command word names, for the five approval decision values. */
const DECISION_WORDS: Readonly<Record<string, RacpApprovalDecision>> = {
  approve: "approve",
  reject: "reject",
  "allow-once": "allow-once",
  "allow-session": "allow-session",
  deny: "deny",
};

/**
 * The decisions that cannot be expressed without a permission mode. A contract
 * approval's positive decision must name a mode drawn from the approval's
 * allowed modes; the tool decisions and a rejection carry none.
 */
const DECISIONS_REQUIRING_PERMISSION_MODE: ReadonlySet<RacpApprovalDecision> = new Set(["approve"]);

/**
 * The identifiers a command may act on, resolved by the channel adapter from
 * the message it received. Exactly the ids the four operations need; a command
 * whose required id is absent is refused as malformed.
 */
export interface MessagingCommandTarget {
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
}

/**
 * One inbound chat message as the mapping layer sees it. The adapter supplies
 * the text, the linked principal (absent when the chat is unlinked), the target
 * ids, the request context to carry onto the operation, and — for a contract
 * approval — the permission mode the caller chose.
 */
export interface MessagingCommandInput {
  /** The raw message text exactly as received. */
  text: string;
  /** The principal the chat is linked to; absent means the chat is unlinked. */
  principal?: Principal;
  /** Identifiers the command acts on. */
  target?: MessagingCommandTarget;
  /** Request context minted by the adapter and carried onto the operation. */
  context?: RacpRequestContext;
  /** The permission mode the caller chose, for a contract approval. */
  permissionMode?: RacpPermissionMode;
}

/**
 * A request for one of the four operations, with its parameters. It names the
 * operation and carries the ids and input the operation takes; the request
 * context rides along untouched, and a contract approval — the one decision
 * that cannot be expressed without a mode — carries the caller's chosen
 * permission mode, while a tool decision or a rejection carries none even when
 * the caller supplied one. The context is required exactly where the operation
 * needs it — `turn/start` and `approval/respond` — and optional for the two
 * turn-control operations, which take no context. This layer never decides
 * whether the request is permitted.
 */
export type MessagingCommandRequest =
  | { operation: "turn/start"; sessionId: string; input: { text: string }; context: RacpRequestContext }
  | { operation: "turn/stop"; turnId: string; context?: RacpRequestContext }
  | { operation: "turn/interrupt"; turnId: string; context?: RacpRequestContext }
  | {
      operation: "approval/respond";
      approvalId: string;
      decision: RacpApprovalDecision;
      context: RacpRequestContext;
      permissionMode?: RacpPermissionMode;
    };

/**
 * Why a message did not produce a request. Each kind is typed so the caller can
 * act on it: `not-a-command` and `malformed-arguments` are ordinary chat noise
 * (a message with no leading slash, and a command that is not well-formed or
 * lacks a required argument), `unknown-command` is a mistaken command, and
 * `unlinked-chat` must be ignored and audited (rollout R3 §1).
 */
export type MessagingCommandRefusalKind =
  | "not-a-command"
  | "unknown-command"
  | "malformed-arguments"
  | "unlinked-chat";

/** A typed refusal with the detail an audit record keeps. */
export interface MessagingCommandRefusal {
  kind: MessagingCommandRefusalKind;
  detail: string;
}

/**
 * The outcome of mapping one message: either a request for an operation,
 * carrying the linked principal for the role gate to judge, or a typed refusal.
 */
export type MessagingCommandOutcome =
  | { accepted: true; principal: Principal; request: MessagingCommandRequest }
  | { accepted: false; refusal: MessagingCommandRefusal };

function refuse(kind: MessagingCommandRefusalKind, detail: string): MessagingCommandOutcome {
  return { accepted: false, refusal: { kind, detail } };
}

/**
 * Map one inbound chat message onto one of the four turn and approval
 * operations, or return a typed refusal.
 *
 * Pure and total: no state, transport, timer, clock, or I/O, and it never
 * throws for bad input — a non-string message text is a typed refusal, not an
 * exception, and the same input always yields the same outcome. It passes the
 * linked principal through unchanged and performs no role or permission check
 * of its own; the Host's existing per-operation gate decides. It reads no
 * envelope payload or transcript content, and it neither reads a context from
 * ambient state nor invents one: a context is consumed only when the adapter
 * supplied it.
 */
export function mapMessagingCommand(input: MessagingCommandInput): MessagingCommandOutcome {
  // Link first: an unlinked chat can never yield a request, and its message is
  // refused in a way the caller audits rather than silently drops.
  const principal = input.principal;
  if (!principal) {
    return refuse("unlinked-chat", "chat is not linked to a principal");
  }

  // The text is untrusted input from the channel: defend the type so a
  // non-string never reaches `trim`.
  if (typeof input.text !== "string") {
    return refuse("malformed-arguments", "message text is not a string");
  }

  const trimmed = input.text.trim();
  if (trimmed.length === 0) {
    return refuse("not-a-command", "message is empty");
  }

  const spaceIndex = trimmed.search(/\s/);
  const rawWord = spaceIndex < 0 ? trimmed : trimmed.slice(0, spaceIndex);
  const argumentText = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1).trim();

  // A command is addressed with a leading slash; anything else is ordinary chat.
  if (!rawWord.startsWith("/")) {
    return refuse("not-a-command", "a command must begin with a slash");
  }
  const word = rawWord.slice(1);
  if (word.length === 0) {
    return refuse("unknown-command", "a slash with no command word");
  }

  const known = (MESSAGING_COMMAND_WORDS as readonly string[]).includes(word);
  if (!known) {
    return refuse("unknown-command", `unrecognised command word "${word}"`);
  }

  const target = input.target ?? {};
  const context = input.context;

  if (word === "start") {
    if (argumentText.length === 0) {
      return refuse("malformed-arguments", "start requires prompt text");
    }
    const sessionId = target.sessionId;
    if (!sessionId) {
      return refuse("malformed-arguments", "start requires a sessionId");
    }
    if (!context) {
      return refuse("malformed-arguments", "start requires a request context");
    }
    return {
      accepted: true,
      principal,
      request: { operation: "turn/start", sessionId, input: { text: argumentText }, context },
    };
  }

  const decision = DECISION_WORDS[word];
  if (decision) {
    if (argumentText.length > 0) {
      return refuse("malformed-arguments", `${word} takes no argument text`);
    }
    const approvalId = target.approvalId;
    if (!approvalId) {
      return refuse("malformed-arguments", `${word} requires an approvalId`);
    }
    const permissionMode = input.permissionMode;
    if (DECISIONS_REQUIRING_PERMISSION_MODE.has(decision) && !permissionMode) {
      return refuse(
        "malformed-arguments",
        `${word} requires a permissionMode for a contract approval`,
      );
    }
    if (!context) {
      return refuse("malformed-arguments", `${word} requires a request context`);
    }
    return {
      accepted: true,
      principal,
      request: {
        operation: "approval/respond",
        approvalId,
        decision,
        context,
        // The mode rides along only on the one decision that cannot be
        // expressed without it; a tool decision or a rejection carries none,
        // even when the caller supplied one.
        ...(DECISIONS_REQUIRING_PERMISSION_MODE.has(decision) && permissionMode
          ? { permissionMode }
          : {}),
      },
    };
  }

  // The remaining words are the two turn-control operations, which take no
  // request context.
  if (argumentText.length > 0) {
    return refuse("malformed-arguments", `${word} takes no argument text`);
  }
  const turnId = target.turnId;
  if (!turnId) {
    return refuse("malformed-arguments", `${word} requires a turnId`);
  }
  return {
    accepted: true,
    principal,
    request: {
      operation: word === "stop" ? "turn/stop" : "turn/interrupt",
      turnId,
      ...(context ? { context } : {}),
    },
  };
}
