import type { AgentStore } from "../agent/store";

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

export type BridgeEnvironment = {
  store: AgentStore;
  platform: string;
  version: string;
};

export type BridgeListener = (payload: unknown) => void;

const PREFIX = "pi-desktop/";

export class PhoneBridge {
  private readonly listeners = new Map<string, Set<BridgeListener>>();

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

    // Fire-and-forget chrome. The phone has no window menu, tray, or frameless
    // window to colour; acknowledging keeps the shell from treating them as
    // failures.
    "menu/rendererReady": () => null,
    "window/control": () => null,
    "window/setBackgroundColor": () => null,
    "window/setWorkPanelReservation": () => null,
    "tray/setSessionPreferences": () => null,
  };
}

function strip(channel: string): string {
  return channel.startsWith(PREFIX) ? channel.slice(PREFIX.length) : channel;
}
