/**
 * Every model the user marked for a generation capability.
 *
 * A model marked for image or video generation is not a chat model: the
 * composer pickers, the app default model and the provider quick-default action
 * all have to reject it, and both capabilities share that one rule instead of
 * each carrying its own copy. Bindings come from either settings field, so a
 * single list answers "is this model a generation model" for every picker.
 *
 * Identity is the complete wire id, exactly as in the two capability modules:
 * a catalog alias or a case difference is a different outbound model.
 */
import {
  imageGenerationBindings,
  type ImageGenerationBinding,
  type ImageGenerationBindings,
} from "./image-generation.js";
import {
  videoGenerationBindings,
  type VideoGenerationBinding,
  type VideoGenerationBindings,
} from "./video-generation.js";

export type GenerationModelRef = { providerId: string; modelId: string };
export type GenerationModelRefs = GenerationModelRef | readonly GenerationModelRef[];

/** The two settings fields each capability reads, as the settings store holds them. */
export type GenerationModelSettings = {
  imageGeneration?: ImageGenerationBinding | null;
  imageGenerationModels?: ImageGenerationBindings | null;
  videoGeneration?: VideoGenerationBinding | null;
  videoGenerationModels?: VideoGenerationBindings | null;
};

function sameGenerationModelId(left: string, right: string): boolean {
  const requested = right.trim().toLowerCase();
  return requested.length > 0 && left.trim().toLowerCase() === requested;
}

/** Both capabilities' marked models, image generation first. */
export function generationModelRefs(
  settings: GenerationModelSettings | null | undefined,
): GenerationModelRef[] {
  const imageModels = settings?.imageGenerationModels;
  const image = imageGenerationBindings(
    Array.isArray(imageModels) ? imageModels : null,
    settings?.imageGeneration,
  );
  const videoModels = settings?.videoGenerationModels;
  const video = videoGenerationBindings(
    Array.isArray(videoModels) ? videoModels : null,
    settings?.videoGeneration,
  );
  return video.length ? [...image, ...video] : image;
}

/** True when the model is marked for any generation capability. */
export function isGenerationModel(
  refs: GenerationModelRefs | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): boolean {
  if (!providerId || !modelId) return false;
  const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
  return list.some(
    (ref) => ref.providerId === providerId && sameGenerationModelId(ref.modelId, modelId),
  );
}
