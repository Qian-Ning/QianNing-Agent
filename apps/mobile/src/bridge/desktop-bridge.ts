import { PROTOCOL_VERSION } from "@pi-desktop/shared";
import type { HostClient } from "../lib/racp";
import type { AgentStore } from "../agent/store";
import { toDesktopEvents, type LocalEvent } from "./agent-events";
import {
  ProjectBook,
  toProjectGroup,
  toProjectRecord,
  toWorkspace,
} from "../agent/projects";
import { findBundledSkill } from "../agent/skills";
import { ProviderBook, listModels, toPublic } from "./providers";
import { deletePreset, listPresets, savePreset } from "./prompt-presets";
import { readSessionConfig, updateSessionConfig } from "../agent/session-config";
import { collectTurns, tokenUsageHistory, usageBreakdown, type UsageTurn } from "../agent/usage-report";
import {
  createSchedule,
  dueAt,
  loadRuns,
  loadSchedules,
  removeSchedule,
  saveSchedule,
  type Schedule,
  type ScheduleCadence,
} from "../agent/schedules";
import { runScheduleNow } from "../agent/schedule-runner";
import {
  deleteSshProfile,
  disconnectSsh,
  ensureSsh,
  hasSsh,
  isConnected,
  listSshProfiles,
  probeSsh,
  runSsh,
  saveSshProfile,
} from "../agent/connections";
import {
  loadNotices,
  markAllRead,
  markRead,
  unreadCount as unreadNotices,
} from "../agent/notifications";
import {
  cancelWorkbench,
  clearLibrary,
  generate as generateMedia,
  library as mediaLibrary,
  removeFromLibrary,
} from "../media/workbench";
import {
  fetchSessions,
  hasRemoteHost,
  listComputers,
  pairComputer,
  removeComputer,
} from "../remote/computers";
import type { ModelPricingRow } from "@pi-desktop/shared";
import {
  pickDeviceFiles,
  readDeviceText,
  readDeviceDataUrl,
  type PickedFile,
} from "../lib/files";

/**
 * The desktop interface's host, implemented for the phone.
 *
 * ADR 0339 puts the desktop renderer on the phone. That renderer only knows
 * `window.piDesktop.invoke(channel, ...args)` and `window.piDesktop.on(...)`, so
 * a phone build needs exactly this: the channel table, answered from the phone's
 * own host instead of Electron's main process.
 *
 * Two rules keep it honest while it is incomplete:
 * - every answer uses the renderer's envelope, `{ ok: true, value }` or
 *   `{ ok: false, error }` — a raw value makes the shell throw;
 * - a channel nobody has implemented says so, by name. A silent `null` looks
 *   like "no data" and the interface lies about what it knows.
 */
export type BridgeEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** What the bridge needs from the phone's agent host — nothing more. */
export type AgentHostLike = {
  send(sessionId: string, text: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: LocalEvent) => void): () => void;
  interrupt?(sessionId: string): void;
  /** Rewrites the instructions for one conversation; optional for hosts that
   * run a single fixed prompt. */
  setSystemPrompt?(sessionId: string, systemPrompt: string | null): void;
  /** Answers a pending tool approval raised by the host. */
  resolvePermission?(requestId: string, decision: "allow-once" | "allow-session" | "deny"): boolean;
  /** Applies the user's permission mode to future tool calls. */
  setPermissionMode?(mode: "ask" | "accept-edits" | "auto"): void;
  /** Summarizes the older part of a conversation right now. */
  compact?(sessionId: string): Promise<{ compacted: boolean; dropped: number; count: number }>;
  /** How many times this conversation has been compacted. */
  compactionRecord?(sessionId: string): { count: number; dropped: number; at?: string };
};

export type BridgeEnvironment = {
  store: AgentStore;
  platform: string;
  version: string;
  /** Built at start when a provider is already configured. */
  host?: AgentHostLike;
  /** Lets the bridge attach a host the first time a service is added. */
  createHost?: (config: { baseUrl: string; apiKey: string; modelId: string }) => AgentHostLike;
  now?: () => number;
};

export type BridgeListener = (payload: unknown) => void;

const PREFIX = "pi-desktop/";
const AGENT_EVENT = "agent/event/message";

/**
 * Session channels disagree on how they name their first argument: some send a
 * bare id string (`sessionDelete`, `configureSession`), others send `{ id }`
 * or `{ sessionId }`. Reading only one shape made model selection and deleting
 * a conversation fail with "sessionId is required" while the same id sat in
 * the call.
 */
function sessionIdOf(input: unknown): string {
  if (typeof input === "string") return input;
  const request = (input ?? {}) as { id?: string; sessionId?: string };
  return request.id ?? request.sessionId ?? "";
}

/** Channels that only show or hide a desktop surface the phone does not have. */
const COSMETIC_PREFIXES = ["plugin/view/", "plugin/panel/", "window/", "menu/", "tray/", "panel/"];

function isCosmeticChannel(key: string): boolean {
  return COSMETIC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export class PhoneBridge {
  private readonly listeners = new Map<string, Set<BridgeListener>>();
  /** Sessions whose local events are already being translated onto the bus. */
  private readonly forwarded = new Map<string, () => void>();
  /** Model services the user added on the phone. */
  private readonly providers: ProviderBook;

  private readonly env: BridgeEnvironment;

  private host?: AgentHostLike;
  /** The user's own settings, persisted where the phone can keep them. */
  private readonly settings: Record<string, unknown>;
  /** Picked files waiting for the composer to import them, keyed by token. */
  private readonly picked = new Map<string, PickedFile[]>();

  private readonly projects: ProjectBook;

  constructor(env: BridgeEnvironment) {
    this.env = env;
    this.projects = new ProjectBook(env.store);
    this.host = env.host;
    this.settings = this.readSettings();
    this.applyPermissionMode();
    this.providers = new ProviderBook(env.store);
  }

  /** The object the renderer expects at `window.piDesktop`. */
  toWindowApi() {
    return {
      platform: this.env.platform,
      invoke: (channel: string, ...args: unknown[]) => this.invoke(channel, ...args),
      on: (channel: string, listener: BridgeListener) => this.on(channel, listener),
      off: (channel: string, listener: BridgeListener) => this.off(channel, listener),
      once: (channel: string, listener: BridgeListener) => this.once(channel, listener),
      send: () => undefined,
    };
  }

  on(channel: string, listener: BridgeListener): () => void {
    const key = strip(channel);
    const set = this.listeners.get(key) ?? new Set<BridgeListener>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => this.off(key, listener);
  }

  off(channel: string, listener: BridgeListener): void {
    this.listeners.get(strip(channel))?.delete(listener);
  }

  once(channel: string, listener: BridgeListener): () => void {
    const off = this.on(channel, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Pushes a host event to whoever is listening, as the preload would. */
  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(strip(channel)) ?? []) listener(payload);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<BridgeEnvelope<unknown>> {
    const key = strip(channel);
    try {
      const handler = this.handlers[key];
      if (!handler) {
        // Cosmetic channels exist to show or hide a desktop surface — a plugin
        // view, a window control, a menu. The phone has none of those surfaces,
        // so closing them is a no-op, not a failure the user should see.
        if (isCosmeticChannel(key)) return { ok: true, data: { ok: true } };
        return {
          ok: false,
          error: { code: "bridge/unavailable", message: `the phone host does not implement ${key} yet` },
        };
      }
      return { ok: true, data: await handler(...args) };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "bridge/failed",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }
  }

  /**
   * The local host, wearing the client interface the schedule runner speaks.
   *
   * The runner was written against RACP's HTTP surface so it could drive either
   * host; on the phone those two routes are the bridge's own channels, and this
   * adapter is the whole translation between them.
   */
  private localClient(): HostClient {
    const call = async (channel: string, input?: unknown): Promise<Record<string, unknown>> => {
      const answer = await this.invoke(`pi-desktop/${channel}`, input);
      if (!answer.ok) throw new Error(answer.error.message);
      return (answer.data ?? {}) as Record<string, unknown>;
    };
    return {
      call: async (path, init) => {
        if (path === "/v1/sessions" && init?.method === "POST") {
          const body = init.body as { title?: string } | undefined;
          return (await call("session/create", { title: body?.title })) as never;
        }
        const turns = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
        if (turns && init?.method === "POST") {
          const body = init.body as { input?: { text?: string } } | undefined;
          await call("agent/prompt", {
            sessionId: decodeURIComponent(turns[1]!),
            content: body?.input?.text ?? "",
          });
          return {} as never;
        }
        throw new Error(`the phone host has no route for ${path}`);
      },
      stream: () => () => {},
    };
  }

  private readonly handlers: Record<string, (...args: unknown[]) => unknown> = {
    "app/getVersion": () => ({
      name: "QianNing Agent",
      version: this.env.version,
      protocolVersion: PROTOCOL_VERSION,
      platform: this.env.platform,
      arch: "arm64",
    }),

    "app/health": () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, version: this.env.version, uptimeMs: 0 }),

    "settings/get": () => {
      const active = this.providers.active();
      return {
        ...this.settings,
        defaultMode: "agent",
        theme: (this.settings.theme as string) ?? "system",
        // The composer resolves its model from these two; without them it shows
        // an empty model pill even though a service exists.
        defaultProviderId: active?.id ?? "",
        defaultModelId: active?.defaultModelId ?? "",
      };
    },

    "settings/set": (input) => {
      const patch = (input ?? {}) as Record<string, unknown> & {
        defaultProviderId?: string;
        defaultModelId?: string;
      };
      if (patch.defaultProviderId) this.providers.setActive(patch.defaultProviderId);
      if (patch.defaultProviderId && patch.defaultModelId) {
        this.providers.update({ id: patch.defaultProviderId, defaultModelId: patch.defaultModelId });
      }
      // Keep every other setting the page saves. Dropping them made the phone
      // forget the theme, the language and the permission mode on reload.
      const { defaultProviderId: _provider, defaultModelId: _model, ...rest } = patch;
      Object.assign(this.settings, rest);
      this.env.store.writeValue("qn.local.settings", JSON.stringify(this.settings));
      this.applyPermissionMode();
      const active = this.providers.active();
      return {
        ...this.settings,
        defaultMode: "agent",
        theme: (this.settings.theme as string) ?? "system",
        defaultProviderId: active?.id ?? "",
        defaultModelId: active?.defaultModelId ?? "",
      };
    },

    "tool/resolvePermission": (input) => {
      const request = (input ?? {}) as { requestId?: string; decision?: string };
      const decision = request.decision;
      if (decision !== "allow-once" && decision !== "allow-session" && decision !== "deny") {
        throw new Error("unknown permission decision");
      }
      const resolved = this.host?.resolvePermission?.(String(request.requestId ?? ""), decision);
      return { ok: resolved === true };
    },

    /*
     * Usage statistics. The desktop reads a turn ledger; the phone folds its own
     * transcripts, where every assistant message already carries the token
     * counts pi reported for that turn.
     */
    "stats/getTokenUsageHistory": (query?: unknown) =>
      tokenUsageHistory(this.usageTurns(), (query ?? {}) as Record<string, never>),

    "stats/getUsageBreakdown": (query?: unknown) =>
      usageBreakdown(this.usageTurns(), (query ?? {}) as Record<string, never>),

    "stats/getModelPricing": () => ({ models: this.readPricing() }),

    "stats/updateModelPricing": (row?: unknown) => {
      const next = row as ModelPricingRow;
      if (!next || typeof next.modelId !== "string" || !next.modelId) {
        throw new Error("a pricing row needs a model id");
      }
      const rows = this.readPricing().filter((entry) => entry.modelId !== next.modelId);
      rows.push(next);
      this.writePricing(rows);
      return { models: rows };
    },

    "stats/deleteModelPricing": (modelId?: unknown) => {
      const id = String(modelId ?? "");
      const rows = this.readPricing().filter((entry) => entry.modelId !== id);
      this.writePricing(rows);
      return { models: rows };
    },

    /*
     * Paired computers. On a phone the remote-access page is the *client* side:
     * these computers are desktops this phone drives, not devices dialing in.
     */
    "remoteHost/list": () => ({
      supported: hasRemoteHost(),
      hosts: listComputers().map((computer) => ({
        hostKey: computer.key,
        label: computer.label,
        url: computer.url,
        fingerprint: computer.fingerprint,
        connected: true,
      })),
    }),

    "remoteHost/pair": async (input?: unknown) => {
      const request = (input ?? {}) as { url?: unknown; token?: unknown; label?: unknown };
      const computer = await pairComputer({
        url: String(request.url ?? ""),
        token: String(request.token ?? ""),
        ...(typeof request.label === "string" ? { label: request.label } : {}),
      });
      return {
        host: {
          hostKey: computer.key,
          label: computer.label,
          url: computer.url,
          fingerprint: computer.fingerprint,
          connected: true,
        },
      };
    },

    "remoteHost/remove": (hostKey?: unknown) => {
      const removed = removeComputer(String(hostKey ?? ""));
      return { removed };
    },

    /** The paired computer's conversations — the proof the link is live. */
    "remote/sessions": async (hostKey?: unknown) => {
      const key = String(hostKey ?? "");
      const computer = listComputers().find((entry) => entry.key === key);
      if (!computer) throw new Error("that computer is not paired");
      return { sessions: await fetchSessions(computer) };
    },

    /*
     * The media workbench. The phone calls the provider's images endpoint
     * directly and keeps the renders in its own files directory; the renderer
     * sees the same shapes it sees on the desktop.
     */
    "workbench/generate": (input?: unknown) => generateMedia((input ?? {}) as never),
    "workbench/cancel": () => cancelWorkbench(),
    "workbench/library": () => mediaLibrary(),
    "workbench/library/remove": (input?: unknown) => {
      const record = (input ?? {}) as { ids?: unknown };
      const ids = Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === "string") : [];
      return removeFromLibrary(ids);
    },
    "workbench/library/clear": () => clearLibrary(),
    /** Saving outside the library is a desktop dialog; the render itself is already kept. */
    "workbench/saveAs": (input?: unknown) => ({
      saved: false,
      ...(input && typeof input === "object" ? {} : {}),
    }),
    "workbench/reveal": () => ({ revealed: false }),
    "workbench/library/reveal": () => ({ revealed: false }),
    "workbench/saveThumbnail": () => ({ saved: false }),

    /*
     * Scheduled tasks. The phone keeps an interval-plus-clock record and the
     * page speaks cadence and clock time; the mapping lives here so neither side
     * has to know the other's shape. Runs are recorded by the shared runner, so
     * a due pass and the page's own button write the same history.
     */
    /*
     * Skins live entirely in settings — the applied one is `activeSkinId`, the
     * user's own are `customSkins` — so applying and editing already work here;
     * only the file-shaped actions differ. Import reads a bundle the phone's own
     * picker chose; exporting to a desktop filesystem has no phone equivalent,
     * and the page says so instead of failing silently.
     */
    "skin/import": async () => {
      const files = await pickDeviceFiles();
      const first = files[0];
      if (!first) return null;
      const read = await readDeviceText(first.path);
      if (!read) throw new Error("读不到那个皮肤文件");
      const parsed = (() => {
        try {
          return JSON.parse(read) as { skin?: unknown } | unknown;
        } catch {
          return null;
        }
      })();
      const skin = (parsed as { skin?: unknown } | null)?.skin ?? parsed;
      if (!skin || typeof skin !== "object") throw new Error("这不是一个有效的皮肤文件");
      return { skin };
    },
    "skin/export": () => {
      throw new Error("手机不支持导出皮肤文件；桌面端可以");
    },
    "skin/importAsset": () => {
      throw new Error("手机暂不支持皮肤背景图，先用纯色皮肤");
    },
    "skin/deleteAsset": () => ({ ok: true }),

    /*
     * SSH machines. The plugin owns the sockets and the credentials; these
     * channels are the only thing the renderer sees, which keeps a password out
     * of the page entirely — it can write one, never read one back.
     */
    "ssh/profiles": async () => ({
      supported: hasSsh(),
      profiles: (await listSshProfiles()).map((profile) => ({
        ...profile,
        connected: isConnected(profile.id),
      })),
    }),

    "ssh/save": async (input?: unknown) => {
      const request = (input ?? {}) as Record<string, unknown>;
      const profile = await saveSshProfile({
        ...(typeof request.id === "string" ? { id: request.id } : {}),
        name: String(request.name ?? ""),
        host: String(request.host ?? ""),
        port: Number(request.port) || 22,
        user: String(request.user ?? ""),
        auth: request.auth === "key" ? "key" : "password",
        ...(typeof request.password === "string" ? { password: request.password } : {}),
        ...(typeof request.privateKey === "string" ? { privateKey: request.privateKey } : {}),
        ...(typeof request.passphrase === "string" ? { passphrase: request.passphrase } : {}),
      });
      return { profile };
    },

    "ssh/delete": async (id?: unknown) => {
      await deleteSshProfile(String(id ?? ""));
      return { ok: true };
    },

    "ssh/probe": async (id?: unknown) => probeSsh(String(id ?? "")),

    "ssh/connect": async (id?: unknown) => {
      const key = String(id ?? "");
      const sessionId = await ensureSsh(key);
      const profile = (await listSshProfiles()).find((entry) => entry.id === key);
      return { sessionId, fingerprint: profile?.fingerprint ?? "" };
    },

    "ssh/disconnect": async (id?: unknown) => {
      await disconnectSsh(String(id ?? ""));
      return { ok: true };
    },

    "ssh/run": async (input?: unknown) => {
      const request = (input ?? {}) as { id?: unknown; command?: unknown; timeoutMs?: unknown };
      const command = String(request.command ?? "");
      if (!command.trim()) throw new Error("no command");
      const timeout = Number(request.timeoutMs);
      return runSsh(
        String(request.id ?? ""),
        command,
        Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
      );
    },

    "scheduled/list": () => ({ tasks: loadSchedules().map(toScheduledTask) }),

    "scheduled/create": (input?: unknown) => {
      const request = (input ?? {}) as {
        title?: unknown;
        prompt?: unknown;
        cadence?: unknown;
        enabled?: unknown;
        schedule?: { hour?: unknown; minute?: unknown; weekdays?: unknown; weekday?: unknown };
      };
      const cadence = cadenceOf(request.cadence);
      const hour = clampInt(request.schedule?.hour, 0, 23, 9);
      const minute = clampInt(request.schedule?.minute, 0, 59, 0);
      const weekdays = weekdaysOf(request.schedule);
      const created = createSchedule({
        title: typeof request.title === "string" && request.title.trim() ? request.title : "定时任务",
        prompt: typeof request.prompt === "string" ? request.prompt : "",
        minutes: minutesFor(cadence),
      });
      const saved = saveSchedule({
        ...created,
        cadence,
        hour,
        minute,
        ...(weekdays.length ? { weekdays } : {}),
        enabled: request.enabled === false ? false : true,
      });
      return { task: toScheduledTask(saved.find((entry) => entry.id === created.id) ?? created) };
    },

    "scheduled/update": (input?: unknown) => {
      const request = (input ?? {}) as Record<string, unknown>;
      const id = typeof request.id === "string" ? request.id : "";
      const current = loadSchedules().find((entry) => entry.id === id);
      if (!current) throw new Error("that task no longer exists");
      const scheduleInput = request.schedule as
        | { hour?: unknown; minute?: unknown; weekdays?: unknown; weekday?: unknown }
        | undefined;
      const cadence = request.cadence === undefined ? current.cadence : cadenceOf(request.cadence);
      const next: Schedule = {
        ...current,
        ...(typeof request.title === "string" ? { title: request.title } : {}),
        ...(typeof request.prompt === "string" ? { prompt: request.prompt } : {}),
        ...(typeof request.enabled === "boolean" ? { enabled: request.enabled } : {}),
        ...(cadence ? { cadence, minutes: minutesFor(cadence) } : {}),
        ...(scheduleInput
          ? {
              hour: clampInt(scheduleInput.hour, 0, 23, current.hour ?? 9),
              minute: clampInt(scheduleInput.minute, 0, 59, current.minute ?? 0),
              weekdays: weekdaysOf(scheduleInput),
            }
          : {}),
      };
      saveSchedule(next);
      return { task: toScheduledTask(next) };
    },

    "scheduled/delete": (id?: unknown) => {
      removeSchedule(String(id ?? ""));
      return { ok: true };
    },

    "scheduled/listRuns": () => ({ runs: loadRuns() }),

    /** Run it now and answer with the conversation it wrote into. */
    "scheduled/execute": async (id?: unknown) => {
      const schedule = loadSchedules().find((entry) => entry.id === String(id ?? ""));
      if (!schedule) throw new Error("that task no longer exists");
      const sessionId = await runScheduleNow({ client: this.localClient(), schedule });
      return { sessionId };
    },

    "scheduled/run": async (id?: unknown) => {
      const schedule = loadSchedules().find((entry) => entry.id === String(id ?? ""));
      if (!schedule) throw new Error("that task no longer exists");
      const sessionId = await runScheduleNow({ client: this.localClient(), schedule });
      return { sessionId, prompt: schedule.prompt, task: toScheduledTask(schedule) };
    },

    "session/list": () => ({
      sessions: this.env.store.listSessions().map((session) => ({
        id: session.id,
        title: session.title,
        projectPath: session.projectPath ?? null,
        messageCount: this.env.store.readMessages(session.id).length,
        ...readSessionConfig(this.env.store, session.id),
        updatedAt: session.updatedAt,
      })),
    }),

    "session/create": (input) => {
      const now = new Date(this.now()).toISOString();
      const request = (input ?? {}) as { title?: string; projectPath?: string };
      // A conversation started while a project is open belongs to it, the same
      // way a desktop session inherits the workspace it was created in.
      const projectPath = (request.projectPath ?? this.projects.activeFolder() ?? "").trim();
      const session = {
        id: `s_${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        title: request.title?.trim() || "新对话",
        createdAt: now,
        updatedAt: now,
        ...(projectPath ? { projectPath } : {}),
      };
      const config = updateSessionConfig(this.env.store, session.id, input);
      this.env.store.writeSession(session);
      this.env.store.writeMessages(session.id, []);
      return { session: { ...session, messageCount: 0, ...config } };
    },

    "session/delete": (input) => {
      const sessionId = sessionIdOf(input);
      if (!sessionId) throw new Error("sessionId is required");
      this.env.store.deleteSession(sessionId);
      return { deleted: true };
    },

    // The composer sets mode, model and reasoning per conversation. The phone
    // host runs one service at a time, so a chosen provider/model also becomes
    // the active one: there is no second runtime to switch between.
    "session/configure": (input, config) => {
      const sessionId = sessionIdOf(input);
      if (!sessionId) throw new Error("sessionId is required");
      const session = this.env.store.readSession(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);

      const patch = updateSessionConfig(this.env.store, sessionId, config);
      if (patch.providerId) this.providers.setActive(patch.providerId);
      if (patch.providerId && patch.modelId) {
        this.providers.update({ id: patch.providerId, defaultModelId: patch.modelId });
      }

      return {
        session: {
          ...session,
          ...patch,
          messageCount: this.env.store.readMessages(sessionId).length,
        },
      };
    },

    // The conversation view reads the whole session, not just its messages:
    // without this the app can list sessions but never open one.
    "session/get": (input) => {
      const sessionId = sessionIdOf(input);
      if (!sessionId) throw new Error("sessionId is required");
      const session = this.env.store.readSession(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const messages = this.env.store.readMessages(sessionId).map((message) => ({
        id: message.itemId,
        role: message.role,
        content: message.text,
        createdAt: message.createdAt,
        status: message.status,
      }));
      return {
        session: {
          id: session.id,
          title: session.title,
          messageCount: messages.length,
          ...readSessionConfig(this.env.store, sessionId),
          systemPrompt: session.systemPrompt ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages,
        },
      };
    },

    // The topbar's prompt dialog: one conversation may carry its own
    // instructions, appended to the phone's prompt for every turn after this.
    "session/setSystemPrompt": (input, systemPrompt) => {
      const sessionId = sessionIdOf(input);
      if (!sessionId) throw new Error("sessionId is required");
      const session = this.env.store.readSession(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const trimmed = (typeof systemPrompt === "string" ? systemPrompt : "").trim();
      this.env.store.writeSession({ ...session, systemPrompt: trimmed || undefined });
      // The host also drops its cached agent for this session, so the next turn
      // rebuilds its prompt instead of reusing the old one.
      this.env.host?.setSystemPrompt?.(sessionId, trimmed || null);
      const updated = this.env.store.readSession(sessionId) ?? session;
      return {
        session: {
          ...updated,
          messageCount: this.env.store.readMessages(sessionId).length,
        },
      };
    },

    // Phone projects are folders in app storage, not disks to point at. The
    // sidebar asks for the same shapes it asks a desktop for.
    "project/list": () => ({ projects: this.projects.list().map(toProjectRecord) }),

    "project-group/list": () => ({ groups: this.projects.list().map(toProjectGroup) }),

    "project-group/create": (input) => {
      const request = (input ?? {}) as { name?: string; folders?: string[] };
      const folders = Array.isArray(request.folders) ? request.folders : [];
      return {
        group: toProjectGroup(this.projects.create({ name: request.name ?? "", folders })),
      };
    },

    "project-group/rename": (input) => {
      const request = (input ?? {}) as { groupId?: string; name?: string };
      if (!request.groupId) throw new Error("groupId is required");
      return { group: toProjectGroup(this.projects.rename(request.groupId, request.name ?? "")) };
    },

    "project-group/update": (input) => {
      const request = (input ?? {}) as { groupId?: string; name?: string };
      if (!request.groupId) throw new Error("groupId is required");
      return { group: toProjectGroup(this.projects.rename(request.groupId, request.name ?? "")) };
    },

    // There is no folder picker on a phone; the app's own storage is the one
    // place its file tools can reach, so that is the folder offered.
    "project/pickFolders": () => ({ folders: ["手机存储"] }),

    "project/openFolder": (path) => {
      const opened = this.projects.open(typeof path === "string" ? path : "");
      return { ok: opened !== null, path: opened?.folder ?? "" };
    },

    "project/get": () => {
      const active = this.projects.active();
      return { workspace: active ? toWorkspace(active) : null };
    },

    // The renderer sends this one as a bare path, unlike its object-shaped
    // neighbours; accept either so activating a project does not silently fail.
    "project/set": (input) => {
      const path = typeof input === "string" ? input : ((input ?? {}) as { path?: string }).path ?? "";
      const opened = this.projects.open(path);
      return { workspace: opened ? toWorkspace(opened) : null };
    },

    "project/memory/get": (input) => {
      const request = (input ?? {}) as { projectPath?: string };
      return { memory: this.projects.memory(request.projectPath ?? "") };
    },

    "project/memory/save": (input) => {
      const request = (input ?? {}) as {
        projectPath?: string;
        entries?: Array<{ id: string; title: string; content: string }>;
      };
      this.projects.saveMemory(request.projectPath ?? "", request.entries ?? []);
      return { memory: this.projects.memory(request.projectPath ?? "") };
    },

    "project-group/memory/get": (input) => {
      const request = (input ?? {}) as { groupId?: string };
      return { memory: this.projects.memory(request.groupId ?? "") };
    },

    "project-group/memory/save": (input) => {
      const request = (input ?? {}) as {
        groupId?: string;
        entries?: Array<{ id: string; title: string; content: string }>;
      };
      this.projects.saveMemory(request.groupId ?? "", request.entries ?? []);
      return { memory: this.projects.memory(request.groupId ?? "") };
    },

    "project/clear": () => {
      this.projects.setActive(null);
      return { ok: true };
    },

    "project/remove": (input) => {
      const request = (input ?? {}) as { path?: string };
      return { ok: this.projects.remove(request.path ?? "") };
    },

    "session/moveProject": (input) => {
      const request = (input ?? {}) as { sessionId?: string; projectPath?: string };
      const sessionId = request.sessionId ?? "";
      if (!sessionId) throw new Error("sessionId is required");
      const session = this.env.store.readSession(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const projectPath = (request.projectPath ?? "").trim();
      this.env.store.writeSession({
        ...session,
        projectPath: projectPath || undefined,
      });
      return { ok: true };
    },

    "session/open": (input) => {
      const sessionId = sessionIdOf(input);
      const session = sessionId ? this.env.store.readSession(sessionId) : null;
      return { session: session ? { id: session.id, title: session.title } : null };
    },

    "session/rename": (input) => {
      const request = (input ?? {}) as { id?: string; sessionId?: string; title?: string };
      request.sessionId = sessionIdOf(input);
      if (!request.sessionId) throw new Error("sessionId is required");
      const session = this.env.store.readSession(request.sessionId);
      if (!session) throw new Error(`unknown session ${request.sessionId}`);
      const renamed = {
        ...session,
        title: (request.title ?? "").trim() || session.title,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.env.store.writeSession(renamed);
      return { session: { ...renamed, messageCount: this.env.store.readMessages(renamed.id).length } };
    },

    "session/history": (input) => {
      const sessionId = sessionIdOf(input);
      if (!sessionId) throw new Error("sessionId is required");
      return {
        messages: this.env.store.readMessages(sessionId).map((message) => ({
          itemId: message.itemId,
          role: message.role,
          text: message.text,
          status: message.status,
          createdAt: message.createdAt,
        })),
      };
    },

    "providers/list": () => ({ providers: this.providers.list().map(toPublic) }),

    "providers/create": (input) => {
      const request = (input ?? {}) as {
        name?: string;
        baseUrl?: string;
        secretValue?: string;
        apiStyle?: string;
        models?: Array<{ id: string }>;
        defaultModelId?: string;
      };
      const provider = this.providers.create({
        name: request.name,
        baseUrl: request.baseUrl,
        apiKey: request.secretValue ?? "",
        apiStyle: request.apiStyle,
        models: request.models,
        defaultModelId: request.defaultModelId,
      });
      this.attachHost(provider);
      return { provider: toPublic(provider) };
    },

    "providers/update": (input) => {
      const request = (input ?? {}) as {
        id: string;
        name?: string;
        baseUrl?: string;
        apiStyle?: string;
        models?: Array<{ id: string }>;
        defaultModelId?: string;
      };
      const provider = this.providers.update(request);
      return { provider: provider ? toPublic(provider) : null };
    },

    "providers/setSecret": (input) => {
      const request = (input ?? {}) as { id: string; secretValue?: string };
      const provider = this.providers.setSecret(request.id, request.secretValue);
      if (provider) this.attachHost(provider);
      return { provider: provider ? toPublic(provider) : null };
    },

    "providers/delete": (input) => {
      const id = typeof input === "string" ? input : ((input as { id?: string } | undefined)?.id ?? "");
      this.providers.remove(id);
      return { ok: true };
    },

    "providers/reorder": () => ({ ok: true }),

    // The settings page asks this before a provider exists (the setup form) and
    // again after it is saved. Both shapes are supported here.
    "providers/listModels": async (input) => {
      const request = (input ?? {}) as {
        providerId?: string;
        baseUrl?: string;
        apiKey?: string;
        apiStyle?: string;
        source?: "cache" | "refresh";
      };
      const stored = request.providerId ? this.providers.get(request.providerId) : null;
      // Bootstrap requests local cache before publishing ready. Never discover
      // remote models here: an offline service must not hold the shell hostage.
      if (request.source === "cache") {
        // The service's last answer, not just the ids the user typed. This is
        // what lets the page paint a full list before any network call.
        const known = stored ? this.providers.knownModels(stored.id) : [];
        return {
          source: "cache",
          models:
            known.length > 0
              ? known
              : (stored?.models ?? []).map((id) => ({
                  modelId: id,
                  displayName: id,
                  providerId: stored?.id ?? "",
                  capabilities: ["text" as const],
                  source: "discovered" as const,
                })),
        };
      }
      // A service with a stored catalogue answers from it and refreshes behind
      // the page. The sheet used to await the network, sit on "连接中", and then
      // report a timeout — a minute of waiting for a list that was already on
      // disk. The refresh still runs, but it can no longer hold the page.
      const known = stored ? this.providers.knownModels(stored.id) : [];
      if (stored && known.length > 0) {
        const refresh = listModels({
          baseUrl: request.baseUrl ?? stored.baseUrl,
          apiKey: request.apiKey ?? stored.apiKey,
          apiStyle: request.apiStyle ?? stored.apiStyle,
          provider: stored,
        })
          .then((answer) => {
            if (answer.source === "remote" && answer.models.length > 0) {
              this.providers.rememberModels(stored.id, answer.models);
            }
            return answer;
          })
          .catch(() => null);
        // Give a healthy service enough time to answer, and never more.
        const fresh = await Promise.race([
          refresh,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
        ]);
        if (fresh && fresh.source === "remote" && fresh.models.length > 0) {
          return { source: "remote", models: fresh.models };
        }
        return { source: "cache", models: known, refreshing: true };
      }
      // The live branch must carry the wire style: a provider whose address is
      // Anthropic-style or Google-style cannot be probed with the OpenAI
      // `/models` + bearer rule. The stored provider wins over an empty form
      // field, because the form has no style until the user picks one.
      const answer = await listModels({
        baseUrl: request.baseUrl ?? stored?.baseUrl,
        apiKey: request.apiKey ?? stored?.apiKey,
        apiStyle: request.apiStyle ?? stored?.apiStyle,
        provider: stored,
      });
      // Keep the answer, so the next visit is instant even offline. Only a real
      // remote list is worth remembering; a fallback answer is not a catalogue.
      if (stored && answer.source === "remote" && answer.models.length > 0) {
        this.providers.rememberModels(stored.id, answer.models);
      }
      return answer;
    },

    "providers/testConnection": async (input) => {
      const id = typeof input === "string" ? input : ((input as { id?: string } | undefined)?.id ?? "");
      const provider = this.providers.get(id);
      if (!provider) return { ok: false, error: "unknown provider" };
      const probe = await listModels({ provider });
      return probe.error ? { ok: false, error: probe.error } : { ok: true, modelCount: probe.models.length };
    },

    "providers/modelCatalogStatus": () => ({ ready: true, updatedAt: null }),

    // Skills, MCP servers and subagents are host-side catalogues the phone does
    // not carry: the bundled skills are baked into the runtime, and there is no
    // process to spawn an MCP server. The pages still open and say so, instead of
    // failing with "does not implement".
    // The first-party skills ship inside the app, so the list is real: it is the
    // same set the system prompt advertises, not a placeholder.
    // The bundled skills are part of the product, not a shelf the reader manages:
    // they stay available to the runtime (the `skill` tool still reads them) but
    // the phone's settings page lists none of them.
    "skill/list": () => ({ skills: [] }),
    "skill/catalog": () => ({ skills: [] }),
    "skill/read": (input) => {
      const request = (input ?? {}) as { id?: string };
      const found = findBundledSkill(String(request.id ?? ""));
      return found
        ? { skill: { id: found.id, name: found.name }, body: found.body }
        : { skill: null };
    },
    "mcp/list": () => ({ servers: [], statuses: [] }),
    "subagent/list": () => ({ subagents: [] }),
    "subagent/catalog": () => ({ subagents: [], builtins: [] }),
    "subagent/read": () => ({ subagent: null }),

    // The per-conversation prompt shelf. Desktop keeps it in SQLite; the phone
    // keeps the same records in local storage and answers the same shape.
    "promptPreset/list": () => ({ presets: listPresets() }),
    "promptPreset/save": (input) => {
      const request = (input ?? {}) as { name?: string; text?: string };
      const text = typeof request.text === "string" ? request.text : "";
      if (!text.trim()) {
        return { ok: false, error: { code: "INVALID_PARAMS", message: "text required" } };
      }
      const preset = savePreset(typeof request.name === "string" ? request.name : "", text);
      return { preset };
    },
    "promptPreset/delete": (input) => {
      const request = (input ?? {}) as { id?: string };
      return { ok: deletePreset(String(request.id ?? "")) };
    },

    "secrets/has": (input) => {
      const ref = String(input ?? "");
      const provider = this.providers.list().find((row) => ref.includes(row.id));
      return { has: Boolean(provider?.apiKey) };
    },
    // The phone ships without an updater; saying so is the honest answer, and
    // the interface hides the update row when the mode is manual.
    "updates/getState": () => ({
      mode: "manual",
      preference: "manual",
      defaultPreference: "manual",
      automaticSupported: false,
      status: "idle",
      currentVersion: this.env.version,
    }),

    // Onboarding is a desktop first-run flow; the phone has its own.
    "app/getOnboarding": () => ({ showChecklist: false, steps: [] }),

    "composer/commands": () => ({ commands: [] }),

    /*
     * Attaching a file on the phone: the system picker copies the document into
     * app storage and hands back its path, which is then the chip's path and
     * what the agent reads. The token keeps the pick out of the page's memory
     * until the composer imports it.
     */
    "composer/pickFiles": async () => {
      const files = await pickDeviceFiles();
      if (files.length === 0) return { token: null, canceled: true };
      const token = `picked-${Date.now()}-${this.picked.size}`;
      this.picked.set(token, files);
      return { token };
    },

    "composer/importFiles": (input) => {
      const request = (input ?? {}) as { token?: string };
      const files = (request.token && this.picked.get(request.token)) || [];
      if (request.token) this.picked.delete(request.token);
      return {
        files: files.map((file) => ({
          path: file.path,
          name: file.name,
          kind: file.mimeType?.startsWith("image/") ? "image" : "file",
          mimeType: file.mimeType ?? "application/octet-stream",
          size: file.size,
        })),
      };
    },

    "fs/readImageDataUrl": async (input) => {
      const request = (input ?? {}) as { ref?: string; mimeType?: string };
      return readDeviceDataUrl(request.ref ?? "", request.mimeType);
    },

    "notification/setViewingSession": () => null,

    "plugin/list": () => ({ plugins: [] }),
    "plugin/themes": () => [],
    "plugin/views": () => [],
    "plans/pending": () => ({ plans: [] }),
    /*
     * The notification centre reads the phone's own ledger: every finished or
     * failed background task already writes one, so the page has something real
     * to show instead of an empty list.
     */
    "notification/list": () => ({
      notifications: loadNotices().map((notice) => ({
        id: notice.id,
        kind: /失败|failed|error/i.test(notice.title) ? "task.failed" : "task.completed",
        sessionId: notice.sessionId ?? "",
        sessionTitle: notice.title,
        turnId: notice.id,
        createdAt: new Date(notice.at).toISOString(),
        readAt: notice.read ? new Date(notice.at).toISOString() : null,
      })),
      unreadCount: unreadNotices(),
    }),
    "notification/markRead": (input?: unknown) => {
      const id = (input as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") markRead(id);
      return { ok: true };
    },
    "notification/markAllRead": () => {
      markAllRead();
      return { ok: true };
    },
    "notification/clear": () => {
      markAllRead();
      return { ok: true };
    },

    "agent/prompt": async (input) => {
      const request = input as { sessionId?: string; content?: string } | undefined;
      const sessionId = request?.sessionId;
      const content = request?.content;
      if (!sessionId) throw new Error("sessionId is required");
      if (typeof content !== "string" || !content.trim()) throw new Error("content is required");

      const host = this.host;
      if (!host) throw new Error("the phone host has no agent runtime attached");

      this.forward(sessionId, host);
      // The turn runs in the host; its events arrive through the bus, not the
      // reply. The reply only says the prompt was accepted.
      void host.send(sessionId, content).catch((cause: unknown) => {
        this.emit(AGENT_EVENT, {
          sessionId,
          ts: this.now(),
          event: {
            type: "error",
            error: { code: "AGENT_PROMPT_FAILED", message: cause instanceof Error ? cause.message : String(cause) },
          },
        });
      });
      return { accepted: true, turnId: "" };
    },

    "agent/compact": async (input) => {
      const sessionId = (input as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error("sessionId is required");
      const host = this.host;
      if (!host?.compact) throw new Error("the phone host cannot compact");
      return host.compact(sessionId);
    },

    "agent/stop": (input) => {
      const sessionId = (input as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error("sessionId is required");
      this.env.host?.interrupt?.(sessionId);
      return { stopped: true };
    },

    // Fire-and-forget chrome. The phone has no window menu, tray, or frameless
    // window to colour; acknowledging keeps the shell from treating them as
    // failures.
    "menu/rendererReady": () => null,
    "window/control": () => null,
    "window/setBackgroundColor": () => null,
    "window/setWorkPanelReservation": () => null,
    "tray/setSessionPreferences": () => null,
  };

  /**
   * Gives the agent host a service to run against.
   *
   * A phone starts with nothing configured: the user adds a provider inside the
   * shared settings page, which is the same page the desktop uses. Until that
   * happens `agent/prompt` refuses by name instead of failing as a network error.
   */
  private attachHost(provider: { baseUrl: string; apiKey: string; defaultModelId: string }): void {
    const config = {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: provider.defaultModelId,
    };
    if (!config.baseUrl || !config.apiKey || !config.modelId) return;
    if (!this.env.createHost) return;
    if (this.host) return;
    this.host = this.env.createHost(config);
    this.applyPermissionMode();
  }

  /** Settings are read once at start; a missing blob means defaults. */
  /** Every stored turn, with the model that produced it. */
  private usageTurns(): UsageTurn[] {
    return collectTurns(
      this.env.store.listSessions(),
      (sessionId) => this.env.store.readMessages(sessionId),
      (sessionId) => {
        const config = readSessionConfig(this.env.store, sessionId);
        return {
          providerId: config.providerId ?? this.providers.active()?.id ?? null,
          modelId: config.modelId ?? this.providers.active()?.defaultModelId ?? null,
        };
      },
    );
  }

  /** Per-model prices the user typed in, kept beside the rest of the phone's data. */
  private readPricing(): ModelPricingRow[] {
    try {
      const parsed: unknown = JSON.parse(this.env.store.readValue("qn.local.modelPricing") ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is ModelPricingRow => {
        if (!entry || typeof entry !== "object") return false;
        const row = entry as Partial<ModelPricingRow>;
        return typeof row.modelId === "string" && row.modelId.length > 0;
      });
    } catch {
      return [];
    }
  }

  private writePricing(rows: ModelPricingRow[]): void {
    this.env.store.writeValue("qn.local.modelPricing", JSON.stringify(rows));
  }

  private readSettings(): Record<string, unknown> {
    const raw = this.env.store.readValue("qn.local.settings");
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private applyPermissionMode(): void {
    const mode = this.settings.defaultPermissionMode;
    this.host?.setPermissionMode?.(
      mode === "ask" || mode === "auto" || mode === "accept-edits" ? mode : "accept-edits",
    );
  }

  private now(): number {
    return this.env.now ? this.env.now() : Date.now();
  }

  /** Starts translating one session's local events onto the desktop bus. */
  private forward(sessionId: string, host: AgentHostLike): void {
    if (this.forwarded.has(sessionId)) return;
    this.forwarded.set(
      sessionId,
      host.subscribe(sessionId, (event) => {
        for (const envelope of toDesktopEvents(event, this.now())) this.emit(AGENT_EVENT, envelope);
      }),
    );
  }
}

function strip(channel: string): string {
  return channel.startsWith(PREFIX) ? channel.slice(PREFIX.length) : channel;
}

/* ── scheduled tasks: one record, two vocabularies ──────────────────────── */

function cadenceOf(value: unknown): ScheduleCadence {
  return value === "manual" || value === "hourly" || value === "weekly" ? value : "daily";
}

/** The legacy interval a cadence maps to, for anything that still reads it. */
function minutesFor(cadence: ScheduleCadence): number {
  if (cadence === "hourly") return 60;
  if (cadence === "weekly") return 7 * 24 * 60;
  if (cadence === "manual") return 365 * 24 * 60;
  return 24 * 60;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Monday = 0 on the wire; duplicates and out-of-range days are dropped. */
function weekdaysOf(schedule: { weekdays?: unknown; weekday?: unknown } | undefined): number[] {
  const raw = schedule?.weekdays;
  const list = Array.isArray(raw)
    ? raw
    : typeof schedule?.weekday === "number"
      ? [schedule.weekday]
      : [];
  const seen = new Set<number>();
  for (const entry of list) {
    const day = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    seen.add(day);
  }
  return [...seen].sort((left, right) => left - right);
}

/** The phone's record, in the shape the desktop's scheduled page reads. */
function toScheduledTask(schedule: Schedule): Record<string, unknown> {
  const cadence: ScheduleCadence =
    schedule.cadence ??
    (schedule.minutes === 60
      ? "hourly"
      : schedule.minutes === 7 * 24 * 60
        ? "weekly"
        : schedule.minutes === 24 * 60
          ? "daily"
          : "manual");
  const hour = schedule.hour ?? 9;
  const minute = schedule.minute ?? 0;
  const next = dueAt(schedule);
  const iso = (value: number) => new Date(value).toISOString();
  return {
    id: schedule.id,
    title: schedule.title,
    prompt: schedule.prompt,
    cadence,
    mode: "agent",
    enabled: schedule.enabled,
    createdAt: iso(schedule.createdAt),
    updatedAt: iso(schedule.lastRunAt ?? schedule.createdAt),
    ...(schedule.lastRunAt ? { lastRunAt: iso(schedule.lastRunAt) } : {}),
    schedule: {
      hour,
      minute,
      weekday: schedule.weekdays?.[0] ?? 0,
      ...(schedule.weekdays?.length ? { weekdays: schedule.weekdays } : {}),
    },
    ...(Number.isFinite(next) ? { nextRunAt: iso(next) } : {}),
  };
}
