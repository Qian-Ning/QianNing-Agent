import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Keeps the phone's process awake while a turn is streaming.
 *
 * Without this, Android freezes the WebView soon after the app leaves the
 * foreground and the streamed answer stalls mid-sentence. The native side is a
 * foreground service with an ongoing notification; this module is the only
 * place the client talks to it, and it counts: nested or overlapping turns must
 * not stop the service while another one is still running.
 */

interface AgentKeepAliveBridge {
  start(options: { text?: string }): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<{ running: boolean }>;
}

const bridge = registerPlugin<AgentKeepAliveBridge>("AgentKeepAlive");

let active = 0;

/** Every acquire must be paired with a release; the service stops at zero. */
export async function acquireKeepAlive(text?: string): Promise<void> {
  active += 1;
  if (active > 1) return;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await bridge.start(text ? { text } : {});
  } catch {
    // A refused foreground start must not fail the turn: the answer still
    // streams while the app is open, it just may not survive backgrounding.
  }
}

export async function releaseKeepAlive(): Promise<void> {
  if (active === 0) return;
  active -= 1;
  if (active > 0) return;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await bridge.stop();
  } catch {
    // Nothing to recover: the service removes its own notification on destroy.
  }
}

export function keepAliveDepth(): number {
  return active;
}

/** Test seam: drops the counter without touching the native side. */
export function resetKeepAliveForTests(): void {
  active = 0;
}
