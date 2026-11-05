import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * The three Android permissions the app cannot grant itself, read and requested
 * in one place.
 *
 * Notifications became a runtime permission in Android 13. Exact alarms became
 * a special access in 12, and battery optimisation has been one since 6 — the
 * last two are only granted from a settings page the reader confirms by hand.
 * Every call returns the state as Android sees it *after* the tap, never an
 * assumption that the tap succeeded.
 *
 * Distinct from `permissions.ts`, which gates the agent's own tool calls.
 */

export interface PermissionSnapshot {
  sdk: number;
  notifications: boolean;
  /** False before 13, where notifications are granted at install time. */
  notificationsRuntime: boolean;
  /** True when the system is allowed to freeze the process to save power. */
  batteryOptimised: boolean;
  exactAlarms: boolean;
}

interface AgentPermissionsBridge {
  state(): Promise<PermissionSnapshot>;
  requestNotifications(): Promise<PermissionSnapshot & { granted: boolean }>;
  requestBatteryExemption(): Promise<PermissionSnapshot & { launched: boolean }>;
  requestExactAlarms(): Promise<PermissionSnapshot & { launched: boolean }>;
  openNotificationSettings(): Promise<PermissionSnapshot & { launched: boolean }>;
}

const bridge = registerPlugin<AgentPermissionsBridge>("AgentPermissions");

export function systemPermissionsAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export async function readSystemPermissions(): Promise<PermissionSnapshot | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await bridge.state();
  } catch {
    return null;
  }
}

export async function askNotificationPermission(): Promise<PermissionSnapshot | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await bridge.requestNotifications();
  } catch {
    return null;
  }
}

export async function askBatteryExemption(): Promise<PermissionSnapshot | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await bridge.requestBatteryExemption();
  } catch {
    return null;
  }
}

export async function askExactAlarms(): Promise<PermissionSnapshot | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return await bridge.requestExactAlarms();
  } catch {
    return null;
  }
}

export async function openNotificationSettings(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await bridge.openNotificationSettings();
  } catch {
    // Nothing to recover: the reader can still reach Settings by hand.
  }
}
