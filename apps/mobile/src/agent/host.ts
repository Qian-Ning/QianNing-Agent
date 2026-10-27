/**
 * The agent that runs on the phone.
 *
 * It is the same loop the desktop runs — `@earendil-works/pi-agent-core` — with
 * a different set of tools and its own storage. Nothing here knows about RACP or
 * about a desktop; the events it publishes are shaped like the Host's so one UI
 * can render either.
 */

import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model, ProviderId } from "@earendil-works/pi-ai";
import { createTools } from "./tools";
import type { AgentStore, StoredMessage, StoredSession } from "./store";
import type { HostEvent } from "../lib/racp";

export type ProviderConfig = {
  /** Any OpenAI-compatible endpoint: `https://api.deepseek.com/v1`. */
  baseUrl: string;
  apiKey: string;
  modelId: string;
};

export type LocalEvent = HostEvent;

const SYSTEM_PROMPT = [
  "You are QianNing Agent, running on the phone itself.",
  "You have no shell and no desktop filesystem. Your tools are the complete list:",
  "list_files, read_file, write_file (the app's own storage) and fetch_url (the web).",
  "Never claim to have run a command or opened a desktop file. Say what you cannot do.",
  "Answer in the user's language.",
].join("\n");

function buildModel(config: ProviderConfig): Model<"openai-completions"> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "openai" as ProviderId,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8192,
  } as Model<"openai-completions">;
}

function newId(prefix: string): string {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function nowIso(): string {
  return new Date().toISOString();
}

type Listener = (event: LocalEvent) => void;

type RunningSession = {
  sessionId: string;
  agent: Agent;
  listeners: Set<Listener>;
  messages: StoredMessage[];
  /** The assistant message currently streaming; start/update/end share its id. */
  streamingId: string | null;
  /** The user message being appended this turn; start and end share its id. */
  promptId: string | null;
};

export class LocalAgentHost {
  private running = new Map<string, RunningSession>();

  constructor(
    private readonly store: AgentStore,
    private readonly provider: ProviderConfig,
    /** Tests supply a scripted stream and model; production uses the provider. */
    private readonly override?: { stream: StreamFn; model?: Model<"openai-completions"> },
  ) {}

  listSessions(): StoredSession[] {
    return this.store.listSessions();
  }

  createSession(title = ""): StoredSession {
    const stamp = nowIso();
    const session: StoredSession = {
      id: newId("s"),
      title: title.trim(),
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.store.writeSession(session);
    return session;
  }

  deleteSession(sessionId: string): void {
    const running = this.running.get(sessionId);
    if (running) {
      running.agent.abort();
      this.running.delete(sessionId);
    }
    this.store.deleteSession(sessionId);
  }

  history(sessionId: string): StoredMessage[] {
    return this.store.readMessages(sessionId);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const session = this.ensureSession(sessionId);
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  /**
   * Runs one turn. Resolves when the loop is done; failures are published as
   * `turn.failed` rather than thrown, because the UI already knows how to show
   * an error row and a rejected promise would leave it spinning.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const session = this.ensureSession(sessionId);
    const turnId = newId("t");
    this.emit(session, { sessionId, turnId, kind: "turn.started", payload: {} });
    try {
      await session.agent.prompt(text);
      const last = session.agent.state.messages.at(-1);
      const failed = last && "stopReason" in last && last.stopReason === "error";
      if (failed) {
        this.emit(session, {
          sessionId,
          turnId,
          kind: "turn.failed",
          payload: { message: (last as { errorMessage?: string }).errorMessage ?? "the model request failed" },
        });
        return;
      }
      this.emit(session, { sessionId, turnId, kind: "turn.completed", payload: {} });
    } catch (cause) {
      this.emit(session, {
        sessionId,
        turnId,
        kind: "turn.failed",
        payload: { message: cause instanceof Error ? cause.message : String(cause) },
      });
    }
  }

  interrupt(sessionId: string): void {
    this.running.get(sessionId)?.agent.abort();
  }

  private ensureSession(sessionId: string): RunningSession {
    const existing = this.running.get(sessionId);
    if (existing) return existing;

    const stored = this.store.readMessages(sessionId);
    const agent = new Agent({
      initialState: {
        model: this.override?.model ?? buildModel(this.provider),
        systemPrompt: SYSTEM_PROMPT,
        tools: createTools(this.store),
        messages: this.readTranscript(sessionId),
      },
      streamFn:
        this.override?.stream ??
        ((model, context, options) =>
          streamSimple(model as Model<"openai-completions">, context, {
            ...options,
            apiKey: this.provider.apiKey,
          })),
      getApiKey: () => this.provider.apiKey,
    });

    const session: RunningSession = {
      sessionId,
      agent,
      listeners: new Set(),
      messages: stored,
      streamingId: null,
      promptId: null,
    };
    this.running.set(sessionId, session);

    agent.subscribe((event) => {
      this.handleAgentEvent(session, sessionId, event);
    });

    return session;
  }

  /**
   * The agent's own transcript, so a restart continues the conversation instead
   * of starting from an empty context while the screen still shows history.
   */
  private readTranscript(sessionId: string): AgentMessage[] {
    const raw = this.store.readValue("transcript:" + sessionId);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AgentMessage[]) : [];
    } catch {
      return [];
    }
  }

  private persistTranscript(sessionId: string, agent: Agent): void {
    try {
      this.store.writeValue("transcript:" + sessionId, JSON.stringify(agent.state.messages));
    } catch {
      // A transcript that cannot be serialised must not break the turn; the
      // rendered history is stored separately and stays intact.
    }
  }

  private handleAgentEvent(session: RunningSession, sessionId: string, event: unknown): void {
    const record = event as { type: string; message?: Record<string, unknown> };
    switch (record.type) {
      case "message_start": {
        const message = record.message ?? {};
        const role = String(message.role ?? "assistant");
        if (role !== "assistant" && role !== "user") return;
        const itemId =
          role === "user"
            ? (session.promptId ??= String(message.id ?? newId("m")))
            : String(message.id ?? newId("m"));
        if (role === "assistant") session.streamingId = itemId;
        const item = { ...this.toStored(message, role), itemId };
        this.upsert(session, item);
        this.emit(session, {
          sessionId,
          kind: "item.started",
          payload: { itemType: "message", itemId: item.itemId, event: { message } },
        });
        return;
      }
      case "message_update": {
        const update = event as {
          message?: Record<string, unknown>;
          assistantMessageEvent?: Record<string, unknown>;
        };
        const message = update.message ?? {};
        const itemId = session.streamingId ?? String(message.id ?? "");
        const delta = update.assistantMessageEvent ?? {};
        const textDelta = delta.type === "text_delta" && typeof delta.delta === "string" ? delta.delta : "";
        const thinkingDelta =
          delta.type === "thinking_delta" && typeof delta.delta === "string" ? delta.delta : "";
        if (!itemId || (!textDelta && !thinkingDelta)) return;
        this.emit(session, {
          sessionId,
          kind: "item.delta",
          payload: {
            itemType: "message",
            itemId,
            event: { deltaText: textDelta, deltaThinking: thinkingDelta },
          },
        });
        return;
      }
      case "message_end": {
        const message = record.message ?? {};
        const role = String(message.role ?? "assistant");
        if (role !== "assistant" && role !== "user") return;
        const itemId =
          role === "user"
            ? (session.promptId ?? String(message.id ?? newId("m")))
            : (session.streamingId ?? String(message.id ?? newId("m")));
        if (role === "user") session.promptId = null;
        else session.streamingId = null;
        const item = { ...this.toStored(message, role), itemId };
        this.upsert(session, item);
        this.emit(session, {
          sessionId,
          kind: "item.completed",
          payload: { itemType: "message", itemId: item.itemId, event: { message } },
        });
        this.persistTranscript(sessionId, session.agent);
        return;
      }
      case "tool_execution_start": {
        const call = event as { toolCallId?: string; toolName?: string; args?: unknown };
        const itemId = String(call.toolCallId ?? newId("tool"));
        this.upsert(session, {
          itemId,
          role: "tool",
          text: "",
          status: "running",
          createdAt: nowIso(),
          toolName: call.toolName ?? "tool",
          toolDetail: JSON.stringify(call.args ?? {}).slice(0, 400),
        });
        this.emit(session, {
          sessionId,
          kind: "item.started",
          payload: {
            itemType: "tool",
            itemId,
            tool: { name: call.toolName ?? "tool", input: call.args ?? {} },
          },
        });
        return;
      }
      case "tool_execution_end": {
        const call = event as {
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
          result?: { content?: { text?: string }[] };
        };
        const itemId = String(call.toolCallId ?? newId("tool"));
        const output = (call.result?.content ?? [])
          .map((block) => block.text ?? "")
          .join("\n")
          .slice(0, 600);
        this.upsert(session, {
          itemId,
          role: "tool",
          text: output,
          status: call.isError ? "failed" : "completed",
          createdAt: nowIso(),
          toolName: call.toolName ?? "tool",
          toolFailed: Boolean(call.isError),
        });
        this.emit(session, {
          sessionId,
          kind: "item.completed",
          payload: {
            itemType: "tool",
            itemId,
            status: call.isError ? "failed" : "completed",
            tool: { name: call.toolName ?? "tool", output },
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private toStored(message: Record<string, unknown>, role: string): StoredMessage {
    return {
      itemId: String(message.id ?? newId("m")),
      role,
      text: typeof message.content === "string" ? message.content : textOfBlocks(message.content),
      ...(typeof message.thinking === "string" && message.thinking ? { thinking: message.thinking } : {}),
      status: String(message.status ?? "complete"),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : nowIso(),
    };
  }

  private upsert(session: RunningSession, item: StoredMessage): void {
    const index = session.messages.findIndex((entry) => entry.itemId === item.itemId);
    const previous = session.messages[index];
    if (!previous) session.messages.push(item);
    else session.messages[index] = { ...previous, ...item };
    this.store.writeMessages(session.sessionId, session.messages);
  }

  private emit(session: RunningSession, event: LocalEvent): void {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the turn or the other listeners.
      }
    }
  }
}

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}
