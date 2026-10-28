import { LocalAgentHost, type ProviderConfig } from "./host";
import type { AgentStore } from "./store";

/**
 * One turn, no window.
 *
 * This is what a foreground Service runs when a scheduled task comes due with
 * the app closed (ADR 0338). It is deliberately the thinnest possible wrapper
 * around {@link LocalAgentHost}: same host, same store schema, same event
 * shapes. Nothing here may reimplement the loop.
 */
export type HeadlessJob = {
  provider: ProviderConfig;
  /** Existing session to continue, or omitted to start a new one. */
  sessionId?: string;
  title?: string;
  prompt: string;
};

export type HeadlessEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "event"; event: unknown }
  | { kind: "done"; ok: boolean; error?: string };

export class HeadlessRunner {
  private readonly host: LocalAgentHost;

  constructor(
    store: AgentStore,
    provider: ProviderConfig,
    /** Tests supply a scripted stream; the Service never passes this. */
    override?: ConstructorParameters<typeof LocalAgentHost>[2],
  ) {
    this.host = new LocalAgentHost(store, provider, override);
  }

  /** Runs the job to completion. Resolves with the session it ran in. */
  async run(job: HeadlessJob, emit: (event: HeadlessEvent) => void = () => {}): Promise<{ sessionId: string; ok: boolean; error?: string }> {
    const sessionId = job.sessionId ?? this.host.createSession(job.title ?? "").id;
    emit({ kind: "session", sessionId });

    let settled: (value: { ok: boolean; error?: string }) => void = () => {};
    const finished = new Promise<{ ok: boolean; error?: string }>((resolve) => (settled = resolve));

    const unsubscribe = this.host.subscribe(sessionId, (event) => {
      emit({ kind: "event", event });
      if (event.kind === "turn.completed") settled({ ok: true });
      if (event.kind === "turn.failed") {
        const payload = event.payload as { message?: string } | undefined;
        settled({ ok: false, error: payload?.message ?? "turn failed" });
      }
    });

    try {
      await this.host.send(sessionId, job.prompt);
      const result = await finished;
      emit({ kind: "done", ...result });
      return { sessionId, ...result };
    } finally {
      unsubscribe();
    }
  }
}

/** Parses the one-line JSON the Service hands to the runtime. */
export function parseJob(raw: string): HeadlessJob {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("job is not valid JSON");
  }
  const job = value as Partial<HeadlessJob>;
  if (typeof job.prompt !== "string" || !job.prompt.trim()) throw new Error("job.prompt is required");
  const provider = job.provider as Partial<ProviderConfig> | undefined;
  if (!provider || typeof provider.baseUrl !== "string" || typeof provider.apiKey !== "string") {
    throw new Error("job.provider.baseUrl and job.provider.apiKey are required");
  }
  if (typeof provider.modelId !== "string" || !provider.modelId) throw new Error("job.provider.modelId is required");
  return {
    provider: provider as ProviderConfig,
    sessionId: typeof job.sessionId === "string" ? job.sessionId : undefined,
    title: typeof job.title === "string" ? job.title : undefined,
    prompt: job.prompt,
  };
}
