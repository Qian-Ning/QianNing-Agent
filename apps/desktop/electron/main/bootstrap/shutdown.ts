import { app, globalShortcut, type Tray } from "electron";
import type { CloseBehavior } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import { settleWithinBudget, type InflightCheckpointer, type MessagingOutboundRelay } from "@pi-desktop/host-runtime";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginPanelHost } from "../plugin-panel-host";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { AppUpdaterController } from "../updater";
import type { UserMcpRuntime } from "../user-mcp";
import type { McpControlServer } from "../mcp-control";
import type { McpOAuthManager } from "../mcp-oauth";
import { getActiveRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import { uninstallMediaAssetProtocol } from "../media-asset-protocol";
import { uninstallInlineVizProtocol } from "../inline-viz-protocol";

const QUIT_TURN_SETTLE_BUDGET_MS = 2_000;

/**
 * How long a quit waits for the inbound messaging loop to leave `run` after its
 * abort. The loop's own host calls carry no abort signal, so a single in-flight
 * iteration is bounded only by the host RPC deadline — far longer than a quit
 * may wait; this budget keeps that from stalling the quit.
 */
const QUIT_MESSAGING_INBOUND_BUDGET_MS = 2_000;

export type ShutdownState = {
  shutdownComplete: boolean;
  shutdownPromise: Promise<void> | null;
  quitting: boolean;
  quitConfirmed: boolean;
  closeBehavior: CloseBehavior;
  tray: Tray | null;
  pluginLauncherAccelerator: string | null;
  toggleWindowAccelerator: string | null;
};

export type ShutdownDependencies = {
  hasSingleInstanceLock: boolean;
  state: ShutdownState;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getMcpControl: () => McpControlServer | null;
  /**
   * Stop every inbound messaging loop this boot started.
   *
   * One call rather than one getter per channel: the loops are owned by
   * `MessagingInboundSupervisor` (`../messaging-inbound-lifecycle`), the same
   * owner a settings write reconciles, so shutdown cannot stop a handle that
   * was replaced when a channel's record was re-saved. The supervisor aborts
   * each loop and waits for it, bounded per channel, before host-core is
   * disposed.
   */
  stopMessagingInbound: () => Promise<void>;
  /** The outbound messaging relay this boot subscribed, if any. */
  getMessagingOutbound: () => MessagingOutboundRelay | null;
  activeTurns: Map<string, string>;
  persistenceOutbox: PersistenceOutbox;
  inflightCheckpointer: InflightCheckpointer;
  pluginPanels: Pick<PluginPanelHost, "closeAll">;
  plugins: Pick<PluginRuntime, "disposeAll">;
  userMcp: Pick<UserMcpRuntime, "disposeAll">;
  mcpOAuth?: Pick<McpOAuthManager, "disposeAll">;
  browserHost: Pick<BrowserHost, "dispose">;
  pluginViews: Pick<PluginViewHost, "dispose">;
  updater: Pick<AppUpdaterController, "dispose" | "isInstallingUpdate">;
  logger: Pick<Logger, "app">;
  confirmQuitDialog: () => Promise<boolean>;
  disposePowerSaveBlockers: () => void;
  disposeSystemProxyRelay?: () => Promise<void>;
};

/** Register the last-window and before-quit resource lifecycle handlers. */
export function registerShutdownHandlers({
  hasSingleInstanceLock,
  state,
  getHost,
  getSidecar,
  getMcpControl,
  stopMessagingInbound,
  getMessagingOutbound,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  pluginPanels,
  plugins,
  userMcp,
  mcpOAuth,
  browserHost,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
  disposePowerSaveBlockers,
  disposeSystemProxyRelay,
}: ShutdownDependencies): void {
  /** True while the quit confirmation card is open, so one question owns the quit. */
  let quitConfirmationInFlight = false;

  app.on("window-all-closed", () => {
    // The D216 tray is resident on every platform, so its presence says nothing
    // about whether the app should survive a closed window — the user's close
    // behavior does. Under "tray" a window destroyed for any reason must not
    // take the app down (the tray click recreates it); otherwise closing the
    // last window on Windows/Linux exits the app as before.
    if (process.platform === "darwin") return;
    if (state.closeBehavior === "tray" && state.tray) return;
    app.quit();
  });

  app.on("before-quit", (event) => {
    // A duplicate launch has no host, sidecar, panel, or outbox of its own, and
    // the shutdown sequence below would write into the running instance's data
    // directory. Let it exit straight away.
    if (!hasSingleInstanceLock) return;
    if (state.shutdownComplete) return;
    event.preventDefault();
    if (state.shutdownPromise) return;

    // Show a confirmation dialog on the first explicit quit (Cmd+Q, tray quit,
    // application-menu Quit). The data-saving shutdown runs after confirmation.
    // Skip confirmation in automated probe/capture modes where no human is
    // present to interact with the dialog.
    const isAutomatedMode =
      process.env.PI_DESKTOP_BOOT_PROBE === "1" ||
      process.env.PI_DESKTOP_SUPERVISION_PROBE === "1" ||
      process.env.PI_DESKTOP_CAPTURE === "1";
    // Skip confirmation for the quit that an in-app update performs. The
    // installer for that update was already spawned before app.quit(), and it
    // aborts once the app stays alive for a few seconds, so deferring this quit
    // behind a dialog fails the update. There is no decision left either: the
    // user chose "restart to update" to get here.
    const isUpdateRestart = updater.isInstallingUpdate();
    if (!state.quitConfirmed && !isAutomatedMode && !isUpdateRestart) {
      // A second quit request while the card is open (a repeated Cmd+Q, the
      // tray item, a menu click) must neither stack a second card nor fall
      // through to the shutdown below unanswered: `quitConfirmed` is already
      // latched so this branch is skipped, and it is this flag that keeps the
      // request from reaching the shutdown.
      if (quitConfirmationInFlight) return;
      quitConfirmationInFlight = true;
      state.quitConfirmed = true;
      void confirmQuitDialog().then((confirmed) => {
        quitConfirmationInFlight = false;
        if (confirmed) {
          app.quit();
        } else {
          // User cancelled: allow future quit requests to prompt again.
          state.quitConfirmed = false;
        }
      });
      return;
    }

    state.quitting = true;
    // Release the media-library request handler with the other resource
    // disposals; the scheme itself was reserved before ready and cannot be
    // un-reserved (ADR 0322).
    uninstallMediaAssetProtocol();
    // Release the session-visualization request handler the same way; the
    // scheme itself was reserved before ready (ADR 0328).
    uninstallInlineVizProtocol();
    disposePowerSaveBlockers();
    state.tray?.destroy();
    state.tray = null;
    if (state.pluginLauncherAccelerator) {
      globalShortcut.unregister(state.pluginLauncherAccelerator);
      state.pluginLauncherAccelerator = null;
    }
    if (state.toggleWindowAccelerator) {
      globalShortcut.unregister(state.toggleWindowAccelerator);
      state.toggleWindowAccelerator = null;
    }
    state.shutdownPromise = (async () => {
      // Stop every inbound messaging loop first: each reads and writes the
      // settings row through the local host-core, and this shutdown owns them
      // through the supervisor, so they are aborted and awaited before the host
      // is disposed. The supervisor bounds each wait, so a loop stuck on a host
      // RPC cannot hold up the quit; a loop that does not settle is left
      // reported as running rather than claimed stopped.
      await stopMessagingInbound();
      // The outbound messaging relay is released the same way, before host-core
      // is disposed: it unsubscribes at once, and the wait is bounded so a
      // release that ever refused to settle cannot hold up the quit.
      const messagingOutbound = getMessagingOutbound();
      messagingOutbound?.stop();
      await settleWithinBudget(messagingOutbound?.done, QUIT_MESSAGING_INBOUND_BUDGET_MS);
      // Close every paired remote host before the local host-core so any
      // in-flight remote turn's abort still goes over a live socket. Bounded
      // parallelism inside `closeAll`; safe to run before local disposals.
      const remoteHostsShutdown = getActiveRemoteHostsBoot()?.closeAll();
      setActiveRemoteHostsBoot(null);
      // Replies still streaming are stopped through the sidecar first so their
      // aborted final rows can reach the transcript while host-core is alive;
      // whatever does not make it in time is covered by the last checkpoint
      // (D299). Bounded: a quit must not hang on an unresponsive provider.
      await settleRunningTurnsForQuit({
        activeTurns,
        getHost,
        getSidecar,
        inflightCheckpointer,
        persistenceOutbox,
        logger,
      });
      // Panel windows and docked views are the only pages that call the plugin
      // runtime over the panel bridge. They are torn down, and their pages are
      // waited for, before the runtime and the host stop: a call such a page
      // already sent while its surface was closing is otherwise answered by a
      // runtime that is already shutting down, and surfaces as a bridge failure
      // nobody can act on. The wait is bounded inside the hosts, so a page that
      // refuses to close cannot hold up the quit.
      const pluginSurfacesShutdown = Promise.allSettled([
        pluginPanels.closeAll(),
        pluginViews.dispose(),
      ]);
      logger.app("lifecycle", "info", "app shutdown");
      await pluginSurfacesShutdown;
      const hostShutdown = getHost()?.dispose();
      const mcpShutdown = getMcpControl()?.stop();
      updater.dispose();
      // Plugin hosts are stopped as a shutdown, not left for the process teardown
      // to kill: an unannounced exit is indistinguishable from a crash, and would
      // end every quit in error logs, toasts, and restarts into a closing app.
      const pluginShutdown = plugins.disposeAll();
      userMcp.disposeAll();
      mcpOAuth?.disposeAll();
      browserHost.dispose();
      inflightCheckpointer.dispose();
      const sidecarShutdown = getSidecar()?.dispose();

      try {
        await hostShutdown;
      } catch (error) {
        logger.app("lifecycle", "warn", "host shutdown failed", { data: String(error) });
      }
      await Promise.allSettled([
        pluginShutdown,
        sidecarShutdown,
        mcpShutdown,
        remoteHostsShutdown,
      ]);
      // The relay is loopback-only and disposable; closing it here keeps a quit
      // from leaving its listening socket behind.
      await disposeSystemProxyRelay?.();
    })();

    const releaseQuit = () => {
      state.shutdownComplete = true;
      app.quit();
    };
    void state.shutdownPromise.then(releaseQuit, releaseQuit);
  });
}

type TurnSettlementDependencies = {
  activeTurns: Map<string, string>;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  inflightCheckpointer: InflightCheckpointer;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
};

async function settleRunningTurnsForQuit({
  activeTurns,
  getHost,
  getSidecar,
  inflightCheckpointer,
  persistenceOutbox,
  logger,
}: TurnSettlementDependencies): Promise<void> {
  const sessions = [...activeTurns.keys()];
  const deadline = Date.now() + QUIT_TURN_SETTLE_BUDGET_MS;
  // The newest snapshot of every streaming reply lands first: it is the
  // fallback if the abort below does not produce a final row in time.
  await inflightCheckpointer.flushAll();
  if (sessions.length === 0) {
    await persistenceOutbox.flush(getHost);
    return;
  }
  const sidecar = getSidecar();
  if (sidecar) {
    await Promise.allSettled(
      sessions.map((sessionId) =>
        Promise.race([
          sidecar.call("agent.abort", { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]),
      ),
    );
  }
  // The abort surfaces as message_end + error/agent_end, which finishTurn
  // turns into a settled turn and an outbox append. Wait for that, bounded.
  while (Date.now() < deadline) {
    await persistenceOutbox.flush(getHost);
    if (activeTurns.size === 0 && persistenceOutbox.size() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await persistenceOutbox.flush(getHost);
  if (activeTurns.size > 0 || persistenceOutbox.size() > 0) {
    logger.app("lifecycle", "warn", "quit before streaming replies settled", {
      data: { running: activeTurns.size, pendingAppends: persistenceOutbox.size() },
    });
  }
}
