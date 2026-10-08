import { describe, expect, it } from "vitest";
import { detectGenerationCapability, seedGenerationModels } from "./generation-capability.js";

describe("generation capability detection", () => {
  it("reads image families from the model id", () => {
    for (const id of [
      "gpt-image-1",
      "dall-e-3",
      "DALL-E-3",
      "flux-1.1-pro",
      "stable-diffusion-3.5-large",
      "sdxl",
      "imagen-4.0-generate",
      "ideogram-v3",
      "seedream-3.0",
      "qwen-image",
      "wanx2.1-t2i-turbo",
      "recraft-v3",
      "gemini-2.5-flash-image-preview",
      "vendor/image-v2",
    ]) {
      expect(detectGenerationCapability(id), id).toEqual({ image: true, video: false });
    }
  });

  it("reads video families from the model id", () => {
    for (const id of [
      "sora-2",
      "veo-3.0-generate-preview",
      "kling-v2-master",
      "runway-gen-4",
      "pika-2.0",
      "hailuo-02",
      "seedance-1-0-pro",
      "wan2.2-t2v-plus",
      "wanx2.1-video",
      "cogvideox-5b",
      "luma-ray-2",
      "vendor/video-01",
    ]) {
      expect(detectGenerationCapability(id), id).toEqual({ image: false, video: true });
    }
  });

  it("leaves chat and embedding models alone", () => {
    for (const id of [
      "gpt-4o",
      "claude-sonnet-4-20250514",
      "deepseek-v3",
      "llama-3.2-11b-vision-instruct",
      "qwen2.5-vl-72b",
      "text-embedding-3-large",
      "whisper-1",
      "tts-1-hd",
      "imageprocessing-lite",
      "",
    ]) {
      expect(detectGenerationCapability(id), id).toEqual({ image: false, video: false });
    }
  });

  it("prefers the specific video family when a name carries both", () => {
    expect(detectGenerationCapability("wanx2.1-video-edit")).toEqual({
      image: false,
      video: true,
    });
    expect(detectGenerationCapability("foo-image-video")).toEqual({ image: true, video: true });
  });

  it("marks detected models when a capability list has never been written", () => {
    const providers = [
      {
        id: "openai",
        enabled: true,
        authKind: "api_key_and_base_url",
        models: [{ id: "gpt-4o" }, { id: "gpt-image-1" }, { id: "sora-2" }],
      },
      {
        id: "anthropic-oauth",
        enabled: true,
        authKind: "oauth",
        models: [{ id: "gpt-image-1" }],
      },
      {
        id: "disabled",
        enabled: false,
        authKind: "api_key_and_base_url",
        models: [{ id: "flux-pro" }],
      },
    ];
    expect(seedGenerationModels({}, providers)).toEqual({
      imageGenerationModels: [{ providerId: "openai", modelId: "gpt-image-1" }],
      videoGenerationModels: [{ providerId: "openai", modelId: "sora-2" }],
    });
  });

  it("never overrules a list the user already has, including an empty one", () => {
    const providers = [
      { id: "openai", enabled: true, models: [{ id: "gpt-image-1" }, { id: "sora-2" }] },
    ];
    const cleared = { imageGenerationModels: [], videoGenerationModels: [] };
    expect(seedGenerationModels(cleared, providers)).toBe(cleared);
    const chosen = { imageGenerationModels: [{ providerId: "x", modelId: "y" }] };
    expect(seedGenerationModels(chosen, providers)).toEqual({
      imageGenerationModels: [{ providerId: "x", modelId: "y" }],
      videoGenerationModels: [{ providerId: "openai", modelId: "sora-2" }],
    });
  });

  it("returns the same settings when there is nothing to mark", () => {
    const settings = {};
    expect(
      seedGenerationModels(settings, [{ id: "p", enabled: true, models: [{ id: "gpt-4o" }] }]),
    ).toBe(settings);
  });
});
