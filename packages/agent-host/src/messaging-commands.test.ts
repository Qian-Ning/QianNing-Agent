import { describe, expect, it } from "vitest";
import type {
  RacpApprovalDecision,
  RacpApprovalResponse,
  RacpPermissionMode,
  RacpRequestContext,
} from "@pi-desktop/shared";

import {
  MESSAGING_COMMAND_WORDS,
  MESSAGING_PERMISSION_MODES,
  mapMessagingCommand,
  type MessagingCommandOutcome,
  type MessagingCommandRequest,
} from "./messaging-commands.js";
import type { Principal } from "./ports.js";

const principal: Principal = { subject: "linked-user", roles: ["controller", "approver"] };
const context: RacpRequestContext = { requestId: "req-1" };

/** The linked principal, a context, and a target carrying every id. */
function linked(
  overrides: {
    text?: string;
    target?: Record<string, string>;
    context?: RacpRequestContext;
    permissionMode?: RacpPermissionMode;
  } = {},
) {
  return {
    text: overrides.text ?? "",
    principal,
    context: overrides.context ?? context,
    target: {
      sessionId: "session-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      ...(overrides.target ?? {}),
    },
    ...(overrides.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
  };
}

function expectAccepted(outcome: MessagingCommandOutcome): MessagingCommandRequest {
  expect(outcome.accepted).toBe(true);
  if (!outcome.accepted) throw new Error("expected an accepted outcome");
  return outcome.request;
}

function expectRefused(outcome: MessagingCommandOutcome) {
  expect(outcome.accepted).toBe(false);
  if (outcome.accepted) throw new Error("expected a refusal");
  return outcome.refusal;
}

describe("mapMessagingCommand", () => {
  it("maps /start to turn/start for the target session", () => {
    const request = expectAccepted(mapMessagingCommand(linked({ text: "/start do the thing" })));
    expect(request).toEqual({
      operation: "turn/start",
      sessionId: "session-1",
      input: { text: "do the thing" },
      context,
    });
  });

  it("maps /stop to turn/stop for the target turn", () => {
    const request = expectAccepted(mapMessagingCommand(linked({ text: "/stop" })));
    expect(request).toEqual({ operation: "turn/stop", turnId: "turn-1", context });
  });

  it("maps /interrupt to turn/interrupt for the target turn", () => {
    const request = expectAccepted(mapMessagingCommand(linked({ text: "/interrupt" })));
    expect(request).toEqual({ operation: "turn/interrupt", turnId: "turn-1", context });
  });

  it("maps an approval decision word to approval/respond", () => {
    const request = expectAccepted(mapMessagingCommand(linked({ text: "/deny" })));
    expect(request).toEqual({
      operation: "approval/respond",
      approvalId: "approval-1",
      decision: "deny",
      context,
    });
  });

  it.each(["approve", "reject", "allow-once", "allow-session", "deny"] as const)(
    "maps the decision word /%s to its own decision value",
    (word) => {
      const request = expectAccepted(
        mapMessagingCommand(linked({ text: `/${word}`, permissionMode: "auto" })),
      );
      expect(request.operation).toBe("approval/respond");
      if (request.operation !== "approval/respond") throw new Error("wrong operation");
      expect(request.decision).toBe<RacpApprovalDecision>(word);
    },
  );

  it("requires a leading slash: a bare word is not a command", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "stop" }))).kind).toBe("not-a-command");
    expect(expectRefused(mapMessagingCommand(linked({ text: "approve" }))).kind).toBe(
      "not-a-command",
    );
  });

  it("requires a leading slash: an ordinary sentence is not a command", () => {
    const refusal = expectRefused(mapMessagingCommand(linked({ text: "stop right now" })));
    expect(refusal.kind).toBe("not-a-command");
  });

  it("carries the prompt argument verbatim, including inner whitespace", () => {
    const request = expectAccepted(
      mapMessagingCommand(linked({ text: "/start   run  the   tests  " })),
    );
    expect(request).toEqual({
      operation: "turn/start",
      sessionId: "session-1",
      input: { text: "run  the   tests" },
      context,
    });
  });

  it("passes the linked principal through unchanged", () => {
    const outcome = mapMessagingCommand(linked({ text: "/stop" }));
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) throw new Error("expected an accepted outcome");
    expect(outcome.principal).toBe(principal);
  });

  it("carries a caller-supplied context through to turn/start", () => {
    const mine: RacpRequestContext = { requestId: "req-9", idempotencyKey: "k-9" };
    const request = expectAccepted(
      mapMessagingCommand(linked({ text: "/start build it", context: mine })),
    );
    expect(request.operation).toBe("turn/start");
    if (request.operation !== "turn/start") throw new Error("wrong operation");
    expect(request.context).toBe(mine);
  });

  it("carries a caller-supplied context through to an approval response", () => {
    const mine: RacpRequestContext = { requestId: "req-9" };
    const request = expectAccepted(mapMessagingCommand(linked({ text: "/deny", context: mine })));
    expect(request.operation).toBe("approval/respond");
    if (request.operation !== "approval/respond") throw new Error("wrong operation");
    expect(request.context).toBe(mine);
  });

  it("refuses commands that require a context when none was supplied", () => {
    for (const text of ["/start build it", "/deny"]) {
      const withNoContext = { ...linked({ text }) } as Record<string, unknown>;
      delete withNoContext.context;
      const refusal = expectRefused(mapMessagingCommand(withNoContext as never));
      expect(refusal.kind).toBe("malformed-arguments");
    }
  });

  it("refuses a message that is not a command", () => {
    const refusal = expectRefused(mapMessagingCommand(linked({ text: "hello, please build it" })));
    expect(refusal.kind).toBe("not-a-command");
  });

  it("refuses an empty message as not-a-command", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "   " }))).kind).toBe("not-a-command");
  });

  it("does not treat an unknown bare word as a command", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "frobnicate the module" }))).kind).toBe(
      "not-a-command",
    );
  });

  it("refuses an unknown word after a slash as unknown-command", () => {
    const refusal = expectRefused(mapMessagingCommand(linked({ text: "/frobnicate" })));
    expect(refusal.kind).toBe("unknown-command");
    expect(refusal.detail).toContain("frobnicate");
  });

  it("refuses a slash with no word as unknown-command", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "/" }))).kind).toBe("unknown-command");
  });

  it("is case-sensitive: the vocabulary is lowercase only", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "/Stop" }))).kind).toBe(
      "unknown-command",
    );
    expect(expectRefused(mapMessagingCommand(linked({ text: "/APPROVE" }))).kind).toBe(
      "unknown-command",
    );
  });

  it("refuses a non-string message text as a typed refusal, not an exception", () => {
    for (const text of [undefined, null, 42, {}, ["/stop"]] as unknown[]) {
      const outcome = mapMessagingCommand({
        text: text as string,
        principal,
        target: { turnId: "turn-1" },
      });
      expect(outcome.accepted).toBe(false);
      if (outcome.accepted) throw new Error("expected a refusal");
      expect(outcome.refusal.kind).toBe("malformed-arguments");
    }
  });

  it("refuses an unlinked chat in a way the caller can audit", () => {
    const refusal = expectRefused(
      mapMessagingCommand({ text: "/stop", target: { turnId: "turn-1" } }),
    );
    expect(refusal).toEqual({ kind: "unlinked-chat", detail: expect.any(String) as unknown as string });
  });

  it("never yields a request from an unlinked chat, even for a valid command", () => {
    const refusal = expectRefused(
      mapMessagingCommand({ text: "/start build it", target: { sessionId: "session-1" } }),
    );
    expect(refusal.kind).toBe("unlinked-chat");
  });

  it("refuses start with no prompt text as malformed-arguments", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "/start" }))).kind).toBe(
      "malformed-arguments",
    );
  });

  it("refuses start with no session id as malformed-arguments", () => {
    const refusal = expectRefused(
      mapMessagingCommand({ text: "/start build it", principal, context, target: {} }),
    );
    expect(refusal.kind).toBe("malformed-arguments");
  });

  it("refuses argument text on a word that takes none", () => {
    expect(expectRefused(mapMessagingCommand(linked({ text: "/stop right now" }))).kind).toBe(
      "malformed-arguments",
    );
  });

  it("refuses a decision word carrying trailing argument text", () => {
    for (const text of ["/deny because", "/approve the plan", "/reject it"]) {
      expect(expectRefused(mapMessagingCommand(linked({ text }))).kind).toBe("malformed-arguments");
    }
  });

  it("refuses an approval decision word with no approval id", () => {
    const refusal = expectRefused(
      mapMessagingCommand({ text: "/approve", principal, context, target: {} }),
    );
    expect(refusal.kind).toBe("malformed-arguments");
  });

  it("refuses /approve without a permission mode rather than inventing one", () => {
    const refusal = expectRefused(mapMessagingCommand(linked({ text: "/approve" })));
    expect(refusal.kind).toBe("malformed-arguments");
    expect(refusal.detail).toContain("permissionMode");
  });

  it("expresses a contract approval end to end with its required permission mode", () => {
    const request = expectAccepted(
      mapMessagingCommand(linked({ text: "/approve", permissionMode: "accept-edits" })),
    );
    expect(request).toEqual({
      operation: "approval/respond",
      approvalId: "approval-1",
      decision: "approve",
      context,
      permissionMode: "accept-edits",
    });
    if (request.operation !== "approval/respond") throw new Error("wrong operation");
    // The caller hands exactly these fields to respondApproval; the response
    // type accepts them unchanged.
    const response: RacpApprovalResponse = {
      approvalId: request.approvalId,
      decision: request.decision,
      context: request.context,
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
    };
    expect(response).toEqual({
      approvalId: "approval-1",
      decision: "approve",
      context,
      permissionMode: "accept-edits",
    });
  });

  it("drops a caller-supplied permission mode on a tool decision", () => {
    const request = expectAccepted(
      mapMessagingCommand(linked({ text: "/deny", permissionMode: "auto" })),
    );
    expect(request).toEqual({
      operation: "approval/respond",
      approvalId: "approval-1",
      decision: "deny",
      context,
    });
    if (request.operation !== "approval/respond") throw new Error("wrong operation");
    expect("permissionMode" in request).toBe(false);
  });

  it("offers the allowed permission modes a channel can present", () => {
    expect(MESSAGING_PERMISSION_MODES).toEqual(["ask", "accept-edits", "auto"]);
  });

  it("recognises exactly the documented command words and no others", () => {
    expect(MESSAGING_COMMAND_WORDS).toEqual([
      "start",
      "stop",
      "interrupt",
      "approve",
      "reject",
      "allow-once",
      "allow-session",
      "deny",
    ]);
  });

  it("is deterministic: the same input yields the same outcome and mutates nothing", () => {
    const input = Object.freeze(linked({ text: "/interrupt" }));
    const first = mapMessagingCommand(input);
    const second = mapMessagingCommand(input);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(input).toEqual(linked({ text: "/interrupt" }));
  });
});
