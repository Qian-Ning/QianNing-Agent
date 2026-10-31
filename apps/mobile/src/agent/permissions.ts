/**
 * Tool approvals on a phone.
 *
 * The desktop asks the renderer to approve a risky tool call and waits for an
 * answer (D058). The phone has the same two risky actions a person should see —
 * writing a file and making a network request — so it gets the same contract:
 * the host raises a request, the interface shows a card, and the tool waits.
 *
 * The three modes are the desktop's own:
 * - `ask`          — ask before every write and every fetch;
 * - `accept-edits` — file writes inside app storage go ahead, fetches ask;
 * - `auto`         — nothing asks.
 */

export type PermissionMode = "ask" | "accept-edits" | "auto";
export type PermissionDecision = "allow-once" | "allow-session" | "deny";

/** The actions this host can gate. Everything else the phone agent can do is read-only. */
export type GatedAction = "write_file" | "fetch_url" | "run_command";

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsPreview: unknown;
  /** `read`/`write`/`network` — the desktop's risk vocabulary. */
  risk: "read" | "write" | "network";
  reason: string;
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = "accept-edits";

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto"
    ? value
    : DEFAULT_PERMISSION_MODE;
}

/** Whether a mode needs a human for this action. */
export function requiresApproval(mode: PermissionMode, action: GatedAction): boolean {
  if (mode === "auto") return false;
  if (mode === "ask") return true;
  // accept-edits: an edit inside the agent's own scratch space is the point of
  // the mode. A command can do anything an edit can and more, so it still asks;
  // leaving the device for the network asks too.
  return action === "fetch_url" || action === "run_command";
}

const RISK: Record<GatedAction, PermissionRequest["risk"]> = {
  write_file: "write",
  fetch_url: "network",
  run_command: "write",
};

const REASON: Record<GatedAction, string> = {
  write_file: "writes a file in app storage",
  fetch_url: "sends a request to the network",
  run_command: "runs a shell command on this phone",
};

type Pending = {
  request: PermissionRequest;
  settle: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Holds the requests waiting for an answer and the session-wide grants the user
 * has already given, so "允许本次会话" means what it says.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly granted = new Set<string>();
  private mode: PermissionMode;
  private counter = 0;

  constructor(
    private readonly ask: (request: PermissionRequest) => void,
    options: {
      mode?: PermissionMode;
      timeoutMs?: number;
      now?: () => number;
      newId?: () => string;
    } = {},
  ) {
    this.mode = normalizePermissionMode(options.mode);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.newId = options.newId ?? (() => `perm_${Date.now().toString(36)}_${(this.counter += 1)}`);
  }

  private readonly timeoutMs: number;
  private readonly newId: () => string;

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = normalizePermissionMode(mode);
  }

  /** Drops session grants, e.g. when the user leaves the conversation. */
  forgetGrants(): void {
    this.granted.clear();
  }

  /**
   * Resolves true when the call may proceed. Never throws: a denial is an answer,
   * and a missing answer (timeout, app closed) is a denial too.
   */
  async approve(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    action: GatedAction;
    argsPreview: unknown;
    mode?: PermissionMode;
  }): Promise<boolean> {
    if (!requiresApproval(input.mode ?? this.mode, input.action)) return true;
    const key = `${input.sessionId}:${input.action}`;
    if (this.granted.has(key)) return true;

    const request: PermissionRequest = {
      requestId: this.newId(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argsPreview: input.argsPreview,
      risk: RISK[input.action],
      reason: REASON[input.action],
    };

    const answer = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(request.requestId, { request, settle: resolve, timer });
    });

    this.ask(request);
    return answer;
  }

  /** Called by the bridge when the interface answers a card. */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    if (decision !== "deny") {
      const action: GatedAction = entry.request.risk === "network" ? "fetch_url" : "write_file";
      if (decision === "allow-session") this.granted.add(`${entry.request.sessionId}:${action}`);
      entry.settle(true);
      return true;
    }
    entry.settle(false);
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}
