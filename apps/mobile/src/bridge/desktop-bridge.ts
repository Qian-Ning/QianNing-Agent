import { PROTOCOL_VERSION } from "@pi-desktop/shared";
import type { AgentStore } from "../agent/store";
import { toDesktopEvents, type LocalEvent } from "./agent-events";
import {
  ProjectBook,
  toProjectGroup,
  toProjectRecord,
  toWorkspace,
} from "../agent/projects";
import { ProviderBook, listModels, toPublic } from "./providers";

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

export class PhoneBridge {
  private readonly listeners = new Map<string, Set<BridgeListener>>();
  /** Sessions whose local events are already being translated onto the bus. */
  private readonly forwarded = new Map<string, () => void>();
  /** Model services the user added on the phone. */
  private readonly providers: ProviderBook;

  private readonly env: BridgeEnvironment;

  private host?: AgentHostLike;
  private readonly projects: ProjectBook;

  constructor(env: BridgeEnvironment) {
    this.env = env;
    this.projects = new ProjectBook(env.store);
    this.host = env.host;
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
        defaultMode: "agent",
        theme: "system",
        // The composer resolves its model from these two; without them it shows
        // an empty model pill even though a service exists.
        defaultProviderId: active?.id ?? "",
        defaultModelId: active?.defaultModelId ?? "",
      };
    },

    "settings/set": (input) => {
      const patch = (input ?? {}) as { defaultProviderId?: string; defaultModelId?: string };
      if (patch.defaultProviderId) this.providers.setActive(patch.defaultProviderId);
      if (patch.defaultProviderId && patch.defaultModelId) {
        this.providers.update({ id: patch.defaultProviderId, defaultModelId: patch.defaultModelId });
      }
      const active = this.providers.active();
      return {
        defaultMode: "agent",
        theme: "system",
        defaultProviderId: active?.id ?? "",
        defaultModelId: active?.defaultModelId ?? "",
      };
    },

    "session/list": () => ({
      sessions: this.env.store.listSessions().map((session) => ({
        id: session.id,
        title: session.title,
        projectPath: session.projectPath ?? null,
        messageCount: this.env.store.readMessages(session.id).length,
        mode: "agent",
        thinkingLevel: "medium",
        permissionMode: "inherit",
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
      this.env.store.writeSession(session);
      this.env.store.writeMessages(session.id, []);
      return { session: { ...session, messageCount: 0, mode: "agent", thinkingLevel: "medium", permissionMode: "inherit" } };
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

      const patch = (config ?? {}) as {
        mode?: string;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: string;
      };
      this.env.store.writeValue(`qn.local.sessionConfig.${sessionId}`, JSON.stringify(patch));
      if (patch.providerId) this.providers.setActive(patch.providerId);
      if (patch.providerId && patch.modelId) {
        this.providers.update({ id: patch.providerId, defaultModelId: patch.modelId });
      }

      return {
        session: {
          ...session,
          mode: patch.mode ?? "agent",
          thinkingLevel: patch.thinkingLevel ?? "medium",
          providerId: patch.providerId,
          modelId: patch.modelId,
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
          mode: "agent",
          thinkingLevel: "medium",
          permissionMode: "inherit",
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
      const request = (input ?? {}) as { name?: string };
      return { group: toProjectGroup(this.projects.create({ name: request.name ?? "" })) };
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

    "project/set": (input) => {
      const request = (input ?? {}) as { path?: string };
      const opened = this.projects.open(request.path ?? "");
      return { workspace: opened ? toWorkspace(opened) : null };
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
      };
      const stored = request.providerId ? this.providers.get(request.providerId) : null;
      return listModels({ baseUrl: request.baseUrl, apiKey: request.apiKey, provider: stored });
    },

    "providers/testConnection": async (input) => {
      const id = typeof input === "string" ? input : ((input as { id?: string } | undefined)?.id ?? "");
      const provider = this.providers.get(id);
      if (!provider) return { ok: false, error: "unknown provider" };
      const probe = await listModels({ provider });
      return probe.error ? { ok: false, error: probe.error } : { ok: true, modelCount: probe.models.length };
    },

    "providers/modelCatalogStatus": () => ({ ready: true, updatedAt: null }),

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

    "notification/setViewingSession": () => null,

    "plugin/list": () => ({ plugins: [] }),
    "plugin/themes": () => [],
    "plugin/views": () => [],
    "plans/pending": () => ({ plans: [] }),
    "notification/list": () => ({ notifications: [], unreadCount: 0 }),

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
