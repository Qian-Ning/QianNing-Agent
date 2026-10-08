import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseVideoGenerationBinding,
  parseVideoGenerationBindings,
  videoGenerationBindings,
  videoGenerationItems,
  isVideoGenerationModel,
  DEFAULT_VIDEO_FRAME_FIELDS,
} from "@pi-desktop/shared";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const {
  MAX_VIDEO_BYTES,
  generatedVideoType,
  generateOneVideo,
  generateVideoBatch,
  pollVideoJob,
  resolveFrameFields,
  submitVideoJob,
  videoGenerationUrl,
  videoJobUrl,
} = await import("./index.js");
const { downloadGeneratedVideo, videoBoundedBytes } = await import("./download.js");
const { publicMediaAddress } = await import("../media/download.js");

const lookupMock = vi.mocked(lookup);

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.alloc(16, 7),
]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16, 3)]);
const MAX_DECLARED = MAX_VIDEO_BYTES + 1;

type Call = { url: string; method: string; body: BodyInit | null | undefined };
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method, body: init?.body });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

/** Fake-IP answers route a download through the injected fetch. */
function resolverFor(address: string) {
  lookupMock.mockResolvedValue([{ address, family: 4 }] as never);
}

/** `invalid()` tags every rejected shape with the same stable code. */
const invalidArgument = () => expect.objectContaining({ errorCode: "INVALID_ARGUMENT" });

const endpoint = {
  baseUrl: "https://video.example.com",
  modelId: "video-model",
  apiKey: "fixture-key",
};

beforeEach(() => {
  lookupMock.mockReset();
});

describe("video generation endpoints", () => {
  it("builds /v1/videos from a root base URL and keeps an explicit prefix", () => {
    expect(videoGenerationUrl("https://example.com")).toBe("https://example.com/v1/videos");
    expect(videoGenerationUrl("https://example.com/gateway/v1/")).toBe(
      "https://example.com/gateway/v1/videos",
    );
    expect(videoJobUrl("https://example.com", "job/1")).toBe(
      "https://example.com/v1/videos/job%2F1",
    );
  });

  it("rejects a base URL with credentials, a query, a fragment or a non-http scheme", () => {
    for (const base of [
      "ftp://example.com",
      "https://user:pass@example.com",
      "https://example.com?x=1",
      "https://example.com#frag",
    ]) {
      expect(() => videoGenerationUrl(base)).toThrow("VIDEO_INVALID_ENDPOINT");
    }
  });
});

describe("video job lifecycle", () => {
  it("submits, polls through queued/in_progress and downloads the finished clip", async () => {
    resolverFor("198.18.0.1");
    const statuses = ["queued", "in_progress", "completed"];
    const { impl, calls } = stubFetch((url) => {
      if (url.endsWith("/v1/videos")) return Response.json({ id: "job-1", status: "queued" });
      if (url.endsWith("zzz.bin"))
        return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      const next = statuses.shift() ?? "completed";
      return Response.json(
        next === "completed"
          ? { status: next, data: [{ url: "https://cdn.example.com/zzz.bin" }] }
          : { status: next },
      );
    });

    const video = await generateOneVideo(endpoint, { prompt: "a fox" }, new AbortController().signal, {
      fetchImpl: impl,
      pollIntervalMs: 1,
      budgetMs: 5_000,
      downloadOptions: { allowFakeIp: true, fetchImpl: impl },
    });

    expect(video.mimeType).toBe("video/mp4");
    expect(video.extension).toBe("mp4");
    expect(video.bytes).toHaveLength(mp4.length);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://video.example.com/v1/videos",
      "GET https://video.example.com/v1/videos/job-1",
      "GET https://video.example.com/v1/videos/job-1",
      "GET https://video.example.com/v1/videos/job-1",
      "GET https://cdn.example.com/zzz.bin",
    ]);
    expect(JSON.parse(String(calls[0].body))).toEqual({ model: "video-model", prompt: "a fox" });
  });

  it("accepts a create response that already carries the finished URL", async () => {
    resolverFor("198.18.0.1");
    const { impl, calls } = stubFetch((url) =>
      url.endsWith("/v1/videos")
        ? Response.json({ status: "completed", url: "https://cdn.example.com/ok.bin" })
        : new Response(mp4),
    );
    const video = await generateOneVideo(endpoint, { prompt: "x" }, new AbortController().signal, {
      fetchImpl: impl,
      downloadOptions: { allowFakeIp: true, fetchImpl: impl },
    });
    expect(video.mimeType).toBe("video/mp4");
    expect(calls).toHaveLength(2);
  });

  it("keeps polling an unrecognized status instead of reporting a failure", async () => {
    let polls = 0;
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/v1/videos")) return Response.json({ id: "job-2" });
      polls += 1;
      if (polls === 1) return Response.json({ status: "weird-pending-state" });
      return Response.json({ status: "done", url: "https://cdn.example.com/ok.bin" });
    });
    const url = await pollVideoJob(endpoint, "job-2", new AbortController().signal, {
      fetchImpl: impl,
      pollIntervalMs: 1,
      budgetMs: 5_000,
    });
    expect(url).toBe("https://cdn.example.com/ok.bin");
    expect(polls).toBe(2);
  });

  it("maps a terminal failure status to VIDEO_JOB_FAILED without echoing provider text", async () => {
    const { impl } = stubFetch(() =>
      Response.json({ status: "failed", error: "internal provider detail" }),
    );
    await expect(
      pollVideoJob(endpoint, "job-3", new AbortController().signal, { fetchImpl: impl }),
    ).rejects.toMatchObject({ errorCode: "VIDEO_JOB_FAILED", message: "VIDEO_JOB_FAILED" });
  });

  it("reports stable codes for auth, HTTP, JSON and shape failures", async () => {
    const cases: Array<[Handler, string]> = [
      [() => new Response(null, { status: 401 }), "VIDEO_AUTH_FAILED"],
      [() => new Response(null, { status: 403 }), "VIDEO_AUTH_FAILED"],
      [() => new Response(null, { status: 500 }), "VIDEO_HTTP_500"],
      [() => new Response("<html>", { status: 200 }), "VIDEO_INVALID_RESPONSE"],
      [() => Response.json({ ok: true }), "VIDEO_INVALID_RESPONSE"],
      [() => Response.json({ data: [] }), "VIDEO_INVALID_RESPONSE"],
    ];
    for (const [handler, code] of cases) {
      const { impl } = stubFetch(handler);
      await expect(
        submitVideoJob(endpoint, { prompt: "x" }, new AbortController().signal, impl),
      ).rejects.toMatchObject({ errorCode: code });
    }
  });

  it("reports VIDEO_JOB_NOT_FOUND when the job disappears between polls", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 404 }));
    await expect(
      pollVideoJob(endpoint, "gone", new AbortController().signal, { fetchImpl: impl }),
    ).rejects.toMatchObject({ errorCode: "VIDEO_JOB_NOT_FOUND" });
  });

  it("times out a clip that never finishes inside its budget", async () => {
    const { impl, calls } = stubFetch(() => Response.json({ status: "queued" }));
    await expect(
      pollVideoJob(endpoint, "slow", new AbortController().signal, {
        fetchImpl: impl,
        pollIntervalMs: 5,
        budgetMs: 30,
      }),
    ).rejects.toMatchObject({ errorCode: "VIDEO_TIMEOUT" });
    expect(calls.length).toBeGreaterThan(1);
  });

  it("ends the poll loop when the caller cancels", async () => {
    const controller = new AbortController();
    let polls = 0;
    const { impl } = stubFetch(() => {
      polls += 1;
      if (polls === 2) controller.abort();
      return Response.json({ status: "queued" });
    });
    await expect(
      pollVideoJob(endpoint, "cancel-me", controller.signal, {
        fetchImpl: impl,
        pollIntervalMs: 1,
        budgetMs: 5_000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(polls).toBe(2);
  });

  it("sends a first frame as multipart input_reference and JSON otherwise", async () => {
    const frame = {
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
      extension: "png",
    };
    const withFrame = stubFetch(() => Response.json({ id: "job-4" }));
    await submitVideoJob(
      endpoint,
      { prompt: "start here", durationSeconds: 8, size: "1280x720" },
      new AbortController().signal,
      withFrame.impl,
      frame,
    );
    const form = withFrame.calls[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("video-model");
    expect(form.get("seconds")).toBe("8");
    expect(form.get("size")).toBe("1280x720");
    expect((form.get("input_reference") as File).name).toBe("frame.png");

    const plain = stubFetch(() => Response.json({ id: "job-5" }));
    await submitVideoJob(endpoint, { prompt: "no frame" }, new AbortController().signal, plain.impl);
    expect(typeof plain.calls[0].body).toBe("string");
  });
});

describe("video downloads", () => {
  it("recognizes mp4, QuickTime and WebM and rejects anything else", () => {
    expect(generatedVideoType(mp4)).toEqual({ mimeType: "video/mp4", extension: "mp4" });
    expect(
      generatedVideoType(
        Buffer.concat([
          Buffer.from([0, 0, 0, 0x14]),
          Buffer.from("ftypqt  ", "ascii"),
          Buffer.alloc(8),
        ]),
      ),
    ).toEqual({ mimeType: "video/quicktime", extension: "mov" });
    expect(generatedVideoType(webm)).toEqual({ mimeType: "video/webm", extension: "webm" });
    expect(() => generatedVideoType(Buffer.from("<html>not a video"))).toThrow(
      "VIDEO_INVALID_CONTENT",
    );
  });

  it("caps a download by content-length, by streamed size and rejects an empty body", async () => {
    resolverFor("198.18.0.1");
    const declared = stubFetch(
      () => new Response(mp4, { headers: { "content-length": String(MAX_DECLARED) } }),
    );
    await expect(
      downloadGeneratedVideo("https://cdn.example.com/big.bin", new AbortController().signal, {
        allowFakeIp: true,
        fetchImpl: declared.impl,
      }),
    ).rejects.toMatchObject({ errorCode: "VIDEO_TOO_LARGE" });

    await expect(videoBoundedBytes(new Response(mp4), 4)).rejects.toMatchObject({
      errorCode: "VIDEO_TOO_LARGE",
    });
    await expect(videoBoundedBytes(new Response(null), MAX_VIDEO_BYTES)).rejects.toMatchObject({
      errorCode: "VIDEO_EMPTY_RESPONSE",
    });
    await expect(videoBoundedBytes(new Response(mp4), MAX_VIDEO_BYTES)).resolves.toHaveLength(
      mp4.length,
    );
  });

  it("refuses credentials in the URL, metadata addresses and unroutable answers", async () => {
    resolverFor("198.18.0.1");
    await expect(
      downloadGeneratedVideo("https://user:pass@cdn.example.com/a.mp4", new AbortController().signal),
    ).rejects.toMatchObject({ errorCode: "VIDEO_INVALID_URL" });
    await expect(
      downloadGeneratedVideo("file:///a.mp4", new AbortController().signal),
    ).rejects.toMatchObject({ errorCode: "VIDEO_INVALID_URL" });
    await expect(
      downloadGeneratedVideo("https://cdn.example.com/a.mp4", new AbortController().signal, {
        fetchImpl: ((async () =>
          new Response(mp4, { headers: { "content-length": String(MAX_DECLARED) } })) as typeof fetch),
        allowFakeIp: true,
      }),
    ).rejects.toMatchObject({ errorCode: "VIDEO_TOO_LARGE" });

    for (const address of ["169.254.169.254", "0.0.0.0", "224.0.0.1"]) {
      resolverFor(address);
      await expect(
        downloadGeneratedVideo("https://cdn.example.com/a.mp4", new AbortController().signal),
      ).rejects.toMatchObject({ errorCode: "VIDEO_UNSAFE_URL" });
    }

    lookupMock.mockResolvedValue([] as never);
    await expect(
      downloadGeneratedVideo("https://cdn.example.com/a.mp4", new AbortController().signal),
    ).rejects.toMatchObject({ errorCode: "VIDEO_UNSAFE_URL" });
  });

  it("keeps loopback, RFC1918, CGNAT and ULA reachable while metadata is refused", () => {
    for (const allowed of ["127.0.0.1", "192.168.1.20", "10.0.0.5", "100.64.1.1", "::1", "fd00::1"]) {
      expect(publicMediaAddress(allowed)).toBe(true);
    }
    for (const refused of ["169.254.169.254", "0.0.0.0", "224.0.0.1", ""]) {
      expect(publicMediaAddress(refused)).toBe(false);
    }
  });
});

describe("video batches", () => {
  const save = async (_video: unknown, index: number) => `/scratch/clip-${index}.mp4`;

  it("keeps input order, expands counts and reports partial failures", async () => {
    resolverFor("198.18.0.1");
    let submissions = 0;
    const { impl } = stubFetch((url, init) => {
      if (url.endsWith("/v1/videos")) {
        submissions += 1;
        const body = typeof init?.body === "string" ? init.body : "";
        return Response.json({ id: body.includes("two") ? "job-fail" : "job-ok" });
      }
      if (url.includes("job-fail")) return Response.json({ status: "failed" });
      if (url.endsWith("ok.bin")) return new Response(mp4);
      return Response.json({ status: "completed", url: "https://cdn.example.com/ok.bin" });
    });

    const results = await generateVideoBatch({
      input: { items: [{ prompt: "one", count: 2 }, { prompt: "two" }] },
      endpoint,
      signal: new AbortController().signal,
      save,
      fetchImpl: impl,
      downloadOptions: { allowFakeIp: true, fetchImpl: impl },
      pollIntervalMs: 1,
      budgetMs: 5_000,
    });

    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded", "failed"]);
    expect(results[0].path).toBe("/scratch/clip-0.mp4");
    expect(results[1].path).toBe("/scratch/clip-1.mp4");
    expect(results[2]).toMatchObject({ index: 2, errorCode: "VIDEO_JOB_FAILED" });
    // Three jobs, three submissions: a failed clip is never retried.
    expect(submissions).toBe(3);
  });

  it("stops the queue after an authentication failure and cancels the rest", async () => {
    const { impl, calls } = stubFetch(() => new Response(null, { status: 401 }));
    const results = await generateVideoBatch({
      input: { items: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d" }] },
      endpoint,
      signal: new AbortController().signal,
      save,
      fetchImpl: impl,
      pollIntervalMs: 1,
      budgetMs: 5_000,
    });
    expect(results.some((result) => result.errorCode === "VIDEO_AUTH_FAILED")).toBe(true);
    expect(results.some((result) => result.status === "cancelled")).toBe(true);
    // Two workers may both have a request in flight; the queue stops there.
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("marks an aborted batch cancelled", async () => {
    const controller = new AbortController();
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/v1/videos")) return Response.json({ id: "job-abort" });
      controller.abort();
      return Response.json({ status: "queued" });
    });
    const results = await generateVideoBatch({
      input: { items: [{ prompt: "a" }, { prompt: "b" }] },
      endpoint,
      signal: controller.signal,
      save,
      fetchImpl: impl,
      pollIntervalMs: 1,
      budgetMs: 5_000,
    });
    expect(results.every((result) => result.status === "cancelled")).toBe(true);
    expect(results.every((result) => result.errorCode === "VIDEO_CANCELLED")).toBe(true);
  });

  it("requires a resolvable first frame when an item names one", async () => {
    const { impl } = stubFetch(() => Response.json({ id: "job-frame" }));
    const results = await generateVideoBatch({
      input: { items: [{ prompt: "with a frame", image: "frame.png" }] },
      endpoint,
      signal: new AbortController().signal,
      save,
      fetchImpl: impl,
      pollIntervalMs: 1,
      budgetMs: 5_000,
    });
    expect(results[0]).toMatchObject({ status: "failed", errorCode: "VIDEO_FRAME_UNAVAILABLE" });
  });
});

describe("video input validation", () => {
  it("expands counts and keeps the frame, the duration and the size", () => {
    expect(
      videoGenerationItems({
        items: [
          { prompt: " fox ", count: 2, image: " a.png ", durationSeconds: 6, size: "1280x720" },
        ],
      }),
    ).toEqual([
      { prompt: "fox", image: "a.png", durationSeconds: 6, size: "1280x720" },
      { prompt: "fox", image: "a.png", durationSeconds: 6, size: "1280x720" },
    ]);
  });

  it("rejects each out-of-range shape rather than truncating it", () => {
    const bad = [
      {},
      { items: [] },
      { items: [{ prompt: "" }] },
      { items: [{ prompt: "x", count: 0 }] },
      { items: [{ prompt: "x", count: 9 }] },
      { items: [{ prompt: "x", count: 5 }, { prompt: "y", count: 4 }] },
      { items: [{ prompt: "x", durationSeconds: 0 }] },
      { items: [{ prompt: "x", durationSeconds: 16 }] },
      { items: [{ prompt: "x", size: "big" }] },
      { items: [{ prompt: "x", image: "" }] },
      { items: [{ prompt: "x", lastFrame: "" }] },
      { items: [{ prompt: "x", image: " ", lastFrame: "a.png" }] },
      { items: [{ prompt: "x".repeat(32_001) }] },
      { items: new Array(9).fill({ prompt: "x" }) },
    ];
    for (const input of bad) {
      expect(() => videoGenerationItems(input)).toThrowError(invalidArgument());
    }
  });

  it("carries a last frame only alongside a first frame", () => {
    expect(videoGenerationItems({ items: [{ prompt: "x", image: "a.png", lastFrame: "b.png" }] }))
      .toEqual([{ prompt: "x", image: "a.png", lastFrame: "b.png" }]);
    expect(videoGenerationItems({ items: [{ prompt: "x" }] })).toEqual([{ prompt: "x" }]);
  });

  it("resolves the multipart names for both frames, ignoring unusable ones", () => {
    expect(resolveFrameFields()).toEqual(DEFAULT_VIDEO_FRAME_FIELDS);
    expect(resolveFrameFields({ first: "start_image", last: "end_image" })).toEqual({
      first: "start_image",
      last: "end_image",
    });
    // A name would be injected into the request's own body, so anything that is
    // not a plain form field name falls back instead of being trusted.
    for (const bad of ["", "a b", "a\"b", "a: b", "x".repeat(65)])
      expect(resolveFrameFields({ first: bad, last: bad })).toEqual(DEFAULT_VIDEO_FRAME_FIELDS);
    expect(resolveFrameFields({ first: "start_image" })).toEqual({
      first: "start_image",
      last: DEFAULT_VIDEO_FRAME_FIELDS.last,
    });
  });

  it("parses bindings, resolves candidates and identifies video models", () => {
    expect(parseVideoGenerationBinding(null)).toBeNull();
    expect(parseVideoGenerationBinding({ providerId: "p", modelId: "m" })).toEqual({
      providerId: "p",
      modelId: "m",
    });
    expect(() => parseVideoGenerationBinding({ providerId: "", modelId: "m" })).toThrowError(
      invalidArgument(),
    );
    expect(() => parseVideoGenerationBindings([{ providerId: "p" }])).toThrowError(invalidArgument());
    expect(parseVideoGenerationBindings(null)).toBeNull();
    expect(parseVideoGenerationBindings([{ providerId: "p", modelId: "m" }])).toEqual([
      { providerId: "p", modelId: "m" },
    ]);

    // Legacy single binding stays the only candidate when the list is absent.
    expect(videoGenerationBindings(undefined, { providerId: "p", modelId: "m" })).toEqual([
      { providerId: "p", modelId: "m" },
    ]);
    // A stored default that is no longer in the list is appended, not dropped.
    expect(
      videoGenerationBindings([{ providerId: "p", modelId: "a" }], {
        providerId: "q",
        modelId: "b",
      }),
    ).toEqual([
      { providerId: "p", modelId: "a" },
      { providerId: "q", modelId: "b" },
    ]);
    // Duplicates collapse on provider plus case-insensitive model id.
    expect(
      videoGenerationBindings(
        [
          { providerId: "p", modelId: "M" },
          { providerId: "p", modelId: "m" },
        ],
        null,
      ),
    ).toEqual([{ providerId: "p", modelId: "M" }]);

    expect(isVideoGenerationModel({ providerId: "p", modelId: "m" }, "p", "M")).toBe(true);
    expect(isVideoGenerationModel([{ providerId: "p", modelId: "m" }], "other", "m")).toBe(false);
    expect(isVideoGenerationModel(null, "p", "m")).toBe(false);
    expect(isVideoGenerationModel([{ providerId: "p", modelId: "m" }], undefined, "m")).toBe(false);
  });
});
