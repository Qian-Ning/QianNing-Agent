/**
 * The desktop main process's inbound-loop lifecycle: one supervisor that owns
 * every channel's loop and can be reached from the settings write path.
 *
 * Before this module the composition root started nine loops and stored nine
 * `AbortController`s on the process state, and nothing but shutdown could reach
 * them. The Messaging platforms panel turns a channel off by clearing its
 * settings section, so the record could disappear while the loop that record
 * configured kept running — a channel the panel called `已关闭` whose gateway
 * still said `运行中`, holding its socket and its credential.
 *
 * Now startup builds the supervisor, `bootstrap/startup.ts` asks it to reconcile
 * (only startable channels run at boot) and every messaging settings write asks
 * it to reconcile again, so the loops follow the records in both directions.
 * Shutdown calls one `stopAll`, so there is still exactly one owner.
 *
 * The supervisor is a process-wide singleton because the IPC handler that
 * answers a settings write and the composition root that built the loops are
 * different modules; a second instance would own nothing and stop nothing.
 */

import {
  MessagingInboundSupervisor,
  createDiscordInboundWiring,
  createEmailInboundWiring,
  createHomeAssistantInboundWiring,
  createHostSecretReader,
  createHostSettingsSurface,
  createIrcInboundWiring,
  createMattermostInboundWiring,
  createMatrixInboundWiring,
  createMessagingInboundReadiness,
  createMessagingInboundWiring,
  createNtfyInboundWiring,
  createSlackInboundWiring,
  messagingChannelForSection,
  type HostRpc,
  type MessagingInboundHostSurface,
  type MessagingInboundWiringLog,
} from "@pi-desktop/host-runtime";

import { messagingGateway } from "./messaging-gateway";

export type MessagingInboundLifecycleOptions = {
  /** The local host's RPC surface; the settings row and the secrets live there. */
  getHost: () => HostRpc | null;
  /** The Agent Host the inbound commands are applied through. */
  agentHost: MessagingInboundHostSurface;
  log?: MessagingInboundWiringLog;
};

/**
 * Build a supervisor for every channel this build can start.
 *
 * Every starter reads the host's own surfaces — the channel's settings section,
 * the secret store, the settings row the cursors and replay guards ride — and
 * nothing new is introduced here: this is the same wiring each channel had in
 * `bootstrap/startup.ts`, now reached through one owner.
 */
export function createMessagingInboundSupervisor(
  options: MessagingInboundLifecycleOptions,
): MessagingInboundSupervisor {
  const settings = createHostSettingsSurface(options.getHost);
  const secrets = createHostSecretReader(options.getHost);
  const common = {
    agentHost: options.agentHost,
    settings,
    secrets,
    ...(options.log ? { log: options.log } : {}),
  };
  return new MessagingInboundSupervisor({
    readiness: createMessagingInboundReadiness({ settings, secrets }),
    gateway: messagingGateway,
    ...(options.log ? { log: options.log } : {}),
    starters: {
      telegram: (signal) => createMessagingInboundWiring({ ...common, signal }),
      slack: (signal) => createSlackInboundWiring({ ...common, signal }),
      discord: (signal) => createDiscordInboundWiring({ ...common, signal }),
      mattermost: (signal) => createMattermostInboundWiring({ ...common, signal }),
      matrix: (signal) => createMatrixInboundWiring({ ...common, signal }),
      irc: (signal) => createIrcInboundWiring({ ...common, signal }),
      homeAssistant: (signal) => createHomeAssistantInboundWiring({ ...common, signal }),
      ntfy: (signal) => createNtfyInboundWiring({ ...common, signal }),
      email: (signal) => createEmailInboundWiring({ ...common, signal }),
    },
  });
}

let current: MessagingInboundSupervisor | null = null;

/** Install the supervisor this boot built. Called once, by the composition root. */
export function setMessagingInboundSupervisor(supervisor: MessagingInboundSupervisor | null): void {
  current = supervisor;
}

/** The supervisor this boot built, or `null` before boot / after shutdown. */
export function getMessagingInboundSupervisor(): MessagingInboundSupervisor | null {
  return current;
}

/**
 * Bring one channel's loop into line with its saved record, after that channel's
 * settings section was written.
 *
 * Never throws: a settings write that has already landed at the host must not be
 * reported as failed because a loop would not stop. The failure is logged, and
 * the loop keeps running — which the gateway flag then still reports honestly.
 */
export async function reconcileMessagingChannelSection(section: string): Promise<void> {
  const supervisor = current;
  const channel = messagingChannelForSection(section);
  if (!supervisor || !channel) return;
  try {
    await supervisor.reconcile(channel);
  } catch (error) {
    logReconcileFailure(channel, error);
  }
}

/**
 * Bring every channel's loop into line with its saved record, after a write that
 * could have touched any of them (the general settings save round-trips the
 * messaging sections).
 *
 * Idempotent: a loop whose record is still startable is left running.
 */
export async function reconcileAllMessagingChannels(): Promise<void> {
  const supervisor = current;
  if (!supervisor) return;
  try {
    await supervisor.reconcileAll();
  } catch (error) {
    logReconcileFailure("all", error);
  }
}

function logReconcileFailure(channel: string, error: unknown): void {
  // No logger import here: this module is also the one a test can build, and the
  // supervisor already logs the per-channel detail through its own sink.
  console.warn(
    `[messaging] gateway reconcile failed for ${channel}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
