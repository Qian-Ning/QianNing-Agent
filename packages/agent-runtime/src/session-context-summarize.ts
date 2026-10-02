import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export const SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT =
  "You write a handoff summary of an ongoing conversation so the user can continue it in a brand-new session without losing context.\n" +
  "Rules:\n" +
  "1. Write in the primary language of the conversation (e.g. Chinese for a Chinese conversation, English for an English one).\n" +
  "2. Capture the user's goal, what was done or decided, the current state, and the clear next step.\n" +
  "3. Keep the concrete specifics the next session needs: file paths, names, decisions, constraints, numbers, exact wording.\n" +
  "4. Be a dense, readable brief in short paragraphs or bullet points. No preamble, no meta commentary, no closing question.\n" +
  "5. Write it as context to carry forward, not as a message addressed to anyone.";

/** Hard ceiling on the transcript handed to the model, independent of the caller. */
const CONTEXT_INPUT_MAX_CHARS = 32000;

export type SessionContextSummarizeStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type SessionContextSummarizeOptions = {
  signal?: AbortSignal;
  stream?: SessionContextSummarizeStream;
  sessionId?: string;
};

export function sessionContextSummarizeContext(transcript: string): Context {
  const cleanTranscript = transcript.trim().slice(0, CONTEXT_INPUT_MAX_CHARS);
  return {
    systemPrompt: SESSION_CONTEXT_SUMMARIZE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Conversation to summarize:\n\n${cleanTranscript}`,
        timestamp: Date.now(),
      },
    ],
  };
}

export function cleanSummarizedContext(raw: string): string {
  let text = raw.trim();
  // Drop an outer markdown code fence if the model wrapped the whole summary.
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  return text;
}

/**
 * Run a one-shot completion that condenses a full transcript into a carry-
 * forward brief for a fresh session. Reuses the shared one-shot path; no
 * durable session history or tools are implied — the caller supplies the text.
 */
export async function summarizeSessionContext(
  provider: RuntimeProviderConfig,
  transcript: string,
  thinkingLevel: ThinkingLevel = "off",
  options: SessionContextSummarizeOptions = {},
): Promise<string> {
  const result = await completeOneShot(
    provider,
    sessionContextSummarizeContext(transcript),
    thinkingLevel,
    {
      signal: options.signal,
      stream: options.stream,
      sessionId: options.sessionId,
      emptyErrorCode: "CONTEXT_SUMMARIZATION_EMPTY",
      emptyErrorMessage: "The model returned an empty context summary.",
    },
  );
  return cleanSummarizedContext(result.text);
}
