/**
 * The phone's shell and its browser window.
 *
 * Both live in the Android shell as Capacitor plugins: `QnShell` runs
 * `/system/bin/sh` inside the app's sandbox, `QnBrowser` opens the in-app
 * WebView window. This module is the only place the app talks to them, and it
 * degrades to a clear answer rather than a stack trace when the code is running
 * somewhere those plugins do not exist (a browser tab, a test).
 */

export type ShellResult = {
  output: string;
  code: number;
  truncated: boolean;
  cwd: string;
  durationMs: number;
  persistent?: boolean;
  error?: string;
};

export type ShellInfo = {
  cwd: string;
  home: string;
  bin?: string;
  user: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
};

export type BrowserPage = {
  open: boolean;
  url: string;
  title: string;
  text: string;
};

interface QnShellPlugin {
  exec(options: { command: string; timeoutMs?: number }): Promise<ShellResult>;
  info(): Promise<ShellInfo>;
  reset(): Promise<{ ok: boolean }>;
}

interface QnBrowserPlugin {
  open(options: { url: string }): Promise<{ ok: boolean }>;
  read(): Promise<BrowserPage>;
  close(): Promise<{ ok: boolean }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { QnShell?: QnShellPlugin; QnBrowser?: QnBrowserPlugin };
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

export function hasShell(): boolean {
  return Boolean(capacitor()?.Plugins?.QnShell);
}

export function hasBrowser(): boolean {
  return Boolean(capacitor()?.Plugins?.QnBrowser);
}

export async function shellInfo(): Promise<ShellInfo | null> {
  const plugin = capacitor()?.Plugins?.QnShell;
  if (!plugin) return null;
  try {
    return await plugin.info();
  } catch {
    return null;
  }
}

/**
 * Runs one command in the app's long-lived shell. The session keeps its working
 * directory and exported variables between calls; `timeoutMs` bounds this one
 * command (the plugin clamps it and restarts the shell if it is exceeded).
 */
export async function runShell(command: string, timeoutMs?: number): Promise<ShellResult> {
  const plugin = capacitor()?.Plugins?.QnShell;
  if (!plugin) {
    return {
      output: "这个设备上没有可用的 shell（不在 Android 应用内运行）。",
      code: -1,
      truncated: false,
      cwd: "/",
      durationMs: 0,
    };
  }
  try {
    return await plugin.exec({ command, ...(timeoutMs ? { timeoutMs } : {}) });
  } catch (error) {
    return {
      output: String((error as { message?: string })?.message ?? error),
      code: -1,
      truncated: false,
      cwd: "/",
      durationMs: 0,
    };
  }
}

/** Drops the session's state: next command starts in the app's storage. */
export async function resetShell(): Promise<boolean> {
  const plugin = capacitor()?.Plugins?.QnShell;
  if (!plugin) return false;
  try {
    await plugin.reset();
    return true;
  } catch {
    return false;
  }
}

/** Opens a page in the in-app browser window. Returns false when unavailable. */
export async function openBrowser(url: string): Promise<boolean> {
  const plugin = capacitor()?.Plugins?.QnBrowser;
  if (!plugin) return false;
  try {
    await plugin.open({ url });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the in-app browser is showing right now: the rendered text, not the
 * source. Empty when no window is open or the page has not settled yet.
 */
export async function readBrowser(): Promise<BrowserPage | null> {
  const plugin = capacitor()?.Plugins?.QnBrowser;
  if (!plugin) return null;
  try {
    return await plugin.read();
  } catch {
    return null;
  }
}

export async function closeBrowser(): Promise<boolean> {
  const plugin = capacitor()?.Plugins?.QnBrowser;
  if (!plugin) return false;
  try {
    await plugin.close();
    return true;
  } catch {
    return false;
  }
}
