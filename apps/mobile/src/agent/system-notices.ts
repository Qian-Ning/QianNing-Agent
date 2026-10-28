import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * The bridge to Android's notification tray.
 *
 * The in-app centre is the record; this is the glanceable copy. Everything
 * degrades quietly: a browser, a denied permission, or a plugin that is not
 * registered all leave the centre working and simply skip the system banner.
 */

type AgentNoticePlugin = {
  requestPermission(): Promise<{ granted: boolean }>;
  notify(options: {
    id: string;
    title: string;
    body: string;
    sessionId?: string;
  }): Promise<{ posted: boolean }>;
  cancel(options: { id: string }): Promise<void>;
};

const AgentNotice = registerPlugin<AgentNoticePlugin>("AgentNotice");

/** True only inside the packaged app; the same page runs in a desktop host. */
export function systemNoticesAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/** Asks once for POST_NOTIFICATIONS; safe to call on every start. */
export async function requestNoticePermission(): Promise<boolean> {
  if (!systemNoticesAvailable()) return false;
  try {
    const result = await AgentNotice.requestPermission();
    return result.granted === true;
  } catch {
    return false;
  }
}

export async function postSystemNotice(notice: {
  id: string;
  title: string;
  body: string;
  sessionId?: string | null;
}): Promise<boolean> {
  if (!systemNoticesAvailable()) return false;
  try {
    const result = await AgentNotice.notify({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
    });
    return result.posted === true;
  } catch {
    return false;
  }
}

export async function clearSystemNotice(id: string): Promise<void> {
  if (!systemNoticesAvailable()) return;
  try {
    await AgentNotice.cancel({ id });
  } catch {
    // A missing tray entry is not a failure worth surfacing.
  }
}
