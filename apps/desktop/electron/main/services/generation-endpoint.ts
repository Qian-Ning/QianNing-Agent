import {
  parseImageGenerationBinding,
  parseVideoGenerationBinding,
  type AppSettings,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";

export type GenerationKind = "image" | "video";

/** A provider+model pair named by the caller instead of by host settings. */
export type GenerationModelChoice = { providerId: string; modelId: string };

export type GenerationEndpoint = {
  providerId: string;
  modelId: string;
  /** Already checked to be a non-empty URL by the time this is returned. */
  baseUrl: string;
  headers?: Record<string, string>;
  apiKey?: string;
};

export type GenerationEndpointFailure = { errorCode: string; message: string };

/**
 * The words each capability uses when resolution fails.
 *
 * Both callers — the Agent tools and the workbench — report through the same
 * codes, so a failure reads the same however the request was started.
 */
const COPY: Record<
  GenerationKind,
  {
    configuredCode: string;
    configured: string;
    unavailableCode: string;
    unavailable: string;
    selector: string;
  }
> = {
  image: {
    configuredCode: "IMAGE_NOT_CONFIGURED",
    configured:
      "Configure an image generation model in Settings > Models > Image generation model before generating images. Do not substitute another model.",
    unavailableCode: "IMAGE_MODEL_UNAVAILABLE",
    unavailable:
      "The configured image model is unavailable. Update Settings > Models > Image generation model.",
    selector: "image generation model",
  },
  video: {
    configuredCode: "VIDEO_NOT_CONFIGURED",
    configured:
      "Configure a video generation model in Settings > Models > Video generation model before generating videos. Do not substitute another model.",
    unavailableCode: "VIDEO_MODEL_UNAVAILABLE",
    unavailable:
      "The configured video model is unavailable. Update Settings > Models > Video generation model.",
    selector: "video generation model",
  },
};

/**
 * Resolve the provider, model and credential one generation request runs with.
 *
 * Two callers share this: the Agent tools use the binding the host settings own,
 * and the workbench passes the model the user picked. A choice is never trusted
 * on its own — it must be a model the chosen provider actually lists, so picking
 * a model in the UI cannot reach a model the provider row does not expose.
 */
export async function resolveGenerationEndpoint(options: {
  host: Pick<HostProcess, "call">;
  kind: GenerationKind;
  choice?: GenerationModelChoice;
}): Promise<GenerationEndpoint | GenerationEndpointFailure> {
  const copy = COPY[options.kind];
  const settings = await options.host.call<AppSettings>("settings.get");
  const configured =
    options.kind === "image"
      ? parseImageGenerationBinding(settings.imageGeneration)
      : parseVideoGenerationBinding(settings.videoGeneration);
  const binding = options.choice ?? configured;
  if (!binding) return { errorCode: copy.configuredCode, message: copy.configured };
  const { provider } = await options.host.call<{ provider?: ProviderPublic }>("providers.get", {
    id: binding.providerId,
  });
  if (
    !provider?.enabled ||
    !provider.baseUrl ||
    !provider.models.some((model) => model.id === binding.modelId)
  ) {
    if (!options.choice) return { errorCode: copy.unavailableCode, message: copy.unavailable };
    return {
      errorCode: copy.unavailableCode,
      message: `The selected model is not available from that service. Pick another ${copy.selector} in the workbench.`,
    };
  }
  if (provider.authKind === "oauth")
    return {
      errorCode: `${options.kind.toUpperCase()}_AUTH_UNSUPPORTED`,
      message: `${options.kind === "image" ? "Image" : "Video"} generation requires an API-key or no-auth service.`,
    };
  const { value } = await options.host.call<{ value?: string }>("providers.getSecret", {
    id: provider.id,
  });
  if (provider.authKind !== "none" && !value)
    return {
      errorCode: `${options.kind.toUpperCase()}_AUTH_FAILED`,
      message: `The ${options.kind} provider needs an API key.`,
    };
  return {
    providerId: provider.id,
    modelId: binding.modelId,
    baseUrl: provider.baseUrl,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(value ? { apiKey: value } : {}),
  };
}
