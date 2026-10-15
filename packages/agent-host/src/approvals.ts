import type {
  PlanningStateEvent,
  RacpApprovalRequest,
  RacpApprovalResponse,
  RacpApprovalResult,
  RacpPermissionMode,
  ToolPermissionRequest,
} from "@pi-desktop/shared";
import {
  RACP_CONTRACT_APPROVAL_DECISIONS,
  RACP_PERMISSION_MODES,
  RACP_TOOL_APPROVAL_DECISIONS,
} from "@pi-desktop/shared";

import { racpError } from "./errors.js";
import type { Clock, Principal } from "./ports.js";

/** How the Host settles a decision. Electron Main adapts `permissions.resolve`
 * and the Plan/Goal `plans.resolve` flow, which needs ids only Main tracks. */
export interface ApprovalPort {
  resolveTool(requestId: string, decision: "allow-once" | "allow-session" | "deny"): Promise<void>;
  resolveContract(input: {
    proposalId: string;
    sessionId: string;
    action: "approve" | "reject";
    permissionMode?: RacpPermissionMode;
    version?: number;
  }): Promise<void>;
  /** Open tool requests as Host state (`permissions.pending`). */
  listPendingTools(sessionId?: string): Promise<PendingToolRequest[]>;
}

export type PendingToolRequest = ToolPermissionRequest & {
  createdAt: string;
  expiresAt: string;
};

type PendingApproval = {
  request: RacpApprovalRequest;
  expiresAtMs: number;
  version?: number;
};

const MAX_REMEMBERED_RESULTS = 1000;

/**
 * Pending approvals as Host state (spec §5.5, §9.3). The first valid decision
 * wins across local and remote clients; later valid responses receive the
 * stored result with `alreadyResolved: true`.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly results = new Map<string, RacpApprovalResult>();
  /**
   * The session each approval id belongs to, kept past `settle` so a repeat
   * response to an already-resolved approval resolves the *right* session to
   * run the ownership check against (ADR 0325). The pending request carries it
   * while open; this map carries it afterwards.
   */
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly port: ApprovalPort,
    private readonly clock: Clock,
  ) {}

  fromToolPermission(
    request: ToolPermissionRequest,
    context: { turnId: string; revision: number; lifetimeMs: number; allowSession: boolean; expiresAt?: string },
  ): RacpApprovalRequest {
    const existing = this.pending.get(request.requestId);
    if (existing) return existing.request;
    const expiresAtMs = context.expiresAt
      ? Date.parse(context.expiresAt)
      : this.clock.now() + context.lifetimeMs;
    const approval: RacpApprovalRequest = {
      id: request.requestId,
      sessionId: request.sessionId,
      turnId: context.turnId,
      kind: "tool",
      summary: `${request.toolName}: ${request.reason}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      revision: context.revision,
      toolName: request.toolName,
      risk: request.risk,
      ...(request.agentName ? { agentName: request.agentName } : {}),
      ...(request.parentToolCallId ? { parentToolCallId: request.parentToolCallId } : {}),
      allowedDecisions: context.allowSession
        ? [...RACP_TOOL_APPROVAL_DECISIONS]
        : RACP_TOOL_APPROVAL_DECISIONS.filter((decision) => decision !== "allow-session"),
    };
    this.pending.set(approval.id, { request: approval, expiresAtMs });
    this.rememberSession(approval.id, approval.sessionId);
    return approval;
  }

  /** A Plan or Goal proposal awaiting approval: a session-level transition. */
  fromPlanningState(
    event: PlanningStateEvent,
    context: { turnId: string; revision: number; lifetimeMs: number },
  ): RacpApprovalRequest | null {
    if (event.state !== "awaiting_approval" || !event.proposalId) return null;
    const existing = this.pending.get(event.proposalId);
    if (existing) return existing.request;
    const expiresAtMs = this.clock.now() + context.lifetimeMs;
    const approval: RacpApprovalRequest = {
      id: event.proposalId,
      sessionId: event.sessionId,
      turnId: context.turnId,
      kind: event.kind ?? "plan",
      summary: event.title ?? `${event.kind ?? "plan"} proposal`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      revision: context.revision,
      ...(event.title ? { title: event.title } : {}),
      ...(event.question ? { question: event.question } : {}),
      ...(event.artifact ? { artifact: event.artifact } : {}),
      allowedDecisions: [...RACP_CONTRACT_APPROVAL_DECISIONS],
      allowedPermissionModes: [...RACP_PERMISSION_MODES],
    };
    this.pending.set(approval.id, { request: approval, expiresAtMs, version: event.version });
    this.rememberSession(approval.id, approval.sessionId);
    return approval;
  }

  /** Pull open tool requests the Host already has, for a late attach. */
  async syncPendingTools(
    sessionId: string,
    context: { turnId: string; revision: number; lifetimeMs: number; allowSession: boolean },
  ): Promise<RacpApprovalRequest[]> {
    const open = await this.port.listPendingTools(sessionId);
    return open.map((request) =>
      this.fromToolPermission(request, { ...context, expiresAt: request.expiresAt }),
    );
  }

  list(sessionId?: string): RacpApprovalRequest[] {
    const now = this.clock.now();
    return [...this.pending.values()]
      .filter((entry) => entry.expiresAtMs > now)
      .map((entry) => entry.request)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  get(approvalId: string): RacpApprovalRequest | undefined {
    return this.pending.get(approvalId)?.request;
  }

  result(approvalId: string): RacpApprovalResult | undefined {
    return this.results.get(approvalId);
  }

  /**
   * The session an approval id belongs to, open or already resolved. Used by
   * the ownership admission so a repeat response to a settled approval is
   * checked against that approval's own session, not an arbitrary one.
   */
  sessionOf(approvalId: string): string | undefined {
    return this.pending.get(approvalId)?.request.sessionId ?? this.sessions.get(approvalId);
  }

  async resolve(
    response: RacpApprovalResponse,
    principal: Principal,
    currentRevision: number,
  ): Promise<RacpApprovalResult> {
    const remembered = this.results.get(response.approvalId);
    if (remembered) return { ...remembered, alreadyResolved: true };
    const entry = this.pending.get(response.approvalId);
    if (!entry) throw racpError("NOT_FOUND", `approval ${response.approvalId} is not open`);
    if (entry.expiresAtMs <= this.clock.now()) {
      this.settle(response.approvalId, { status: "expired", revision: currentRevision });
      throw racpError("APPROVAL_EXPIRED", "the approval is no longer executable");
    }
    const expected = response.context.expectedRevision;
    if (typeof expected === "number" && expected !== entry.request.revision) {
      throw racpError("APPROVAL_STALE", "the approval response targets an old revision", {
        details: { expectedRevision: expected, approvalRevision: entry.request.revision },
      });
    }
    const decisions: readonly string[] = entry.request.allowedDecisions;
    if (!decisions.includes(response.decision)) {
      throw racpError("INVALID_ARGUMENT", `decision ${response.decision} is not offered by this approval`);
    }
    if (entry.request.kind === "tool") {
      await this.port.resolveTool(
        entry.request.id,
        response.decision as "allow-once" | "allow-session" | "deny",
      );
    } else {
      const action = response.decision as "approve" | "reject";
      if (action === "approve") {
        const modes: readonly string[] = entry.request.allowedPermissionModes ?? [];
        if (!response.permissionMode || !modes.includes(response.permissionMode)) {
          throw racpError("INVALID_ARGUMENT", "a contract approval requires a permissionMode from allowedPermissionModes");
        }
      }
      await this.port.resolveContract({
        proposalId: entry.request.id,
        sessionId: entry.request.sessionId,
        action,
        ...(response.permissionMode ? { permissionMode: response.permissionMode } : {}),
        ...(entry.version !== undefined ? { version: entry.version } : {}),
      });
    }
    return this.settle(response.approvalId, {
      status: "resolved",
      decision: response.decision,
      ...(response.permissionMode ? { permissionMode: response.permissionMode } : {}),
      revision: currentRevision,
      by: principal.subject,
    });
  }

  /**
   * The desktop card or the Host itself settled the request. Records the
   * outcome so a later remote response gets `alreadyResolved` instead of a
   * second execution.
   */
  settle(
    approvalId: string,
    outcome: {
      status: RacpApprovalResult["status"];
      decision?: RacpApprovalResult["decision"];
      permissionMode?: RacpPermissionMode;
      revision: number;
      by?: string;
    },
  ): RacpApprovalResult {
    this.pending.delete(approvalId);
    const result: RacpApprovalResult = {
      approvalId,
      status: outcome.status,
      ...(outcome.decision ? { decision: outcome.decision } : {}),
      ...(outcome.permissionMode ? { permissionMode: outcome.permissionMode } : {}),
      alreadyResolved: false,
      revision: outcome.revision,
    };
    this.results.set(approvalId, result);
    // Re-insert the session at the tail so its eviction order tracks the
    // result map's (both bounded by MAX_REMEMBERED_RESULTS): a remembered
    // result never outlives the session a repeat response is checked against.
    const sessionId = this.sessions.get(approvalId);
    if (sessionId !== undefined) this.rememberSession(approvalId, sessionId);
    while (this.results.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
    return result;
  }

  /** Close every open approval of a session, e.g. when its turn ended. */
  cancelForSession(sessionId: string, revision: number): RacpApprovalResult[] {
    const closed: RacpApprovalResult[] = [];
    for (const entry of [...this.pending.values()]) {
      if (entry.request.sessionId !== sessionId) continue;
      closed.push(this.settle(entry.request.id, { status: "canceled", revision }));
    }
    return closed;
  }

  private rememberSession(approvalId: string, sessionId: string): void {
    this.sessions.set(approvalId, sessionId);
    while (this.sessions.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
