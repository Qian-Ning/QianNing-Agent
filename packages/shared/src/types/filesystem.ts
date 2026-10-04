/** Shared public types grouped by the owning application domain. */
export type FsEntry = {
  name: string;
  kind: "dir" | "file";
  size: number;
};

export type FsReadResult = {
  kind: "text" | "image" | "binary" | "tooLarge";
  /** UTF-8 file content when kind is "text". */
  content?: string;
  /** Base64 data URL when kind is "image". */
  dataUrl?: string;
  size: number;
};

/** Bounded in-chat image read. Non-images never include file bytes. */
export type FsImageDataUrlResult = {
  kind: "image" | "missing" | "notImage" | "tooLarge";
  dataUrl?: string;
  size?: number;
  errorCode?: string;
};

export type ProjectMemory = {
  content: string;
  entries?: ProjectMemoryEntry[];
  updatedAt?: number;
};

export type ProjectMemoryEntry = {
  id: string;
  title: string;
  content: string;
};

/** Workspace-relative entry of the `fs/index` snapshot for the "@" menu (D124). */
export type FsIndexEntry = {
  path: string;
  kind: "dir" | "file";
};

export type FsIndexResult = {
  entries: FsIndexEntry[];
  /** True when the index hit its entry cap and results were dropped. */
  truncated: boolean;
};

export type TokenUsageBucket = "hour" | "day" | "week" | "month";

export type TokenUsageHistoryItem = {
  date: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turnCount: number;
};

export type TokenUsageHistoryResult = {
  bucket: TokenUsageBucket;
  rangeStart: number;
  rangeEnd: number;
  items: TokenUsageHistoryItem[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    turnCount: number;
  };
};

export type UsageProviderStat = {
  providerId: string;
  turnCount: number;
  successCount: number;
  successRate: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost from priced turns only (unpriced turns add nothing). */
  costUsd: number;
  /** Turns whose model has no pricing row, excluded from `costUsd`. */
  unpricedTurns: number;
};

export type UsageModelStat = {
  modelId: string;
  providerId: string | null;
  turnCount: number;
  successCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedTurns: number;
};

export type UsageProjectStat = {
  /** The session's project, or null for turns whose session has none. */
  projectId: number | null;
  /** The project's display name, or null for the unattributed bucket. */
  projectName: string | null;
  turnCount: number;
  successCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedTurns: number;
};

export type UsageRecentTurn = {
  timestamp: number;
  providerId: string | null;
  modelId: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  durationMs: number;
  /** Estimated USD cost for this turn, or null when its model is unpriced. */
  costUsd: number | null;
};

export type UsageBreakdownResult = {
  rangeStart: number;
  rangeEnd: number;
  byProvider: UsageProviderStat[];
  byModel: UsageModelStat[];
  byProject: UsageProjectStat[];
  recent: UsageRecentTurn[];
  /** Grand total estimated USD across every priced turn in the window. */
  totalCostUsd: number;
  /** How many turns contributed a cost figure. */
  pricedTurns: number;
  /** How many turns were skipped from cost because their model is unpriced. */
  unpricedTurns: number;
};

/** One editable per-model price row (per-million USD, stored as strings). */
export type ModelPricingRow = {
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheWriteCostPerMillion: string;
};

export type ModelPricingResult = {
  models: ModelPricingRow[];
};

/**
 * One folder of the project a chat reference may resolve into. A project can be
 * a logical group of several folders (ADR 0249), and only the primary one is
 * the workspace that relative paths are expressed against.
 */
export type FsChatRefProjectRoot = {
  path: string;
  name: string;
  primary: boolean;
};

/**
 * A file referenced from chat text, resolved to a real file (D320 follow-up).
 *
 * `root` names which store answered, because the caller routes on it: a project
 * file is expressed to the work panel as a path relative to the project's
 * **primary** folder, while any other project folder — and every scratch or
 * attachment file — can only be addressed by its absolute path.
 */
export type FsChatRefRoot = "workspace" | "scratch" | "attachments";

/** Which rule produced the match; the shallow tiers are informational. */
export type FsChatRefMatchKind =
  | "exact-relative"
  | "exact-absolute"
  | "path-suffix"
  | "basename";

export type FsChatRefMatch = {
  root: FsChatRefRoot;
  /** POSIX path relative to the matched root. */
  relativePath: string;
  /** Native absolute path of the matched regular file. */
  absolutePath: string;
  matchedBy: FsChatRefMatchKind;
  /**
   * Which folder of the project answered, for `root: "workspace"`. The caller
   * needs it to decide how to address the file: relative for the primary
   * folder, absolute for any other.
   */
  projectRoot?: FsChatRefProjectRoot;
};

export type FsChatRefResolveResult = {
  match: FsChatRefMatch | null;
  /** The supplied absolute path is not inside a project, scratch, or attachment root. */
  reason?: "outside-allowed-roots";
};
