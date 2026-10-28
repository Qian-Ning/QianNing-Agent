import type { AgentStore } from "../agent/store";
import { toDesktopEvents, type LocalEvent } from "./agent-events";

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
export type BridgeEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** What the bridge needs from the phone's agent host — nothing more. */
export type AgentHostLike = {
  send(sessionId: string, text: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: LocalEvent) => void): () => void;
  interrupt?(sessionId: string): void;
};

export type BridgeEnvironment = {
  store: AgentStore;
  platform: string;
  version: string;
  /** Absent until the agent channel is wired; prompt then refuses by name. */
  host?: AgentHostLike;
  now?: () => number;
};

export type BridgeListener = (payload: unknown) => void;

const PREFIX = "pi-desktop/";
const AGENT_EVENT = "agent/event/message";

export class PhoneBridge {
  private readonly listeners = new Map<string, Set<BridgeListener>>();
  /** Sessions whose local events are already being translated onto the bus. */
  private readonly forwarded = new Map<string, () => void>();

  constructor(private readonly env: BridgeEnvironment) {}

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
      return { ok: true, value: await handler(...args) };
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
      protocolVersion: 1,
      platform: this.env.platform,
      arch: "arm64",
    }),

    "app/health": () => ({ ok: true, protocolVersion: 1, version: this.env.version, uptimeMs: 0 }),

    "settings/get": () => ({
      // Only what the phone host can actually answer today. The renderer treats
      // missing optional settings as their defaults.
      defaultMode: "agent",
      theme: "system",
    }),

    "session/list": () => ({
      sessions: this.env.store.listSessions().map((session) => ({
        id: session.id,
        title: session.title,
        messageCount: this.env.store.readMessages(session.id).length,
        mode: "agent",
        thinkingLevel: "medium",
        permissionMode: "inherit",
        updatedAt: session.updatedAt,
      })),
    }),

    "session/history": (input) => {
      const sessionId = (input as { sessionId?: string } | undefined)?.sessionId;
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

    "providers/list": () => ({ providers: [] }),
    "project/list": () => ({ projects: [] }),
    "project/get": () => ({ workspace: null }),
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

      const host = this.env.host;
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
