/**
 * SSH to the user's own machines, from the phone.
 *
 * The native side (`QnSsh`) owns the sockets, the credentials and the pinned
 * host keys; this module is the typed face the rest of the app talks to. It also
 * keeps one live session per machine so `cd` in the phone's terminal behaves the
 * way it does locally — the shell channel survives between commands.
 */

export type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  /** `password` or `key`. */
  auth: "password" | "key";
  /** SHA-256 of the host key, recorded on first contact. */
  fingerprint: string;
  hasSecret: boolean;
};

export type SshProbe = { ok: boolean; banner: string; fingerprint: string };

type QnSshPlugin = {
  profiles(): Promise<{ profiles: SshProfile[] }>;
  saveProfile(input: {
    id?: string;
    name: string;
    host: string;
    port: number;
    user: string;
    enabled: boolean;
    auth: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
  }): Promise<SshProfile>;
  deleteProfile(options: { id: string }): Promise<{ ok: boolean }>;
  probe(options: { id: string }): Promise<SshProbe>;
  connect(options: { id: string }): Promise<{ sessionId: string; fingerprint: string }>;
  disconnect(options: { sessionId: string }): Promise<{ ok: boolean }>;
  exec(options: {
    sessionId: string;
    command: string;
  }): Promise<{ output: string; error: string; exitStatus: number }>;
  shell(options: {
    sessionId: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ output: string; exitStatus: number; cwd: string; timedOut: boolean }>;
};

function bridge(): QnSshPlugin | null {
  // globalThis, not window: this module is also exercised outside a WebView.
  const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  return (capacitor?.Plugins?.QnSsh as QnSshPlugin | undefined) ?? null;
}

export function hasSsh(): boolean {
  return bridge() !== null;
}

/** Which machines are live right now, so the page can show a real state. */
const live = new Set<string>();

export function isConnected(id: string): boolean {
  return live.has(id);
}

export async function listSshProfiles(): Promise<SshProfile[]> {
  const plugin = bridge();
  if (!plugin) return [];
  const answer = await plugin.profiles();
  return [...answer.profiles].sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveSshProfile(input: {
  id?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  enabled?: boolean;
  auth: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}): Promise<SshProfile> {
  const plugin = bridge();
  if (!plugin) throw new Error("这个安装包没有内置 SSH");
  const host = input.host.trim();
  const user = input.user.trim();
  if (!host || !user) throw new Error("地址和用户名都要填");
  return plugin.saveProfile({
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim() || host,
    host,
    port: input.port || 22,
    user,
    enabled: input.enabled ?? true,
    auth: input.auth,
    ...(input.password ? { password: input.password } : {}),
    ...(input.privateKey ? { privateKey: input.privateKey } : {}),
    ...(input.passphrase ? { passphrase: input.passphrase } : {}),
  });
}

export async function deleteSshProfile(id: string): Promise<void> {
  const plugin = bridge();
  if (!plugin) return;
  await plugin.disconnect({ sessionId: id }).catch(() => undefined);
  live.delete(id);
  await plugin.deleteProfile({ id });
}

export async function probeSsh(id: string): Promise<SshProbe> {
  const plugin = bridge();
  if (!plugin) throw new Error("这个安装包没有内置 SSH");
  return plugin.probe({ id });
}

/** Connect once and remember it; every call after this reuses the session. */
export async function ensureSsh(id: string): Promise<string> {
  const plugin = bridge();
  if (!plugin) throw new Error("这个安装包没有内置 SSH");
  if (live.has(id)) return id;
  const answer = await plugin.connect({ id });
  live.add(id);
  return answer.sessionId;
}

export async function disconnectSsh(id: string): Promise<void> {
  const plugin = bridge();
  if (!plugin) return;
  live.delete(id);
  await plugin.disconnect({ sessionId: id });
}

export type SshResult = {
  output: string;
  exitStatus: number;
  cwd: string;
  timedOut: boolean;
};

/** One command in the machine's persistent shell. */
export async function runSsh(id: string, command: string, timeoutMs = 30_000): Promise<SshResult> {
  const plugin = bridge();
  if (!plugin) throw new Error("这个安装包没有内置 SSH");
  await ensureSsh(id);
  const answer = await plugin.shell({ sessionId: id, command, timeoutMs });
  return {
    output: answer.output,
    exitStatus: answer.exitStatus,
    cwd: answer.cwd,
    timedOut: answer.timedOut,
  };
}

/** A machine by name or id, which is how the agent refers to one. */
export async function findSshProfile(needle: string): Promise<SshProfile | null> {
  const target = needle.trim().toLowerCase();
  if (!target) return null;
  const profiles = await listSshProfiles();
  return (
    profiles.find((profile) => profile.id === needle) ??
    profiles.find((profile) => profile.name.toLowerCase() === target) ??
    profiles.find((profile) => profile.host.toLowerCase() === target) ??
    null
  );
}
