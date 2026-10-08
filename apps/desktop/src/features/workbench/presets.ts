/**
 * The parameter tables the workbench offers.
 *
 * Shape and resolution are two decisions, not one: a 16:9 frame at 720p and the
 * same frame at 1080p are different requests, and a request is billed before the
 * user learns it was refused. The two are chosen separately and composed into
 * the single `WIDTHxHEIGHT` string the provider receives, and every composed
 * value passes the shared contract's own validation before anything is sent.
 */
import { IMAGE_MAX_SIDE, IMAGE_MIN_SIDE, VIDEO_SIZE_PATTERN } from "@pi-desktop/shared";

export type Ratio = {
  id: string;
  /** Visible label, and the ratio in lowest terms. */
  label: string;
  w: number;
  h: number;
};

/** Long sides offered per capability, in pixels. */
export const IMAGE_RESOLUTIONS = [512, 768, 1024, 1280, 1536, 1792, 2048, 2560, 4096] as const;
export const VIDEO_RESOLUTIONS = [480, 720, 1080, 1440, 2160] as const;

export const IMAGE_RATIOS: Ratio[] = [
  { id: "1:1", label: "1:1", w: 1, h: 1 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "3:2", label: "3:2", w: 3, h: 2 },
  { id: "2:3", label: "2:3", w: 2, h: 3 },
  { id: "16:9", label: "16:9", w: 16, h: 9 },
  { id: "9:16", label: "9:16", w: 9, h: 16 },
  { id: "21:9", label: "21:9", w: 21, h: 9 },
  { id: "9:21", label: "9:21", w: 9, h: 21 },
];

/** Video endpoints read a ratio more strictly, so the list is shorter. */
export const VIDEO_RATIOS: Ratio[] = [
  { id: "16:9", label: "16:9", w: 16, h: 9 },
  { id: "9:16", label: "9:16", w: 9, h: 16 },
  { id: "1:1", label: "1:1", w: 1, h: 1 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "21:9", label: "21:9", w: 21, h: 9 },
];

export const VIDEO_DURATION_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 15];

export const DEFAULT_IMAGE_RESOLUTION = 1024;
export const DEFAULT_VIDEO_RESOLUTION = 720;

export function ratiosFor(capability: "image" | "video"): Ratio[] {
  return capability === "image" ? IMAGE_RATIOS : VIDEO_RATIOS;
}

export function resolutionsFor(capability: "image" | "video"): readonly number[] {
  return capability === "image" ? IMAGE_RESOLUTIONS : VIDEO_RESOLUTIONS;
}

export function defaultResolutionFor(capability: "image" | "video"): number {
  return capability === "image" ? DEFAULT_IMAGE_RESOLUTION : DEFAULT_VIDEO_RESOLUTION;
}

export function ratioById(capability: "image" | "video", id: string): Ratio | null {
  return ratiosFor(capability).find((ratio) => ratio.id === id) ?? null;
}

/** Multiples of 8 are what image models with a VAE accept without a silent rescale. */
function snap(value: number): number {
  const rounded = Math.round(value / 8) * 8;
  return Math.min(IMAGE_MAX_SIDE, Math.max(Math.max(8, IMAGE_MIN_SIDE), rounded));
}

/** Image resolutions name the long side: `3:2` + `1536` is `1536x1024`. */
export function composeImageSize(ratio: Ratio, longSide: number): string {
  const landscape = ratio.w >= ratio.h;
  const width = landscape ? longSide : (longSide * ratio.w) / ratio.h;
  const height = landscape ? (longSide * ratio.h) / ratio.w : longSide;
  return `${snap(width)}x${snap(height)}`;
}

/**
 * Video resolutions name the short side, the way `720p` does: `16:9` + `720` is
 * `1280x720` and `9:16` + `720` is `720x1280`, so a portrait clip and a landscape
 * clip of the same tier carry the same amount of picture.
 */
export function composeVideoSize(ratio: Ratio, shortSide: number): string {
  const landscape = ratio.w >= ratio.h;
  const width = landscape ? (shortSide * ratio.w) / ratio.h : shortSide;
  const height = landscape ? shortSide : (shortSide * ratio.h) / ratio.w;
  return `${snap(width)}x${snap(height)}`;
}

/** What the provider will receive for the current pair, or `""` for the default. */
export function composeFor(
  capability: "image" | "video",
  ratio: Ratio,
  value: number,
): string {
  return capability === "image" ? composeImageSize(ratio, value) : composeVideoSize(ratio, value);
}

/** A custom size is accepted only when the shared contract would accept it too. */
export function customImageSizeValid(value: string): boolean {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim());
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return (
    width >= IMAGE_MIN_SIDE &&
    width <= IMAGE_MAX_SIDE &&
    height >= IMAGE_MIN_SIDE &&
    height <= IMAGE_MAX_SIDE
  );
}

export function customVideoSizeValid(value: string): boolean {
  return VIDEO_SIZE_PATTERN.test(value.trim());
}

/** Empty means "let the provider decide", which is always valid. */
export function sizeValid(capability: "image" | "video", value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return capability === "image" ? customImageSizeValid(trimmed) : customVideoSizeValid(trimmed);
}

export const DEFAULT_VIDEO_DURATION = 8;

/** The industry name for a tier, so a number is not the only clue. */
export function resolutionTierLabel(capability: "image" | "video", value: number): string {
  if (capability === "video") {
    if (value === 480) return "480p";
    if (value === 720) return "720p";
    if (value === 1080) return "1080p";
    if (value === 1440) return "2K · 1440p";
    if (value === 2160) return "4K · 2160p";
    return `${value}p`;
  }
  // The composed size is already next to this label, so the image side names the
  // long side in pixels and only adds the tier once the number is a real one.
  if (value === 2048) return "2048 px · 2K";
  if (value === 4096) return "4096 px · 4K";
  return `${value} px`;
}

/**
 * The workbench is a hand-run surface, not a batch job: the count is what one
 * person is going to look at, and four is the number that stays readable.
 */
export const MAX_WORKBENCH_COUNT = 4;

/** A typed count is accepted only as a whole number inside the workbench cap. */
export function normalizeCount(input: string): number | null {
  const text = input.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MAX_WORKBENCH_COUNT ? value : null;
}

/** Settling a field the user left: the nearest allowed count, never out of range. */
export function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_WORKBENCH_COUNT, Math.max(1, Math.round(value)));
}

/**
 * Whether a provider runs on this machine or the local network.
 *
 * A locally deployed generator (ComfyUI, SD-WebUI, an Ollama-style server) names
 * its models after files — `sd_xl_base_1.0` says nothing about whether it renders
 * images or video — so those providers are not held to the name-based capability
 * filter. The user configured the endpoint; the user picks the model.
 */
export function isLocalEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
