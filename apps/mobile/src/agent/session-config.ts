import { isGlobalPermissionMode, isSessionThinkingLevel, normalizeMode,
  type Mode, type PermissionMode, type SessionThinkingLevel } from "@pi-desktop/shared";
import type { AgentStore } from "./store";

export type SessionConfig = {
  mode: Mode;
  thinkingLevel: SessionThinkingLevel;
  permissionMode: PermissionMode;
  providerId?: string;
  modelId?: string;
};
const DEFAULTS: SessionConfig = { mode: "agent", thinkingLevel: "medium", permissionMode: "inherit" };
const key = (id: string) => `qn.local.sessionConfig.${id}`;

function validPatch(input: unknown, strict = false): Partial<SessionConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const data = input as Record<string, unknown>;
  const result: Partial<SessionConfig> = {};
  const accept = (field: keyof SessionConfig, valid: boolean) => {
    if (data[field] === undefined) return false;
    if (!valid && strict) throw new Error(`invalid session ${field}`);
    return valid;
  };
  if (accept("mode", ["agent", "plan", "goal", "chat"].includes(String(data.mode)))) result.mode = normalizeMode(data.mode);
  if (accept("thinkingLevel", isSessionThinkingLevel(data.thinkingLevel))) result.thinkingLevel = data.thinkingLevel as SessionThinkingLevel;
  if (accept("permissionMode", data.permissionMode === "inherit" || isGlobalPermissionMode(data.permissionMode))) result.permissionMode = data.permissionMode as PermissionMode;
  for (const field of ["providerId", "modelId"] as const) {
    if (accept(field, typeof data[field] === "string")) result[field] = data[field] as string;
  }
  return result;
}

/** Shared by the bridge and runtime; corrupt persisted fields retain defaults. */
export function readSessionConfig(store: AgentStore, id: string): SessionConfig {
  try { return { ...DEFAULTS, ...validPatch(JSON.parse(store.readValue(key(id)) ?? "{}")) }; }
  catch { return { ...DEFAULTS }; }
}

export function updateSessionConfig(store: AgentStore, id: string, input: unknown): SessionConfig {
  const next = { ...readSessionConfig(store, id), ...validPatch(input, true) };
  store.writeValue(key(id), JSON.stringify(next));
  return next;
}