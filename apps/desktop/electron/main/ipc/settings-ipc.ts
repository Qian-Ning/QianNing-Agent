import { IPC, type UpdatePreference } from "@pi-desktop/shared";
import {
  bindMessagingInboundSession,
  createHostSessionOwnerWriter,
  createHostSettingsSurface,
  messagingChannelForSection,
  SLACK_INBOUND_CHANNEL,
} from "@pi-desktop/host-runtime";
import {
  INGRESS_WEBHOOK_RECEIVER_SECTION,
  MESSAGING_DISCORD_SECTION,
  MESSAGING_EMAIL_SECTION,
  MESSAGING_HOME_ASSISTANT_SECTION,
  MESSAGING_IRC_SECTION,
  MESSAGING_MATRIX_SECTION,
  MESSAGING_MATTERMOST_SECTION,
  MESSAGING_NTFY_SECTION,
  MESSAGING_SLACK_SECTION,
  MESSAGING_TELEGRAM_SECTION,
} from "@pi-desktop/agent-host";
import {
  reconcileAllMessagingChannels,
  reconcileMessagingChannelSection,
} from "../messaging-inbound-lifecycle";
import { messagingGateway } from "../messaging-gateway";
import { discoverTelegramChats, probeTelegramBot } from "../messaging-telegram-probe";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { currentSystemProxyRelayUrl } from "../network-proxy";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyUpdatePreference: (preference: UpdatePreference) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyUpdatePreference,
  resolveEffectiveCommandShell,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  handle(IPC.invoke.settingsSet, async (settings: unknown) => {
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const result = await host.call("settings.set", validatedSettings);
    // A general settings save round-trips the renderer's settings snapshot,
    // which includes the messaging sections, so a channel's record can change
    // here and not only through its own channel. Reconcile when one was in the
    // write: a loop whose record no longer justifies it is stopped, and one
    // whose record became startable is started. Idempotent, so a save that
    // leaves a record alone leaves its loop alone.
    if (
      typeof validatedSettings === "object" &&
      validatedSettings !== null &&
      Object.keys(validatedSettings).some((key) => messagingChannelForSection(key) !== null)
    ) {
      await reconcileAllMessagingChannels();
    }
    const updatePreference = (validatedSettings as { updatePreference?: unknown })
      .updatePreference;
    if (updatePreference === "automatic" || updatePreference === "manual") {
      applyUpdatePreference(updatePreference);
    }
    if (typeof (validatedSettings as { keepAwakeWhileRunning?: unknown })
      .keepAwakeWhileRunning === "boolean") {
      applyKeepAwakeWhileRunning(validatedSettings as { keepAwakeWhileRunning: boolean });
    }
    if (typeof (validatedSettings as { preventScreenSleep?: unknown })
      .preventScreenSleep === "boolean") {
      applyPreventScreenSleep(validatedSettings as { preventScreenSleep: boolean });
    }
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
          systemProxyRelayUrl: currentSystemProxyRelayUrl(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  });

  // One messaging channel's settings section, written on the host's internal
  // call path. The section name is checked against the channels this build
  // ships, so a channel can never be used as a general-purpose settings writer,
  // and the value must be an object because `settings.set` replaces the whole
  // section with it. Nothing here decides whether the record is complete: the
  // host reads it, refuses a foreign `format`/`version` and leaves an incomplete
  // channel inert, which is the same gate it applies to a record written any
  // other way.
  handle(
    IPC.invoke.messagingSetSection,
    async (input: { section?: unknown; value?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const section = input?.section;
      if (
        section !== MESSAGING_TELEGRAM_SECTION &&
        section !== MESSAGING_SLACK_SECTION &&
        section !== MESSAGING_DISCORD_SECTION &&
        section !== MESSAGING_MATTERMOST_SECTION &&
        section !== MESSAGING_MATRIX_SECTION &&
        section !== MESSAGING_IRC_SECTION &&
        section !== MESSAGING_HOME_ASSISTANT_SECTION &&
        section !== MESSAGING_NTFY_SECTION &&
        section !== MESSAGING_EMAIL_SECTION &&
        // Not a channel, and named no product: the shared inbound-webhook
        // receiver's own configuration. It belongs here because it is the same
        // host-internal write path, and it is safe on it because the record
        // carries a `secret:` ref — there is no field a secret value could be
        // written into.
        section !== INGRESS_WEBHOOK_RECEIVER_SECTION
      ) {
        throw Object.assign(new Error("unknown messaging settings section"), {
          errorCode: "INVALID_PARAMS",
        });
      }
      const value = input?.value;
      // `null` clears the section: that is how the panel's enable toggle turns
      // a channel off. The host reads no section, registers nothing and polls
      // nothing, while the credentials stay in the secret store under their
      // refs, so turning the channel back on needs no retyping.
      if (value === null) {
        await host.call("settings.set", { [section]: null });
        // The record is gone, so the loop it configured is gone with it. Turning
        // a channel off used to hide it while its transport kept its socket and
        // its credential, which is the `已关闭` / `运行中` pair this closes.
        await reconcileMessagingChannelSection(section);
        return { ok: true };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        throw Object.assign(new Error("the messaging settings section must be an object"), {
          errorCode: "INVALID_PARAMS",
        });
      }
      await host.call("settings.set", { [section]: value });
      // The record was replaced. Every push transport reads it once, at start,
      // so the new record only takes effect through a fresh loop — and a record
      // that can no longer start (a required field or a secret removed) leaves
      // no loop running at all.
      await reconcileMessagingChannelSection(section);
      return { ok: true };
    },
  );

  /*
    The third state dimension: which inbound loops are actually running. The
    registry is the composition root's own record of the handles it started
    (`bootstrap/startup.ts`), so this answers a fact about this process rather
    than a guess about configuration.
  */
  handle(IPC.invoke.messagingGateway, async () => messagingGateway.snapshot());

  /*
    Telegram quick setup. The token crosses this channel once and is used
    immediately; the module never echoes it, and a failure is a typed code.
  */
  handle(
    IPC.invoke.messagingTelegramProbe,
    async (input: { token?: unknown; action?: unknown }) => {
      const action = input?.action;
      if (action === "bot") return probeTelegramBot(input?.token, { fetch });
      if (action === "chats") return discoverTelegramChats(input?.token, { fetch });
      throw Object.assign(new Error("unknown Telegram probe action"), {
        errorCode: "INVALID_PARAMS",
      });
    },
  );

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());

  // Bind the linked messaging conversation to the session its inbound commands
  // act on (ADR 0205 D375 item 9). This is the writer the inbound wiring's
  // binding store never had: without it a linked chat is always unbound and
  // every inbound command is refused. It is a host-internal write, not a RACP
  // operation: the handler calls the local host (`getHost()`) directly rather
  // than going through the router, and `settings` is not in `RACP_OPERATIONS`,
  // so the write never leaves this process and no RACP peer can reach it. It
  // writes only the channel's own settings key (see
  // `bindMessagingInboundSession`), so it cannot clobber a neighbouring app
  // setting, and it fails closed on a blank or non-string id.
  handle(IPC.invoke.messagingInboundBindSession, async (sessionId: unknown) => {
    if (!host) throw new Error("host unavailable");
    await bindMessagingInboundSession(
      createHostSettingsSurface(getHost),
      sessionId,
      createHostSessionOwnerWriter(getHost),
    );
    return { ok: true };
  });

  // The Slack channel's counterpart bind (ADR 0326): the same host-internal,
  // non-RACP write, selecting the Slack settings section. The Telegram handler
  // above is unchanged.
  handle(IPC.invoke.messagingInboundBindSessionSlack, async (sessionId: unknown) => {
    if (!host) throw new Error("host unavailable");
    await bindMessagingInboundSession(
      createHostSettingsSurface(getHost),
      sessionId,
      createHostSessionOwnerWriter(getHost),
      SLACK_INBOUND_CHANNEL,
    );
    return { ok: true };
  });
}
