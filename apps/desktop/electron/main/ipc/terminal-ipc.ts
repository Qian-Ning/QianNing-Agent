/**
 * The local half of the desktop's terminal surface (spec
 * `03-runtime/19-remote-agent-control-protocol.md` §6.2, rollout R2b).
 *
 * This build ships no interactive local terminal: the desktop removed the
 * built-in shell and keeps agent Bash output in the transcript instead
 * (`04-ux/01-ui-ia.md`, `04-ux/08-component-spec.md`). The channels still
 * exist as one contract for a local and a remote session alike — a remote
 * session's call is intercepted by the backend router and served over RACP,
 * and only a call that genuinely reaches a local handler lands here. It
 * refuses with `CAPABILITY_UNAVAILABLE` so that path is a structured error
 * rather than Electron's "no handler registered" rejection.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";

function unavailable(operation: string): Error {
  return Object.assign(
    new Error(`this build has no local terminal (${operation} needs a remote host)`),
    { errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE },
  );
}

export function registerTerminalIpc(options: { registrar: IpcRegistrar }): void {
  const { registrar } = options;
  // Every handler refuses before reading its arguments: there is no local pty
  // to open, write to, resize, or close, so no argument can make one succeed.
  registrar.handle(IPC.invoke.terminalOpen, async () => {
    throw unavailable("terminal/open");
  });
  registrar.handle(IPC.invoke.terminalInput, async () => {
    throw unavailable("terminal/input");
  });
  registrar.handle(IPC.invoke.terminalResize, async () => {
    throw unavailable("terminal/resize");
  });
  registrar.handle(IPC.invoke.terminalClose, async () => {
    throw unavailable("terminal/close");
  });
}
