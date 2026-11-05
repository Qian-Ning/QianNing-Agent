import { useEffect } from "react";
import type { Skin } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { writeSkinSettings } from "./skin-settings-writer";

/**
 * Automatic skin rotation.
 *
 * Only skins that carry a background take part: cycling a colour-only skin
 * changes the palette under a wallpaper that stays put, which reads as a bug
 * rather than as rotation. The timer is wall-clock independent — it starts when
 * the shell mounts and resets whenever the interval or the enabled flag changes,
 * so toggling the feature never leaves an old timer running.
 */

export function rotationPool(skins: readonly Skin[] | undefined): Skin[] {
  return (skins ?? []).filter((skin) => skin.background.kind !== "none");
}

/** The skin after `activeId`, wrapping; null when there is nothing to rotate to. */
export function nextRotationSkin(pool: readonly Skin[], activeId: string | undefined): Skin | null {
  if (pool.length < 2) return null;
  const index = pool.findIndex((skin) => skin.id === activeId);
  const next = pool[(index + 1) % pool.length];
  return next && next.id !== activeId ? next : null;
}

export function useSkinRotation(): void {
  const enabled = useAppStore((state) => state.settings?.skinRotation?.enabled ?? false);
  const minutes = useAppStore((state) => state.settings?.skinRotation?.minutes ?? 30);
  const skinCount = useAppStore((state) => state.settings?.customSkins?.length ?? 0);

  useEffect(() => {
    if (!enabled) return;
    const interval = Math.max(1, minutes) * 60_000;
    const timer = setInterval(() => {
      // A hidden window has no one looking at the wallpaper; rotating there only
      // spends GPU time and can land on a scene the user never chose.
      if (document.hidden) return;
      const current = useAppStore.getState().settings;
      if (!current) return;
      const next = nextRotationSkin(rotationPool(current.customSkins), current.activeSkinId);
      if (!next) return;
      void writeSkinSettings(() => ({ activeSkinId: next.id })).catch(() => undefined);
    }, interval);
    return () => clearInterval(timer);
  }, [enabled, minutes, skinCount]);
}
