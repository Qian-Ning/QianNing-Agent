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
import type { Model, ProviderId, TranscriptContext } from "@earendil-works/pi-ai";
import { PRODUCT_IDENTITY_SYSTEM_PROMPT } from "@pi-desktop/shared";
import { createTools } from "./tools";
import { skillCatalogSection } from "./skills";
import { ProjectBook } from "./projects";
import type { AgentStore, StoredMessage, StoredSession } from "./store";
import type { HostEvent, ThinkingLevel } from "../lib/racp";

export type Attachment = { name: string; text: string };

export type ProviderConfig = {
  /** Any OpenAI-compatible endpoint: `https://api.deepseek.com/v1`. */
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** How hard the model should think, when it honours the parameter. */
  thinking?: ThinkingLevel;
};

export type LocalEvent = HostEvent;

/**
 * The phone's prompt is the desktop's product identity plus an honest account
 * of what a phone can do. The identity block is imported rather than copied, so
 * the two surfaces cannot describe the same product differently.
 */
const SYSTEM_PROMPT = [
  "You are QianNing Agent, running on the phone itself: the same product as the desktop app, with a phone's tools and the phone's own storage.",
  PRODUCT_IDENTITY_SYSTEM_PROMPT,
  [
    "Your tools are the complete list:",
    "list_files, read_file, write_file (inside this app's own storage) and fetch_url (the open web).",
    "There is no shell, no desktop filesystem, no browser control, and no way to install software.",
    "Never claim to have run a command, opened a file on the user's computer, or reached a local network address.",
    "When a request needs one of those, say plainly what is missing and what you can do with the tools you have.",
  ].join(" "),
  [
    "Answer in the user's language, and keep code, identifiers, file paths, and commands in English.",
    "Lead with the answer, then give the specifics it needs — numbers, names, steps, mechanisms, trade-offs — so the reader can act without asking again.",
    "Do not restate the question, do not pad, and do not close with an offer of further help when there is no concrete next step.",
  ].join(" "),
  [
    "Write long output to a file with write_file instead of printing something the reader would have to copy, and say where you wrote it.",
    "Read a file before you replace it: a file you have not read is a file you cannot safely rewrite.",
    "When something cannot be verified — a fetch failed, a file is missing — report what you actually observed. Never invent file contents, command output, or URLs.",
  ].join(" "),
].join("\n\n");

function buildModel(config: ProviderConfig, maxTokens = 8192): Model<"openai-completions"> {
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
    maxTokens,
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
    private provider: ProviderConfig,
    /** Tests supply a scripted stream and model; production uses the provider. */
    private readonly override?: {
      stream: StreamFn;
      model?: Model<"openai-completions">;
      /** Tests stub the title call so a scripted stream is not consumed twice. */
      summarize?: (userText: string) => Promise<string>;
    },
    /** Reader-level instructions and limits; empty means the built-in defaults. */
    private readonly prefs: { systemPrompt?: string; maxTokens?: number } = {},
  ) {
    this.projects = new ProjectBook(store);
  }

  listSessions(): StoredSession[] {
    return this.store.listSessions();
  }

  providerConfig(): ProviderConfig {
    return this.provider;
  }

  /** Rename keeps the id and the transcript; only the label moves. */
  renameSession(sessionId: string, title: string): StoredSession | null {
    const session = this.store.listSessions().find((entry) => entry.id === sessionId);
    if (!session) return null;
    const next: StoredSession = { ...session, title: title.trim().slice(0, 120) };
    this.store.writeSession(next);
    return next;
  }

  /**
   * A new provider means a new model and possibly a new endpoint, so the cached
   * agents (which hold a model) are dropped and rebuilt on next use.
   */
  setProvider(next: ProviderConfig): void {
    for (const session of this.running.values()) session.agent.abort();
    this.running.clear();
    this.provider = next;
  }

  /**
   * The models the endpoint advertises. This is the same list the desktop's
   * picker reads when the provider is OpenAI-compatible; a provider that does
   * not implement /models simply yields nothing and the current model stands.
   */
  async listModels(): Promise<string[]> {
    return probeModels(this.provider.baseUrl, this.provider.apiKey);
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
  async send(sessionId: string, text: string, attachments: readonly Attachment[] = []): Promise<void> {
    const session = this.ensureSession(sessionId);
    const turnId = newId("t");
    this.emit(session, { sessionId, turnId, kind: "turn.started", payload: {} });
    try {
      await session.agent.prompt(withAttachments(text, attachments));
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
      // A name is a convenience, never a precondition: it runs after the turn
      // has already been reported complete, and a failure is swallowed.
      void this.autoTitle(sessionId, text).catch(() => undefined);
    } catch (cause) {
      this.emit(session, {
        sessionId,
        turnId,
        kind: "turn.failed",
        payload: { message: cause instanceof Error ? cause.message : String(cause) },
      });
    }
  }

  /**
   * Names the session from its first prompt, the way the desktop does. Only an
   * untitled session is touched, so a manual name always wins.
   */
  private async autoTitle(sessionId: string, userText: string): Promise<void> {
    const stored = this.store.listSessions().find((entry) => entry.id === sessionId);
    if (!stored || stored.title.trim()) return;
    const title = cleanTitle(await this.summarize(userText));
    if (!title) return;
    const current = this.store.listSessions().find((entry) => entry.id === sessionId);
    // Another writer may have named it while the summary was in flight.
    if (!current || current.title.trim()) return;
    this.renameSession(sessionId, title);
  }

  private async summarize(userText: string): Promise<string> {
    if (this.override?.summarize) return this.override.summarize(userText);
    const model = this.override?.model ?? buildModel(this.provider, this.prefs.maxTokens);
    const stream = streamSimple(
      model,
      {
        // The completions adapter takes no system prompt, so the instruction
        // rides with the prompt — the same text either way.
        messages: [
          {
            role: "user",
            content: TITLE_PROMPT + "\n\nUser Prompt:\n" + userText.slice(0, 1000),
            timestamp: Date.now(),
          },
        ],
      } as unknown as TranscriptContext,
      { apiKey: this.provider.apiKey, maxTokens: 64 },
    );
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
    }
    return text;
  }

  /**
   * Replaces the instructions for one conversation. The runtime caches an
   * agent per session, so the cached one is dropped; the next turn builds a
   * new agent from the stored prompt.
   */
  setSystemPrompt(sessionId: string, systemPrompt: string | null): void {
    const session = this.store.readSession(sessionId);
    if (!session) return;
    const trimmed = (systemPrompt ?? "").trim();
    const next = { ...session, systemPrompt: trimmed || undefined };
    this.store.writeSession(next);
    this.running.delete(sessionId);
  }

  interrupt(sessionId: string): void {
    this.running.get(sessionId)?.agent.abort();
  }

  /** The open phone project scopes every file tool; null means storage root. */
  private readonly projects: ProjectBook;

  private ensureSession(sessionId: string): RunningSession {
    const existing = this.running.get(sessionId);
    if (existing) return existing;

    const stored = this.store.readMessages(sessionId);
    const sessionPrompt = this.store.readSession(sessionId)?.systemPrompt;
    const agent = new Agent({
      initialState: {
        model: this.override?.model ?? buildModel(this.provider, this.prefs.maxTokens),
        systemPrompt: withExtraInstructions(
          withExtraInstructions(SYSTEM_PROMPT, skillCatalogSection()),
          sessionPrompt ?? this.prefs.systemPrompt,
        ),
        tools: createTools(this.store, () => this.projects.activeFolder()),
        messages: this.readTranscript(sessionId),
      },
      streamFn:
        this.override?.stream ??
        ((model, context, options) =>
          streamSimple(model as Model<"openai-completions">, context, {
            ...options,
            apiKey: this.provider.apiKey,
            // "off" means do not send the parameter at all, so a provider that
            // rejects unknown fields keeps working.
            ...(this.provider.thinking && this.provider.thinking !== "off"
              ? { reasoning: this.provider.thinking }
              : {}),
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

/**
 * A turn carries its files as text, fenced and labelled, because the phone has
 * no upload channel to the model — the same shape the desktop uses when it
 * inlines an attachment into the prompt.
 */
function withAttachments(text: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments.map(
    (file) => "### " + file.name + "\n```\n" + file.text.replace(/\n$/, "") + "\n```",
  );
  return blocks.join("\n\n") + "\n\n" + text;
}

/**
 * The model list an OpenAI-compatible endpoint advertises.
 *
 * Same URL rule the desktop uses for discovery (`{base}/models`), so a provider
 * that works in Settings works here without anyone retyping a path.
 */
export async function probeModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("a base URL is required");
  const response = await fetch(base + "/models", {
    headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
  });
  if (!response.ok) throw new Error("the endpoint returned " + response.status);
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0)
    .sort();
}

/** The desktop's own title instructions; the phone should name a session alike. */
const TITLE_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  "3. Keep it under 25 characters (or 4-7 words).\n" +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").";

/** Strip the wrappers a model likes to add to a title. */
export function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"'\u201c\u201d\u300c\u300d]+|[`"'\u201c\u201d\u300c\u300d]+$/g, "")
    .replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.。!！?？]+$/, "")
    .trim()
    .slice(0, 80);
}

/** The built-in rules stay; the reader's additions come after them. */
function withExtraInstructions(base: string, extra: string | undefined): string {
  const addition = extra?.trim();
  return addition ? base + "\n\n" + addition : base;
}
