import type { AppSettings } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";

/**
 * The single writer for skin-related settings.
 *
 * Skins are mutated from three places now — the skin center, the import path,
 * and the rotation timer — and each of them edits a different field of the same
 * object. A write is therefore a function of the *current* settings, serialized
 * through one queue, so a rotation that fires while an editor is saving cannot
 * resurrect the older value of `activeSkinId`.
 */

let queue: Promise<unknown> = Promise.resolve();

export function writeSkinSettings(
  patch: (current: AppSettings) => Partial<AppSettings>,
): Promise<void> {
  const run = queue.then(async () => {
    // The store is an optimistic cache. Another window, the rotation timer or an
    // import may have written since this window rendered, so the patch is
    // computed against the host's copy — the one that will be overwritten. When
    // the store held nothing (a window that never finished hydrating), a
    // store-based base silently turned every skin edit into a no-op.
    const stored = useAppStore.getState().settings;
    const current = (await api.getSettings().catch(() => null)) ?? stored;
    if (!current) return;
    const next = { ...current, ...patch(current) };
    useAppStore.setState({ settings: next });
    try {
      await api.setSettings(next);
    } catch (error) {
      // Put the previous value back so the UI never claims a save that failed.
      useAppStore.setState({ settings: current });
      throw error;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
