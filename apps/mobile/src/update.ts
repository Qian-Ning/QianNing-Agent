/**
 * Self-update for the sideloaded phone build.
 *
 * There is no store to ask, so the release page is the source of truth: the
 * native side reads the latest release and picks its `-android.apk` asset, and
 * this module decides whether that is newer than what is installed.
 */

import { APP_VERSION } from "@pi-desktop/shared";

export type UpdateCheck = {
  /** A build newer than this one is published. */
  available: boolean;
  /** The published version, without the `v`. */
  version: string;
  /** Where the APK lives. */
  url: string;
  size: number;
  /** What this app is running now. */
  current: string;
};

type Plugin = {
  latest?: () => Promise<{ version?: string; url?: string; size?: number }>;
  install?: (options: { url: string }) => Promise<{ bytes?: number }>;
};

function plugin(): Plugin | null {
  const plugins = (globalThis as { window?: { Capacitor?: { Plugins?: Record<string, unknown> } } })
    .window?.Capacitor?.Plugins;
  const found = plugins?.AppUpdate as Plugin | undefined;
  return found?.latest ? found : null;
}

/** "2.10.0" is newer than "2.9.9": compare numbers, not strings. */
export function isNewer(candidate: string, current: string): boolean {
  const left = candidate.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const right = current.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = Number.isFinite(left[index]) ? (left[index] as number) : 0;
    const b = Number.isFinite(right[index]) ? (right[index] as number) : 0;
    if (a !== b) return a > b;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const bridge = plugin();
  if (!bridge?.latest) throw new Error("this build cannot check for updates");
  const answer = await bridge.latest();
  const version = answer.version ?? "";
  if (!version || !answer.url) throw new Error("the release has no Android build");
  return {
    available: isNewer(version, APP_VERSION),
    version,
    url: answer.url,
    size: answer.size ?? 0,
    current: APP_VERSION,
  };
}

/** Downloads the build and opens the system installer. */
export async function installUpdate(url: string): Promise<{ bytes: number }> {
  const bridge = plugin();
  if (!bridge?.install) throw new Error("this build cannot install an update");
  const answer = await bridge.install({ url });
  return { bytes: answer.bytes ?? 0 };
}
