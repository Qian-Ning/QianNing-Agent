/**
 * Renderer-local persistence for the media workbench's compose draft.
 *
 * The workbench is a craft surface: the user writes a prompt, sets the model and
 * the parameters, and only then runs it. Losing that composition when the page
 * is left — or when the app restarts — makes the user describe the same thing a
 * second time. Like the composer model favourites and the sidebar preferences,
 * the draft is pure UI state, so it lives in `localStorage` under the
 * `pi.desktop.*` namespace and never touches the Rust-owned database. It is
 * written debounced by the page (see `useWorkbenchDraft`) and read once on open.
 *
 * Only local text and parameters are stored. Frame and reference-image slots are
 * file paths that the attachment store owns for one session; a stale path
 * restored after a restart would rot, so those slots are deliberately not part
 * of the draft. What is stored — the two multipart frame *field names* — is a
 * plain string the user typed and means the same thing on any machine.
 */
import { MAX_VIDEO_DURATION_SECONDS } from "@pi-desktop/shared";
import {
  DEFAULT_VIDEO_DURATION,
  VIDEO_DURATION_PRESETS,
  ratioById,
  resolutionsFor,
} from "../features/workbench/presets";

/** The two capabilities the workbench keeps separate drafts for. */
export type WorkbenchCapability = "image" | "video";

/** The workbench tab both drafts are stored under. */
export const WORKBENCH_DRAFT_KEY = "pi.desktop.workbenchDrafts";

/** How long the page waits after the last edit before it writes the draft. */
export const WORKBENCH_DRAFT_DEBOUNCE_MS = 400;

/** The custom-size sentinel the resolution control stores when the user types a size. */
const CUSTOM_SIZE = "__custom__";

export type WorkbenchModelRef = {
  providerId: string;
  modelId: string;
};

/**
 * One capability's compose state.
 *
 * The model is the user's explicit pick for the current run (never the default
 * from Settings), so restoring it does not shadow a later change of the default.
 */
export type WorkbenchDraft = {
  prompt: string;
  model: WorkbenchModelRef | null;
  countDraft: string;
  ratio: string;
  resolution: string;
  customValue: string;
  duration: number;
  frameFieldFirst: string;
  frameFieldLast: string;
};

export type WorkbenchDrafts = Record<WorkbenchCapability, WorkbenchDraft>;

/** The draft a capability starts from when nothing has been stored. */
export function emptyWorkbenchDraft(capability: WorkbenchCapability): WorkbenchDraft {
  return {
    prompt: "",
    model: null,
    countDraft: "1",
    ratio: "",
    resolution: "",
    customValue: "",
    duration: DEFAULT_VIDEO_DURATION,
    frameFieldFirst: "",
    frameFieldLast: "",
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A stored model is kept only when both halves are non-empty strings. */
function cleanModel(value: unknown): WorkbenchModelRef | null {
  if (!object(value)) return null;
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  return providerId && modelId ? { providerId, modelId } : null;
}

/** A ratio is kept only when the capability actually offers it. */
function cleanRatio(capability: WorkbenchCapability, value: unknown): string {
  return typeof value === "string" && ratioById(capability, value) ? value : "";
}

/** A resolution is kept only as the capability's own tier or the custom sentinel. */
function cleanResolution(capability: WorkbenchCapability, value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value === CUSTOM_SIZE) return value;
  return resolutionsFor(capability).some((tier) => String(tier) === value) ? value : "";
}

/** A duration is kept only as one of the presets the video tab offers. */
function cleanDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_VIDEO_DURATION;
  const whole = Math.round(value);
  return VIDEO_DURATION_PRESETS.includes(whole) && whole <= MAX_VIDEO_DURATION_SECONDS
    ? whole
    : DEFAULT_VIDEO_DURATION;
}

/**
 * Turn whatever was stored for one capability into a draft the page can trust.
 *
 * Every field is validated against the same tables the controls use, so a value
 * that came from an older build, a hand-edited store, or a half-written record
 * degrades to the field's default instead of reaching a control that would
 * reject it — a restored draft must never disable the submit row on its own.
 */
export function sanitizeWorkbenchDraft(
  value: unknown,
  capability: WorkbenchCapability,
): WorkbenchDraft {
  const fallback = emptyWorkbenchDraft(capability);
  if (!object(value)) return fallback;
  return {
    prompt: text(value.prompt),
    model: cleanModel(value.model),
    countDraft: typeof value.countDraft === "string" ? value.countDraft : fallback.countDraft,
    ratio: cleanRatio(capability, value.ratio),
    resolution: cleanResolution(capability, value.resolution),
    customValue: text(value.customValue),
    duration: cleanDuration(value.duration),
    frameFieldFirst: text(value.frameFieldFirst),
    frameFieldLast: text(value.frameFieldLast),
  };
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** Both drafts, each sanitized. A missing or unreadable store yields the defaults. */
export function loadWorkbenchDrafts(): WorkbenchDrafts {
  const store = storage();
  let raw: unknown;
  if (store) {
    try {
      const value = store.getItem(WORKBENCH_DRAFT_KEY);
      raw = value ? JSON.parse(value) : undefined;
    } catch {
      raw = undefined;
    }
  }
  const root = object(raw) ? raw : {};
  return {
    image: sanitizeWorkbenchDraft(root.image, "image"),
    video: sanitizeWorkbenchDraft(root.video, "video"),
  };
}

/** Persist both drafts. A blocked or full store must never break the compose panel. */
export function saveWorkbenchDrafts(drafts: WorkbenchDrafts): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      WORKBENCH_DRAFT_KEY,
      JSON.stringify({
        image: sanitizeWorkbenchDraft(drafts.image, "image"),
        video: sanitizeWorkbenchDraft(drafts.video, "video"),
      }),
    );
  } catch {
    // Best effort: a full or blocked localStorage is not the user's problem here.
  }
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export type DebouncedWriter<T> = {
  /** Remember the newest value and (re)start the quiet period. */
  schedule(value: T): void;
  /** Write the pending value now, if any. */
  flush(): void;
  /** Drop the pending value without writing. */
  cancel(): void;
  /** Whether a write is scheduled. */
  readonly pending: boolean;
};

/**
 * A debounced writer, with its timers injected so the scheduling itself is a
 * pure, unit-testable function: the page passes the page's own `setTimeout`, and
 * a test passes a fake clock. Typing coalesces into one write per quiet period,
 * and `flush` guarantees the last edit is not lost when the page is left.
 */
export function createDebouncedWriter<T>(
  write: (value: T) => void,
  delayMs: number,
  setTimer: (handler: () => void, timeout: number) => TimerHandle = setTimeout,
  clearTimer: (handle: TimerHandle) => void = clearTimeout,
): DebouncedWriter<T> {
  let handle: TimerHandle | null = null;
  let latest: T | undefined;
  let hasLatest = false;

  const clear = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  return {
    schedule(value: T): void {
      latest = value;
      hasLatest = true;
      clear();
      handle = setTimer(() => {
        handle = null;
        hasLatest = false;
        write(latest as T);
      }, delayMs);
    },
    flush(): void {
      if (!hasLatest) return;
      clear();
      hasLatest = false;
      write(latest as T);
    },
    cancel(): void {
      clear();
      hasLatest = false;
    },
    get pending(): boolean {
      return handle !== null;
    },
  };
}
