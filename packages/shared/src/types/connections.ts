/**
 * Renderer-facing shape of one outbound connection profile — a target the user
 * registered so the Agent may work on it (ADR 0320).
 *
 * The host persists these rows; the renderer only ever reads this view. A
 * credential is reported as `credentialConfigured`: the value lives in the
 * host's secret store and the handle that names it is returned by no method, on
 * either surface, which is why there is no field here to leak it through.
 */

/** Which transport reaches the target. Fixed by the profile's kind. */
export type ConnectionKind = "ssh" | "serial" | "telnet" | "raw-tcp";

/**
 * How the host key is checked on an SSH target.
 *
 * - `strict`: the key must already be known, or the probe fails.
 * - `accept-new`: a target seen for the first time is recorded; a key that
 *   *changed* is still refused, because that is the case a person decides.
 * - `pinned`: the recorded fingerprint must match exactly.
 */
export type ConnectionHostKeyPolicy = "strict" | "accept-new" | "pinned";

/**
 * Whether each call opens its own connection or reuses one.
 *
 * `multiplex` depends on a ControlMaster the ssh binary supports; a host that
 * reports it accepted the request is the only evidence the mode is live.
 */
export type ConnectionMultiplex = "per-call" | "multiplex";

/** Serial line settings, used when `kind` is `serial`. */
export type ConnectionSerialSettings = {
  baud: number;
  dataBits: number;
  parity: string;
  stopBits: number;
  flow: string;
};

/**
 * A profile's address, tagged by the same `kind` the profile carries.
 *
 * Both halves are written together and the host refuses a pair that disagrees,
 * so a stored record is self-describing rather than depending on a row it was
 * read next to.
 */
export type ConnectionTarget =
  | {
      kind: "ssh";
      host: string;
      port: number;
      user?: string;
      identityFile?: string;
      proxyJump?: string;
    }
  | {
      kind: "serial";
      port: string;
      baud: number;
      dataBits: number;
      parity: string;
      stopBits: number;
      flow: string;
    }
  | { kind: "telnet"; host: string; port: number }
  | { kind: "raw-tcp"; host: string; port: number };

/**
 * Per-profile bounds. Each may lower the host maximum; none can raise it, and
 * the effective values are computed at call time so a stale stored ceiling
 * cannot widen a budget that has since changed.
 */
export type ConnectionLimits = {
  timeoutMs: number;
  outputBytes: number;
  streamBytes: number;
};

/** The most recent probe's outcome, success or failure. */
export type ConnectionLastProbe = {
  ok: boolean;
  /** RFC3339, UTC. */
  at: string;
  errorCode?: string;
  reason?: string;
};

/** One row of the Connections destination. */
export type ConnectionProfileView = {
  id: string;
  label: string;
  kind: ConnectionKind;
  enabled: boolean;
  target: ConnectionTarget;
  credentialConfigured: boolean;
  hostKeyPolicy: ConnectionHostKeyPolicy;
  hostKeyFingerprint: string | null;
  multiplex: ConnectionMultiplex;
  limits: ConnectionLimits;
  lastProbe: ConnectionLastProbe | null;
  createdAt: number;
  updatedAt: number;
};

/** What a probe reports when it reaches the target. */
export type ConnectionProbeResult = {
  ok: true;
  /**
   * The SHA256 fingerprint the target presented, when it could be determined.
   * Absent when the machine has no `ssh-keyscan` to ask.
   */
  fingerprint?: string | null;
  /** The login shell the target reported, when it answered. */
  shell?: string | null;
  /**
   * Whether a shared connection was actually obtained. Reported rather than
   * assumed: a profile may ask for reuse and not get it.
   */
  multiplexed?: boolean;
  durationMs?: number;
};

/**
 * The payload of a `1033 CONNECTION_HOST_KEY` refusal, which is the one probe
 * outcome a person has to act on.
 *
 * A probe against a key that is unknown or has *changed* fails rather than
 * reporting success — nothing is trusted until someone looks. The fingerprint
 * here is the key the target presented, and it is what
 * `connection.acceptHostKey` takes.
 */
export type ConnectionProbeErrorDetails = {
  fingerprint?: string;
  /** `unknown`: never seen. `changed`: seen before, and it is not that key. */
  kind?: "unknown" | "changed";
};

/** One row of a profile's audit trail. */
export type ConnectionActivityEntry = {
  /** Epoch milliseconds of the row. */
  ts: number;
  action: string;
  outcome: string;
  profileId?: string;
  profileLabel?: string;
  errorCode?: string;
  durationMs?: number;
  /** Facts the action added — exit code, byte counts, and the like. */
  [key: string]: unknown;
};

/**
 * The create payload, exactly as the add form collects it.
 *
 * There is no id: the host mints one, and a payload that carries one is refused
 * rather than quietly treated as an edit — naming the right method beats
 * guessing which of two intents the caller had. `hostKeyFingerprint` is
 * required when the policy is `pinned`.
 */
export type ConnectionProfileDraft = {
  label: string;
  kind: ConnectionKind;
  target: ConnectionTarget;
  hostKeyPolicy?: ConnectionHostKeyPolicy;
  hostKeyFingerprint?: string;
  multiplex?: ConnectionMultiplex;
  limits?: ConnectionLimits;
};

/**
 * The update payload: the same fields, and the id is the one that may not be
 * missing. `hostKeyFingerprint` absent means "leave the recorded key alone";
 * moving the policy away from `pinned` clears it on the host.
 */
export type ConnectionProfileUpdate = ConnectionProfileDraft & { profileId: string };
