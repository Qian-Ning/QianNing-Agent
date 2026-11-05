import { protocol, type CustomScheme } from "electron";

/**
 * Privileged custom schemes have to be declared **once**, before app-ready.
 *
 * `protocol.registerSchemesAsPrivileged` does not append: each call replaces
 * the previous declaration, so registering five schemes one at a time left
 * only the last one privileged. Every other scheme still resolved for an
 * `<img>` or `<video>` (a handler is enough there), but `fetch()` refused it
 * with "URL scheme is not supported" — which is exactly how a wallpaper
 * renderer, a fetch-based scene loader, or any future consumer of these
 * schemes would fail while looking like a protocol bug.
 *
 * So the declaration is queued here by each protocol module and flushed once
 * from the startup composition root.
 */
const pending = new Map<string, CustomScheme>();

/** Declare privileges for one scheme; the last declaration for a name wins. */
export function queuePrivilegedScheme(entry: CustomScheme): void {
  pending.set(entry.scheme, entry);
}

/** Emit the single declaration Electron accepts. Call once, pre-ready. */
export function flushPrivilegedSchemes(): void {
  if (pending.size === 0) return;
  protocol.registerSchemesAsPrivileged([...pending.values()]);
  pending.clear();
}
