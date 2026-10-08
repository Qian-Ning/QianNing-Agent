/**
 * Which generation capability a model has, read from its id.
 *
 * A user who adds a provider should not have to discover the capability
 * checkboxes before the workbench can offer anything, so a model that names an
 * image or video family is marked on first sight. The table is deliberately
 * narrow and family-based rather than clever: a model wrongly marked spends the
 * user's money the first time they pick it, while a model left unmarked only
 * costs a manual tick.
 *
 * Distinctive tokens match as substrings (`gpt-image`, `seedance`); short or
 * ambiguous ones must occupy a whole segment of the id, so `image` marks
 * `foo/image-v2` and never `imageprocessing-lite`.
 */
import type { GenerationModelSettings } from "./generation-models.js";

export type GenerationCapability = { image: boolean; video: boolean };

const IMAGE_FAMILIES = [
  "dall-e",
  "dalle",
  "gpt-image",
  "flux",
  "stable-diffusion",
  "sdxl",
  "sd3",
  "sd-3",
  "sd-turbo",
  "playground-v",
  "imagen",
  "ideogram",
  "recraft",
  "midjourney",
  "seedream",
  "seededit",
  "qwen-image",
  "doubao-image",
  "jimeng",
  "kolors",
  "cogview",
  "hidream",
  "lumina",
  "nano-banana",
  "ernie-image",
  "glm-image",
  "hunyuan-image",
  "text-to-image",
  "imagegen",
  "t2i",
];

const VIDEO_FAMILIES = [
  "sora",
  "veo",
  "kling",
  "runway",
  "pika",
  "luma",
  "ray-1",
  "ray-2",
  "hailuo",
  "minimax-video",
  "video-01",
  "seedance",
  "dreamina",
  "wan-video",
  "cogvideo",
  "hunyuan-video",
  "vidu",
  "pixverse",
  "framepack",
  "text-to-video",
  "t2v",
  "i2v",
];

/** Whole-segment words: too short or too common to match inside another word. */
const IMAGE_WORDS = ["image", "images", "pic", "pics"];
const VIDEO_WORDS = [
  "video",
  "videos",
  "clip",
  "clips",
  // Runway's version tags are whole segments only: "gen-4" inside
  // "imagen-4.0-generate" is a model name, not a video family.
  "gen3",
  "gen4",
  "gen-3",
  "gen-4",
];

function segments(modelId: string): string[] {
  return modelId
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasFamily(lower: string, families: readonly string[]): boolean {
  return families.some((family) => lower.includes(family));
}

function hasWord(list: string[], words: readonly string[]): boolean {
  return list.some((segment) => words.includes(segment));
}

/** What the model id says about the model, with nothing inferred from the provider. */
export function detectGenerationCapability(modelId: string): GenerationCapability {
  const lower = modelId.trim().toLowerCase();
  if (!lower) return { image: false, video: false };
  const parts = segments(lower);
  const videoNamed =
    hasFamily(lower, VIDEO_FAMILIES) || hasWord(parts, VIDEO_WORDS);
  const imageNamed = hasFamily(lower, IMAGE_FAMILIES) || hasWord(parts, IMAGE_WORDS);
  if (!videoNamed && !imageNamed) return { image: false, video: false };
  if (videoNamed && !imageNamed) return { image: false, video: true };
  if (imageNamed && !videoNamed) return { image: true, video: false };
  // Both named: a specific video family outranks a generic image word, because
  // `wanx2.1-video` is a video model that happens to carry its image sibling's
  // family prefix, and the reverse mistake is the expensive one.
  const videoSpecific = hasFamily(lower, VIDEO_FAMILIES);
  const imageSpecific = hasFamily(lower, IMAGE_FAMILIES);
  if (videoSpecific && !imageSpecific) return { image: false, video: true };
  if (imageSpecific && !videoSpecific) return { image: true, video: false };
  return { image: true, video: true };
}

type SeedProvider = {
  id: string;
  enabled?: boolean;
  authKind?: string;
  models?: readonly { id: string }[];
};

type SeedSettings = GenerationModelSettings & Record<string, unknown>;

function binding(providerId: string, modelId: string) {
  return { providerId, modelId };
}

function isList(value: unknown): value is readonly { providerId: string; modelId: string }[] {
  return Array.isArray(value);
}

/**
 * The settings with detected models marked, or the same object when nothing is
 * missing. A capability whose list is already an array is left exactly as it is,
 * including an empty one the user cleared, so the automatic pass never overrules
 * a decision the user already made. Only providers the runtime could actually
 * run are considered: a disabled row or an OAuth account cannot render.
 */
export function seedGenerationModels<T extends SeedSettings>(
  settings: T,
  providers: readonly SeedProvider[],
): T {
  const needImage = !isList(settings.imageGenerationModels);
  const needVideo = !isList(settings.videoGenerationModels);
  if (!needImage && !needVideo) return settings;
  const image: ReturnType<typeof binding>[] = [];
  const video: ReturnType<typeof binding>[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    if (provider.authKind === "oauth") continue;
    for (const model of provider.models ?? []) {
      const capability = detectGenerationCapability(model.id);
      if (capability.image) image.push(binding(provider.id, model.id));
      if (capability.video) video.push(binding(provider.id, model.id));
    }
  }
  if (image.length === 0 && video.length === 0) return settings;
  const next: SeedSettings = { ...settings };
  if (needImage && image.length) next.imageGenerationModels = image;
  if (needVideo && video.length) next.videoGenerationModels = video;
  return next as T;
}
