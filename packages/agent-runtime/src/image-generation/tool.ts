import { Type } from "@earendil-works/pi-ai";

export const imageGenerationDescription =
  "Generate raster images using the image model configured in Settings > Models. items supports distinct prompts and count variants; at most 20 images total. Each image may incur a charge. Generate only the requested number, report partial failures, and do not retry without the user's request. size requests a pixel size such as 1024x1024. Results contain local image paths: display successful images with Markdown image links. For edits, provide images as local paths from the session, attachments, or project. Use previous result paths to refine generated images; preserve originals.";
export const imageGenerationParameters = {
  items: Type.Array(
    Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      images: Type.Optional(
        Type.Union([
          Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 4 }),
          Type.Null(),
        ]),
      ),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      size: Type.Optional(
        Type.Union([Type.String({ minLength: 3, maxLength: 11 }), Type.Null()]),
      ),
    }),
    { minItems: 1, maxItems: 20 },
  ),
};
