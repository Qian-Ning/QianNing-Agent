import {
  draftFrom,
  type MessagingDraft,
  type MessagingPlatformRecord,
  type SupportedMessagingPlatform,
} from "./messaging-platforms";

/**
 * What the form held the last time it was saved.
 *
 * Turning a channel off deletes its settings section — that is the host's
 * contract, and it is what makes an off channel register nothing. The cost is
 * that turning it back on used to mean re-typing every field, and the rail's own
 * switch refused the click with "some fields are still missing" because it reads
 * the draft from the section that no longer exists.
 *
 * So the form remembers itself: the non-credential fields of the last successful
 * save are kept here, and a channel with no section is seeded from them. Secrets
 * are never kept — they live in the host's secret store, and a token is the one
 * value this page must not hold on to.
 */
const STORAGE_KEY = "qianning.messaging.draft";

type Memory = Record<string, MessagingDraft>;

/** When storage is unavailable (a locked profile, a private window), memory is
 *  still worth having: it makes the toggle reversible for this session. */
const inMemory: { current: Memory } = { current: {} };

function read(): Memory {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return inMemory.current;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...(parsed as Memory) } : inMemory.current;
  } catch {
    return inMemory.current;
  }
}

function write(memory: Memory): void {
  inMemory.current = memory;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Not being able to persist is not a reason to lose this session's memory.
  }
}

/** The fields worth keeping: the record's own, never the credential box. */
function withoutSecrets(draft: MessagingDraft): MessagingDraft {
  return { ...draft, secrets: {} };
}

/** Remember what a successful save stored, so the channel can be turned back on. */
export function rememberDraft(platformId: string, draft: MessagingDraft): void {
  const memory = read();
  memory[platformId] = withoutSecrets(draft);
  write(memory);
}

/**
 * The draft a panel should start from: the stored record when there is one, and
 * the last saved values when the channel was switched off and its section
 * removed.
 */
export function draftWithMemory(
  platform: SupportedMessagingPlatform,
  record: MessagingPlatformRecord | null | undefined,
): MessagingDraft {
  const stored = draftFrom(platform, record);
  if (record) return stored;
  const remembered = read()[platform.id];
  if (!remembered) return stored;
  return { ...stored, ...remembered, secrets: {} };
}
