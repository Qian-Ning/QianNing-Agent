/**
 * The settings surface for the outbound-redaction table (ADR 0332).
 *
 * Two thin channels. Neither one touches the file: the sidecar owns the table,
 * so the count reflects what the next turn will actually use, and clearing
 * empties the same object instead of unlinking a file that a live turn would
 * rewrite from memory on its next hit.
 *
 * The response carries no plaintext — a count and an age bracket only. A
 * settings panel that listed the values would be a second copy of the secret
 * store, rendered into a process the renderer can reach.
 */
import { IPC } from "@pi-desktop/shared";
import type { RedactionClearResult, RedactionTableStatus } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { IpcRegistrar } from "./types";

export type { RedactionClearResult, RedactionTableStatus };

export type RedactionIpcDependencies = {
  registrar: IpcRegistrar;
  getSidecar: () => AgentSidecar | null;
};

export function registerRedactionIpc({ registrar, getSidecar }: RedactionIpcDependencies): void {
  registrar.handle(IPC.invoke.redactionStatus, async (): Promise<RedactionTableStatus> => {
    const sidecar = getSidecar();
    // No sidecar means no turn has run in this process yet, and therefore no
    // table: reporting "off" is true, while throwing would break the settings
    // page on a cold start.
    if (!sidecar) return { enabled: false, count: 0, oldest: null, newest: null };
    return sidecar.call<RedactionTableStatus>("redaction.status", {});
  });

  registrar.handle(IPC.invoke.redactionClear, async (): Promise<RedactionClearResult> => {
    const sidecar = getSidecar();
    if (!sidecar) return { cleared: 0 };
    return sidecar.call<RedactionClearResult>("redaction.clear", {});
  });
}
