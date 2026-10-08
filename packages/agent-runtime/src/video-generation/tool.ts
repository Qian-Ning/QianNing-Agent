import { Type } from "@earendil-works/pi-ai";

export const videoGenerationDescription =
  "Generate short videos using the video model configured in Settings > Models > Video generation model. items supports distinct prompts and count variants; at most 8 videos total. Rendering takes minutes and each video is billed per second by the provider: generate only the requested number, report partial failures, and do not retry without the user's request. An optional image is one local path used as the clip's first frame; lastFrame is a second local path used as the clip's last frame and requires image. Results contain local video paths (mp4, webm, mov): report each successful path and its duration.";
export const videoGenerationParameters = {
  items: Type.Array(
    Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      image: Type.Optional(
        Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
      ),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      lastFrame: Type.Optional(
        Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
      ),
      durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      size: Type.Optional(
        Type.Union([Type.String({ minLength: 3, maxLength: 11 }), Type.Null()]),
      ),
    }),
    { minItems: 1, maxItems: 8 },
  ),
};
