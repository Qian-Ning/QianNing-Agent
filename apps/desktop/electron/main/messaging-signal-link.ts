import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Signal device linking.
 *
 * Signal has no OAuth and no hosted portal: a new device joins by proving it
 * has the phone. `signal-cli link` prints a `sgnl://linkdevice?...` URI and
 * waits; the Signal app on the phone scans that URI and the process finishes
 * with the account it bound to. That URI is the reason this channel can be set
 * up by scanning at all — every other messaging platform in this app hands out
 * credentials on a web page, Signal hands out a device.
 *
 * The process, not the renderer, owns the truth: the URI arrives on the
 * child's output, the account arrives when the phone confirms, and the child
 * dying means the link failed. The session below is the only place that
 * collects those three facts so a polling caller cannot see them out of order.
 */

export type SignalLinkFailure = "missing-cli" | "exited" | "timeout" | "cancelled";

export type SignalLinkState = "idle" | "starting" | "waiting" | "linked" | "failed";

export type SignalLinkSnapshot = {
  state: SignalLinkState;
  /** The `sgnl://` URI to render as a QR, once signal-cli has printed it. */
  url: string | null;
  /** The number the device bound to, once the phone confirmed. */
  account: string | null;
  reason: SignalLinkFailure | null;
};

const DEVICE_NAME = "PI Desktop";
const URI_PATTERN = /sgnl:\/\/linkdevice\?[^\s"'<>]+/u;
const ACCOUNT_PATTERN = /\+[1-9][0-9]{5,14}/u;
/** signal-cli prints the URI within a second; anything slower is a broken install. */
const URI_DEADLINE_MS = 20_000;
/** The phone has this long to scan before the code is treated as stale. */
const LINK_DEADLINE_MS = 180_000;

type Session = {
  child: ChildProcess | null;
  snapshot: SignalLinkSnapshot;
  settleUri: ((snapshot: SignalLinkSnapshot) => void) | null;
  uriTimer: NodeJS.Timeout | null;
  linkTimer: NodeJS.Timeout | null;
  output: string;
};

let session: Session | null = null;

const idle = (): SignalLinkSnapshot => ({
  state: "idle",
  url: null,
  account: null,
  reason: null,
});

function settle(failure: SignalLinkFailure) {
  if (!session) return;
  const current = session;
  if (current.uriTimer) clearTimeout(current.uriTimer);
  if (current.linkTimer) clearTimeout(current.linkTimer);
  stop(current.child);
  current.child = null;
  current.snapshot = { ...current.snapshot, state: "failed", reason: failure, url: null };
  const resolve = current.settleUri;
  current.settleUri = null;
  resolve?.(current.snapshot);
}

/**
 * Whether the command can be started at all.
 *
 * Windows launches through ComSpec, and ComSpec exists even when the program
 * does not — the failure would arrive as a nonzero exit, which is
 * indistinguishable from a person closing the scanner. Asking `where` first
 * keeps "not installed" a fact instead of an inference.
 */
function cliExists(cli: string): boolean {
  if (cli.includes("/") || cli.includes("\\")) return existsSync(cli);
  if (process.platform !== "win32") return true;
  return spawnSync("where.exe", [cli], { stdio: "ignore", windowsHide: true }).status === 0;
}

function launch(cli: string): ChildProcess {
  // A `.cmd`/`.bat` shim — which is how signal-cli ships on Windows through
  // scoop and chocolatey — cannot be executed directly; only a shell can run
  // it. Everything appended here is a constant, so `shell` buys compatibility
  // without letting user text into a command line.
  // Through a shell Node joins arguments without quoting them, so the device
  // name carries its own quotes — otherwise "PI Desktop" arrives as two
  // arguments and signal-cli rejects the extra one.
  const args =
    process.platform === "win32"
      ? ["link", "-n", `"${DEVICE_NAME}"`]
      : ["link", "-n", DEVICE_NAME];
  return spawn(cli, args, {
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Stop the attempt.
 *
 * Through a shell, the child is `cmd.exe` and the real process is its
 * grandchild — killing the shell alone leaves signal-cli holding the link and
 * the phone able to finish a pairing the UI already gave up on. `/T` takes the
 * tree; `/F` is what the orphan needs.
 */
function stop(child: ChildProcess | null) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill();
}

export function signalLinkSnapshot(): SignalLinkSnapshot {
  return session ? { ...session.snapshot } : idle();
}

/**
 * Begin linking. Resolves once the URI exists (so the caller can draw a QR) or
 * once the attempt has already failed — never on a timer the caller has to
 * guess at.
 */
export function startSignalLink(cliPath?: string): Promise<SignalLinkSnapshot> {
  if (session && (session.snapshot.state === "starting" || session.snapshot.state === "waiting")) {
    return Promise.resolve({ ...session.snapshot });
  }

  const cli = cliPath?.trim() || process.env.PI_DESKTOP_SIGNAL_CLI?.trim() || "signal-cli";
  const current: Session = {
    child: null,
    snapshot: { state: "starting", url: null, account: null, reason: null },
    settleUri: null,
    uriTimer: null,
    linkTimer: null,
    output: "",
  };
  session = current;

  if (!cliExists(cli)) {
    current.snapshot = { state: "failed", url: null, account: null, reason: "missing-cli" };
    return Promise.resolve({ ...current.snapshot });
  }

  const child = launch(cli);
  current.child = child;

  const finishStart = (snapshot: SignalLinkSnapshot) => {
    if (current.settleUri) {
      const resolve = current.settleUri;
      current.settleUri = null;
      resolve(snapshot);
    }
  };

  return new Promise<SignalLinkSnapshot>((resolve) => {
    current.settleUri = resolve;
    current.uriTimer = setTimeout(() => settle("timeout"), URI_DEADLINE_MS);
    current.linkTimer = setTimeout(() => settle("timeout"), LINK_DEADLINE_MS);

    const onData = (chunk: Buffer) => {
      if (session !== current) return;
      current.output += chunk.toString("utf8");

      if (current.snapshot.url === null) {
        const uri = current.output.match(URI_PATTERN);
        if (uri) {
          if (current.uriTimer) clearTimeout(current.uriTimer);
          current.uriTimer = null;
          current.snapshot = { ...current.snapshot, state: "waiting", url: uri[0] };
          finishStart({ ...current.snapshot });
        }
      }

      if (current.snapshot.state === "waiting") {
        const account = current.output.match(ACCOUNT_PATTERN);
        if (account) {
          if (current.linkTimer) clearTimeout(current.linkTimer);
          current.linkTimer = null;
          current.snapshot = {
            state: "linked",
            url: current.snapshot.url,
            account: account[0],
            reason: null,
          };
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.once("error", () => {
      if (session === current) {
        current.child = null;
        settle("missing-cli");
      }
    });

    child.once("close", (code) => {
      if (session !== current) return;
      current.child = null;
      if (current.snapshot.state === "linked" && code === 0) {
        if (current.linkTimer) clearTimeout(current.linkTimer);
        const resolve2 = current.settleUri;
        current.settleUri = null;
        resolve2?.(current.snapshot);
        return;
      }
      // The scanner is the only thing that can complete this; a process that
      // exits without an account means the code was never used.
      settle(current.snapshot.url === null ? "exited" : "cancelled");
    });
  });
}

export function cancelSignalLink(): SignalLinkSnapshot {
  if (!session) return idle();
  settle("cancelled");
  return signalLinkSnapshot();
}

/**
 * End any live attempt and forget it.
 *
 * Called by the app lifecycle before quit and by the exit hook below. Without
 * it the JVM keeps holding a provisioning socket after the window is gone, and
 * the next launch stacks a second one behind it.
 */
export function disposeSignalLink() {
  stop(session?.child ?? null);
  session = null;
}

process.once("exit", () => {
  stop(session?.child ?? null);
});
