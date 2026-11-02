import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearLibrary, generate, imageEndpoint, library } from "./workbench";

const store = new Map<string, string>();
let http: ReturnType<typeof vi.fn>;
let written: Array<{ name: string; data: string; folder?: string }>;

beforeEach(() => {
  store.clear();
  written = [];
  http = vi.fn(async () => ({
    status: 200,
    headers: {},
    data: { data: [{ b64_json: "iVBORw0KGgo=" }] },
    url: "",
  }));
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = localStorage;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage,
    Capacitor: {
      Plugins: {
        CapacitorHttp: { request: http },
        QnFiles: {
          writeBase64: async (input: { name: string; data: string; folder?: string }) => {
            written.push(input);
            return { path: `/data/files/${input.folder ?? "media"}/${input.name}`, size: 8 };
          },
          readDataUrl: async () => ({ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
        },
      },
    },
  };
  // The provider record is what a configured phone already carries.
  store.set(
    "qn.local.provider",
    JSON.stringify({ baseUrl: "https://relay.example.com/v1", apiKey: "sk-test", modelId: "gpt-image-1" }),
  );
});

describe("the images endpoint", () => {
  it("builds the same path the desktop tool builds", () => {
    expect(imageEndpoint("https://relay.example.com/v1")).toBe(
      "https://relay.example.com/v1/images/generations",
    );
    expect(imageEndpoint("https://relay.example.com/v1/")).toBe(
      "https://relay.example.com/v1/images/generations",
    );
    // A bare host means the provider's /v1 root, exactly as the desktop reads it.
    expect(imageEndpoint("https://relay.example.com")).toBe(
      "https://relay.example.com/v1/images/generations",
    );
  });

  it("refuses a non-http address instead of guessing", () => {
    expect(() => imageEndpoint("file:///etc/passwd")).toThrow(/http/);
  });
});

describe("generating", () => {
  it("sends the model and prompt with the provider credential", async () => {
    const result = await generate({
      capability: "image",
      input: { items: [{ prompt: "a brass lantern", size: "1024x1024" }] },
    });

    expect(result.ok).toBe(true);
    const call = http.mock.calls[0]?.[0] as unknown as {
      url: string;
      method: string;
      headers: Record<string, string>;
      data: string;
    };
    expect(call.url).toBe("https://relay.example.com/v1/images/generations");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(call.data)).toEqual({
      model: "gpt-image-1",
      prompt: "a brass lantern",
      n: 1,
      size: "1024x1024",
    });
  });

  it("keeps the bytes and records the render in the library", async () => {
    const result = await generate({ capability: "image", input: { items: [{ prompt: "a lantern" }] } });

    expect(result.results[0]?.status).toBe("succeeded");
    expect(result.results[0]?.url).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(written).toHaveLength(1);
    expect(written[0]?.folder).toBe("media");

    const listed = await library();
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.prompt).toBe("a lantern");
    expect(listed.entries[0]?.status).toBe("succeeded");
    expect(listed.entries[0]?.url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("reports the provider's own words when it refuses", async () => {
    http.mockResolvedValue({
      status: 400,
      headers: {},
      data: { error: { message: "model does not support images" } },
      url: "",
    });
    const result = await generate({ capability: "image", input: { items: [{ prompt: "x" }] } });

    expect(result.ok).toBe(false);
    expect(result.results[0]?.errorCode).toBe("HTTP_400");
    const listed = await library();
    expect(listed.entries[0]?.errorCode).toBe("HTTP_400");
  });

  it("says what is missing when no provider is configured", async () => {
    store.delete("qn.local.provider");
    const result = await generate({ capability: "image", input: { items: [{ prompt: "x" }] } });
    expect(result.errorCode).toBe("PROVIDER_MISSING");
    expect(http).not.toHaveBeenCalled();
  });

  it("will not invent an image from an empty answer", async () => {
    http.mockResolvedValue({ status: 200, headers: {}, data: { data: [{}] }, url: "" });
    const result = await generate({ capability: "image", input: { items: [{ prompt: "x" }] } });
    expect(result.ok).toBe(false);
    expect(result.results[0]?.errorCode).toBe("NO_IMAGE");
  });

  it("empties the library on clear", async () => {
    await generate({ capability: "image", input: { items: [{ prompt: "one" }] } });
    expect((await library()).entries).toHaveLength(1);
    await clearLibrary();
    expect((await library()).entries).toHaveLength(0);
  });
});
