/**
 * One machine, two layers.
 *
 * A Connections card has always said *where the agent may work*: a connection
 * profile — an SSH target with its host-key policy, multiplex mode and limits.
 * Whether our host runtime is installed and running on that machine used to live
 * on a separate Settings page, which meant the same machine appeared twice and
 * "add" existed twice.
 *
 * This module is the merge point, kept pure so the join can be tested without a
 * renderer: it pairs each profile with its host registration, leaves a paired
 * host that has no profile standing as its own row, and turns a live link state
 * into the one status a card shows.
 *
 * The join is by machine identity, not by label. `hostKeyFor` is minted from the
 * profile id, so an install started from a card stays attached to that card even
 * if the address is edited afterwards; a record written by the old page (or by a
 * pairing) has no such key, so it is matched by the SSH descriptor instead.
 */
import type {
  ConnectionProfileView,
  RemoteHostBootstrapRequest,
  RemoteHostLinkState,
  RemoteHostSummary,
} from "@pi-desktop/shared";

/** A paired host's SSH identity, as the host layer records it. */
export type MachineAddress = {
  host: string;
  port: number;
  user?: string;
};

/**
 * Stable host key for a profile's runtime. `hostKey` travels in renderer
 * session ids (`remote:<hostKey>:…`), so it may not contain `:` — the sanitised
 * profile id is prefixed to keep it recognisable.
 */
export function hostKeyFor(profile: Pick<ConnectionProfileView, "id">): string {
  const safe = profile.id.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `conn-${safe || "target"}`;
}

/** The SSH address a profile dials, or `null` for a non-SSH target. */
export function addressOf(profile: ConnectionProfileView): MachineAddress | null {
  const target = profile.target;
  if (target.kind !== "ssh") return null;
  return {
    host: target.host.trim(),
    port: target.port,
    ...(target.user?.trim() ? { user: target.user.trim() } : {}),
  };
}

function sameHost(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Whether a host record is the runtime of this target.
 *
 * `user` is compared only when both sides name one: a record written without
 * `user` means "the local login", which is also what an SSH profile with no
 * user means, so treating that as a mismatch would lose the link on the common
 * case.
 */
export function hostBelongsToProfile(
  profile: ConnectionProfileView,
  host: RemoteHostSummary,
): boolean {
  if (host.hostKey === hostKeyFor(profile)) return true;
  const address = addressOf(profile);
  if (!address) return false;
  const ssh = host.ssh;
  if (!ssh) return false;
  if (!sameHost(address.host, ssh.host)) return false;
  if ((ssh.port ?? 22) !== address.port) return false;
  if (address.user && ssh.user && address.user !== ssh.user) return false;
  return true;
}

/** One row of the Connections list: a profile, a host, or both. */
export type MachineRow = {
  /** `profile.id` for a target row, `host:<hostKey>` for a host-only row. */
  key: string;
  /** The target layer: where the agent may work. Absent on a host-only row. */
  profile?: ConnectionProfileView;
  /** The host layer: the runtime on that machine. Absent until installed. */
  host?: RemoteHostSummary;
  /** True when this machine is only a paired host (no profile). */
  hostOnly: boolean;
};

/**
 * Build the list. Profile order is preserved — it is the order the user added
 * targets in — and a host that matched no profile follows as its own row, so it
 * cannot silently disappear just because its profile was deleted.
 */
export function machineRows(
  profiles: readonly ConnectionProfileView[],
  hosts: readonly RemoteHostSummary[],
): MachineRow[] {
  const claimed = new Set<string>();
  const rows: MachineRow[] = profiles.map((profile) => {
    const host = hosts.find(
      (candidate) =>
        !claimed.has(candidate.hostKey) && hostBelongsToProfile(profile, candidate),
    );
    if (host) claimed.add(host.hostKey);
    return {
      key: profile.id,
      profile,
      ...(host ? { host } : {}),
      hostOnly: false,
    };
  });
  for (const host of hosts) {
    if (claimed.has(host.hostKey)) continue;
    rows.push({ key: `host:${host.hostKey}`, host, hostOnly: true });
  }
  return rows;
}

/**
 * What a card says about the runtime. `not-installed` is the absence of a
 * record, `unknown` is "the list could not be read", and the rest are the
 * transport's own states.
 */
export type HostLink = RemoteHostLinkState | "not-installed" | "unknown";

export function hostLinkOf(
  host: RemoteHostSummary | undefined,
  live: RemoteHostLinkState | undefined,
  hostsUnavailable = false,
): HostLink {
  if (!host) return hostsUnavailable ? "unknown" : "not-installed";
  if (live) return live;
  return host.connected ? "connected" : "disconnected";
}

/** i18n key for a link state. Total on purpose: no state renders blank. */
export function hostLinkKey(link: HostLink): string {
  switch (link) {
    case "connected":
      return "connections.hostRunning";
    case "connecting":
      return "connections.hostConnecting";
    case "reconnecting":
      return "connections.hostReconnecting";
    case "disconnected":
      return "connections.hostDisconnected";
    case "failed":
      return "connections.hostFailed";
    case "unknown":
      return "connections.hostUnavailable";
    case "not-installed":
      return "connections.hostNotInstalled";
  }
}

/** Warning tone for the states a person has to act on. */
export function hostLinkTone(link: HostLink): "warning" | undefined {
  return link === "failed" || link === "unknown" ? "warning" : undefined;
}

/**
 * How the install should authenticate, read from what the profile stores: an
 * identity file means key auth, a configured credential means the login
 * password the target already uses, and nothing means the user's ssh agent.
 */
export function installAuthOf(
  profile: ConnectionProfileView,
): "agent" | "key" | "password" {
  if (profile.target.kind !== "ssh") return "agent";
  if (profile.target.identityFile?.trim()) return "key";
  return profile.credentialConfigured ? "password" : "agent";
}

/**
 * The bootstrap request for a target's runtime.
 *
 * The address comes from the profile — the install is that machine, not a
 * second form — and the host key is minted from the profile id so the card
 * keeps its runtime across an address edit. A password is passed only when the
 * user typed one here: the profile's credential is in the host's secret store
 * and is not readable, so an install that needs a password has to ask again.
 */
export function installRequestFor(
  profile: ConnectionProfileView,
  password?: string,
): RemoteHostBootstrapRequest {
  const address = addressOf(profile);
  if (!address) throw new Error("only an SSH target can host a runtime");
  const auth = installAuthOf(profile);
  const secret = password?.trim() ?? "";
  return {
    label: profile.label,
    host: address.host,
    port: address.port,
    ...(address.user ? { user: address.user } : {}),
    ...(auth === "key" && profile.target.kind === "ssh" && profile.target.identityFile
      ? { identityFile: profile.target.identityFile }
      : {}),
    ...(auth === "password" && secret !== "" ? { password: secret } : {}),
    hostKey: hostKeyFor(profile),
  };
}

/**
 * What deleting this row removes. Both halves belong to one machine, so the
 * confirmation names both rather than leaving a registration behind.
 */
export function removalPlan(row: MachineRow): { target: boolean; host: boolean } {
  return { target: row.profile !== undefined, host: row.host !== undefined };
}

/** True when the row has nothing to delete (should not be reachable). */
export function isRemovable(row: MachineRow): boolean {
  const plan = removalPlan(row);
  return plan.target || plan.host;
}
