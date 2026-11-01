import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

/**
 * The Signal bridge.
 *
 * Linking a device and running a channel are two different facts. Linking gives
 * the account; the channel speaks JSON-RPC to `signal-cli daemon` on
 * `127.0.0.1:8080`. Without the daemon the account is a number in a field and
 * nothing is received, so this module owns the second half of setup: start the
 * daemon once a pairing lands, report a port that is already taken instead of
 * hanging, and take the process down with the app.
 *
 * Readiness is a TCP connect, not a log line. signal-cli's wording between
 * versions is not a contract; a listening socket is.
 */

export type SignalBridgeState = "idle" | "starting" | "running" | "failed";

export type SignalBridgeFailure = "missing-cli" | "no-account" | "port-in-use" | "exited";

export type SignalBridgeSnapshot = {
  state: SignalBridgeState;
  host: string;
  port: number;
  account: string | null;
  reason: SignalBridgeFailure | null;
};

const BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 8080;

/**
 * The port the channel's client points at. 8080 is what
 * `SIGNAL_DEFAULT_BRIDGE_URL` assumes; the override exists so a machine can
 * move it (and so a test does not fight a real daemon for the port).
 */
function bridgePort(): number {
  const raw = Number(process.env.PI_DESKTOP_SIGNAL_BRIDGE_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_BRIDGE_PORT;
}
/** signal-cli opens the port in a few hundred ms; this is the ceiling, not the wait. */
const READY_DEADLINE_MS = 20_000;
const READY_PROBE_MS = 300;

type Session = {
  child: ChildProcess | null;
  snapshot: SignalBridgeSnapshot;
  timer: NodeJS.Timeout | null;
  output: string;
};

let session: Session | null = null;

const idle = (): SignalBridgeSnapshot => ({
  state: "idle",
  host: BRIDGE_HOST,
  port: bridgePort(),
  account: null,
  reason: null,
});

export function signalBridgeSnapshot(): SignalBridgeSnapshot {
  return session ? { ...session.snapshot } : idle();
}

function stop(child: ChildProcess | null) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    // The daemon runs behind a `.cmd` shim most of the time; the tree is the
    // only thing that actually goes away.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill();
}

function cliExists(cli: string): boolean {
  if (cli.includes("/") || cli.includes("\\")) return existsSync(cli);
  if (process.platform !== "win32") return true;
  return spawnSync("where.exe", [cli], { stdio: "ignore", windowsHide: true }).status === 0;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function classify(output: string): SignalBridgeFailure {
  if (/address already in use|EADDRINUSE|bind/i.test(output)) return "port-in-use";
  if (/no account|no registered|not registered|no linked/i.test(output)) return "no-account";
  return "exited";
}

/**
 * Start the daemon for one account.
 *
 * Resolves only on a real outcome — the port answers, or the process is gone.
 * A caller that gets `running` can open a channel immediately; one that gets
 * `failed` has a reason it can show without guessing.
 */
export async function startSignalBridge(input?: {
  account?: string;
  cliPath?: string;
}): Promise<SignalBridgeSnapshot> {
  const port = bridgePort();
  if (session && (session.snapshot.state === "starting" || session.snapshot.state === "running")) {
    return { ...session.snapshot };
  }

  // A daemon left over from a previous run is indistinguishable from a working
  // one by socket alone, and starting a second would collide on the port.
  if (await canConnect(BRIDGE_HOST, port)) {
    session = {
      child: null,
      snapshot: {
        state: "running",
        host: BRIDGE_HOST,
        port,
        account: input?.account?.trim() || null,
        reason: null,
      },
      timer: null,
      output: "",
    };
    return { ...session.snapshot };
  }

  const cli = input?.cliPath?.trim() || process.env.PI_DESKTOP_SIGNAL_CLI?.trim() || "signal-cli";
  const account = input?.account?.trim() || null;

  const current: Session = {
    child: null,
    snapshot: { state: "starting", host: BRIDGE_HOST, port, account, reason: null },
    timer: null,
    output: "",
  };
  session = current;

  if (!cliExists(cli)) {
    current.snapshot = { ...current.snapshot, state: "failed", reason: "missing-cli" };
    return { ...current.snapshot };
  }

  const args = [
    ...(account ? ["-a", account] : []),
    "daemon",
    "--http",
    `${BRIDGE_HOST}:${port}`,
  ];
  const child = spawn(cli, process.platform === "win32" ? args.map(quote) : args, {
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  current.child = child;

  const collect = (chunk: Buffer) => {
    if (session === current) current.output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const fail = (reason: SignalBridgeFailure) => {
    if (current.timer) clearInterval(current.timer);
    current.timer = null;
    stop(child);
    current.child = null;
    current.snapshot = { ...current.snapshot, state: "failed", reason };
    return { ...current.snapshot };
  };

  child.once("error", () => fail("missing-cli"));
  child.once("close", () => {
    if (session !== current) return;
    // Whoever is waiting needs a fact, not a handle that looks alive.
    current.child = null;
    if (current.snapshot.state === "running") {
      // The daemon died on its own after serving; say so rather than claim it
      // is still up.
      if (current.timer) clearInterval(current.timer);
      current.timer = null;
      current.child = null;
      current.snapshot = { ...current.snapshot, state: "failed", reason: "exited" };
      return;
    }
  });

  return new Promise<SignalBridgeSnapshot>((resolve) => {
    const deadline = Date.now() + READY_DEADLINE_MS;
    const tick = async () => {
      if (session !== current || current.snapshot.state !== "starting") return;
      if (current.child === null) {
        // The process is already gone; `close` decided why.
        if (current.timer) clearInterval(current.timer);
        current.timer = null;
        resolve(fail(classify(current.output)));
        return;
      }
      if (await canConnect(BRIDGE_HOST, port)) {
        if (current.timer) clearInterval(current.timer);
        current.timer = null;
        current.snapshot = { ...current.snapshot, state: "running", reason: null };
        resolve({ ...current.snapshot });
        return;
      }
      if (Date.now() > deadline) {
        resolve(fail(classify(current.output)));
      }
    };
    void tick();
    current.timer = setInterval(() => void tick(), READY_PROBE_MS);
  });
}

/** Quote one argument for cmd.exe; the account is the only user-supplied part. */
function quote(arg: string): string {
  return /^[A-Za-z0-9_.:@=/-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "")}"`;
}

export function stopSignalBridge(): SignalBridgeSnapshot {
  if (!session) return idle();
  if (session.timer) clearInterval(session.timer);
  stop(session.child);
  session = {
    child: null,
    snapshot: { ...session.snapshot, state: "idle", reason: null },
    timer: null,
    output: "",
  };
  return { ...session.snapshot };
}

export function disposeSignalBridge() {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  stop(session.child);
  session = null;
}

process.once("exit", () => {
  disposeSignalBridge();
});
