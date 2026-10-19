/**
 * The local API endpoint, driven over real HTTP against a real listener on
 * `127.0.0.1:0`.
 *
 * Every assertion is about the wire: the status code, whether the reply seam
 * was reached, whether a body was buffered, whether the socket is gone after
 * `stop`. The reply seam is a plain function here, so "the agent was never
 * called" is a count, not an inference.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  API_SERVER_DEFAULT_MAX_BODY_BYTES,
  API_SERVER_DEFAULT_MAX_CONCURRENT,
  API_SERVER_DEFAULT_REQUEST_TIMEOUT_MS,
  API_SERVER_HEALTH_PATH,
  API_SERVER_MESSAGE_PATH,
  MESSAGING_API_SERVER_FORMAT,
  MESSAGING_API_SERVER_FORMAT_VERSION,
  MESSAGING_API_SERVER_SECTION,
  MESSAGING_API_SERVER_TOKEN_SECRET_REF,
  apiServerTokenMatches,
  createApiServerEndpoint,
  readApiServerSettings,
  type ApiServerEndpoint,
  type ApiServerReply,
  type ApiServerSettings,
} from "./messaging-api-server.js";
import { isLoopbackBindAddress } from "./messaging-ingress-receiver.js";

const TOKEN = "test-token-3f5b9c1d";

function settings(overrides: Partial<ApiServerSettings> = {}): ApiServerSettings {
  return {
    enabled: true,
    port: 0,
    bindAddress: "127.0.0.1",
    allowNonLoopback: false,
    tokenSecretRef: MESSAGING_API_SERVER_TOKEN_SECRET_REF,
    maxBodyBytes: API_SERVER_DEFAULT_MAX_BODY_BYTES,
    requestTimeoutMs: API_SERVER_DEFAULT_REQUEST_TIMEOUT_MS,
    maxConcurrent: API_SERVER_DEFAULT_MAX_CONCURRENT,
    ...overrides,
  };
}

let endpoints: ApiServerEndpoint[] = [];

/**
 * A port `fetch` is willing to use.
 *
 * `undici` refuses a fixed list of ports before it opens a socket ("bad port"),
 * and a port the operating system hands out can land in that list — which turns
 * a correct listener into a `fetch failed`. The tests therefore choose their own
 * port outside the list and retry the rare collision, rather than binding `0`
 * and hoping.
 */
function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

async function start(
  reply: ApiServerReply,
  overrides: Partial<ApiServerSettings> = {},
  token = TOKEN,
): Promise<{ endpoint: ApiServerEndpoint; base: string }> {
  const fixed = overrides.port;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const endpoint = createApiServerEndpoint({
      settings: settings({ port: fixed ?? randomPort(), ...overrides }),
      token,
      reply,
    });
    try {
      const address = await endpoint.start();
      endpoints.push(endpoint);
      return { endpoint, base: `http://127.0.0.1:${address.port}` };
    } catch (error) {
      if (fixed !== undefined || !/EADDRINUSE/.test(String(error))) throw error;
    }
  }
  throw new Error("no usable port for the test listener");
}

async function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${API_SERVER_MESSAGE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  for (const endpoint of endpoints) await endpoint.stop();
  endpoints = [];
});

describe("the local API endpoint", () => {
  it("answers a health probe without a token, and reaches no agent", async () => {
    let calls = 0;
    const { base } = await start(async () => {
      calls += 1;
      return "unused";
    });
    const response = await fetch(`${base}${API_SERVER_HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toBe(0);
  });

  it("refuses a request with no token and never calls the agent", async () => {
    let calls = 0;
    const { base } = await start(async () => {
      calls += 1;
      return "should not happen";
    });
    const answer = await post(base, { message: "hello" });
    expect(answer.status).toBe(401);
    expect(answer.json).toEqual({ error: "unauthorized" });
    expect(calls).toBe(0);
  });

  it("refuses a wrong token and never calls the agent", async () => {
    let calls = 0;
    const { base } = await start(async () => {
      calls += 1;
      return "should not happen";
    });
    const answer = await post(base, { message: "hello" }, { authorization: "Bearer not-the-token" });
    expect(answer.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("refuses a token presented under the wrong scheme", async () => {
    const { base } = await start(async () => "answer");
    const answer = await post(base, { message: "hello" }, { authorization: `Basic ${TOKEN}` });
    expect(answer.status).toBe(401);
  });

  it("delivers the message to the agent seam and returns the reply", async () => {
    const seen: Array<{ message: string; conversationId: string | null }> = [];
    const { base } = await start(async (request) => {
      seen.push(request);
      return `the agent says: ${request.message}`;
    });
    const answer = await post(base, { message: "hello there" }, { authorization: `Bearer ${TOKEN}` });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ reply: "the agent says: hello there" });
    expect(seen).toEqual([{ message: "hello there", conversationId: null }]);
  });

  it("passes a conversation id through untouched", async () => {
    const seen: Array<string | null> = [];
    const { base } = await start(async (request) => {
      seen.push(request.conversationId);
      return "ok";
    });
    const answer = await post(
      base,
      { message: "hi", conversationId: "session-42" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(answer.status).toBe(200);
    expect(seen).toEqual(["session-42"]);
  });

  it("accepts the token under x-api-key as well", async () => {
    const { base } = await start(async () => "ok");
    const answer = await post(base, { message: "hi" }, { "x-api-key": TOKEN });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ reply: "ok" });
  });

  it("rejects an oversized body before the agent is called", async () => {
    let calls = 0;
    const { base } = await start(async () => {
      calls += 1;
      return "unused";
    }, { maxBodyBytes: 2048 });
    const answer = await post(
      base,
      { message: "x".repeat(4096) },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(answer.status).toBe(413);
    expect(calls).toBe(0);
  });

  it("rejects an oversized chunked body as it arrives", async () => {
    let calls = 0;
    const { base } = await start(async () => {
      calls += 1;
      return "unused";
    }, { maxBodyBytes: 2048 });
    // A stream body has no declared length, so the running total is what stops it.
    const response = await fetch(`${base}${API_SERVER_MESSAGE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message":"'));
          controller.enqueue(new TextEncoder().encode("y".repeat(4096)));
          controller.close();
        },
      }),
      // @ts-expect-error -- required by undici for a streamed request body
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });

  it("rejects malformed JSON and a missing message", async () => {
    const { base } = await start(async () => "unused");
    const malformed = await post(base, "{not json", { authorization: `Bearer ${TOKEN}` });
    expect(malformed.status).toBe(400);
    const empty = await post(base, { message: "   " }, { authorization: `Bearer ${TOKEN}` });
    expect(empty.status).toBe(400);
    const wrongType = await post(
      base,
      { message: "hi", conversationId: 7 },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(wrongType.status).toBe(400);
  });

  it("rejects an unknown path and the wrong method", async () => {
    const { base } = await start(async () => "unused");
    const missing = await fetch(`${base}/v1/other`);
    expect(missing.status).toBe(404);
    const wrongMethod = await fetch(`${base}${API_SERVER_MESSAGE_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(wrongMethod.status).toBe(405);
  });

  it("caps concurrency instead of queueing without a bound", async () => {
    // A holder, not a bare variable: TypeScript narrows a `let` assigned only
    // from inside a callback to its initial `null`.
    const gate: { release: (() => void) | null } = { release: null };
    const { base } = await start(
      async () =>
        new Promise<string>((resolve) => {
          gate.release = () => resolve("slow answer");
        }),
      { maxConcurrent: 1, requestTimeoutMs: 5_000 },
    );
    const first = post(base, { message: "first" }, { authorization: `Bearer ${TOKEN}` });
    // The first request is admitted synchronously in `serve`; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await post(base, { message: "second" }, { authorization: `Bearer ${TOKEN}` });
    expect(second.status).toBe(429);
    gate.release?.();
    const firstAnswer = await first;
    expect(firstAnswer.status).toBe(200);
    expect(firstAnswer.json).toEqual({ reply: "slow answer" });
  });

  it("answers 504 when the agent does not answer in time", async () => {
    const { base } = await start(
      () => new Promise<string>(() => {}),
      { requestTimeoutMs: 40 },
    );
    const answer = await post(base, { message: "hi" }, { authorization: `Bearer ${TOKEN}` });
    expect(answer.status).toBe(504);
  });

  it("answers 500 when the agent fails", async () => {
    const { base } = await start(async () => {
      throw new Error("the runtime is gone");
    });
    const answer = await post(base, { message: "hi" }, { authorization: `Bearer ${TOKEN}` });
    expect(answer.status).toBe(500);
    expect(answer.json).toEqual({ error: "the agent did not answer" });
  });

  it("tears the listener down on stop", async () => {
    const { endpoint, base } = await start(async () => "ok");
    expect(endpoint.address()).not.toBeNull();
    await endpoint.stop();
    expect(endpoint.address()).toBeNull();
    await expect(fetch(`${base}${API_SERVER_HEALTH_PATH}`)).rejects.toThrow();
  });

  it("refuses to start without a token", async () => {
    const endpoint = createApiServerEndpoint({
      settings: settings(),
      token: "   ",
      reply: async () => "unused",
    });
    await expect(endpoint.start()).rejects.toThrow(/no token is stored/);
    expect(endpoint.address()).toBeNull();
  });

  it("reports a port clash with the operating system's reason and leaves nothing bound", async () => {
    const first = await start(async () => "ok");
    const port = first.endpoint.address()?.port ?? 0;
    const audit: string[] = [];
    const failing = createApiServerEndpoint({
      settings: settings({ port }),
      token: TOKEN,
      reply: async () => "unused",
      audit: (entry) => {
        if (entry.kind === "bind-failed") audit.push(entry.error);
      },
    });
    await expect(failing.start()).rejects.toThrow(/EADDRINUSE|address already in use/i);
    expect(failing.address()).toBeNull();
    expect(failing.status().state).toBe("failed");
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatch(/EADDRINUSE|address already in use/i);
  });

  it("refuses a non-loopback bind without the opt-in, then refuses it anyway on plain HTTP", async () => {
    const withoutOptIn = createApiServerEndpoint({
      settings: settings({ bindAddress: "0.0.0.0" }),
      token: TOKEN,
      reply: async () => "unused",
    });
    await expect(withoutOptIn.start()).rejects.toThrow(/binds loopback unless/);

    const withOptIn = createApiServerEndpoint({
      settings: settings({ bindAddress: "0.0.0.0", allowNonLoopback: true }),
      token: TOKEN,
      reply: async () => "unused",
    });
    await expect(withOptIn.start()).rejects.toThrow(/plain HTTP/);
    expect(withOptIn.address()).toBeNull();
  });
});

describe("the record reader", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    [MESSAGING_API_SERVER_SECTION]: {
      format: MESSAGING_API_SERVER_FORMAT,
      version: MESSAGING_API_SERVER_FORMAT_VERSION,
      enabled: true,
      port: 7842,
      bindAddress: "127.0.0.1",
      ...overrides,
    },
  });

  it("reads an enabled record and clamps every number", () => {
    const read = readApiServerSettings(record({ maxBodyBytes: 10, maxConcurrent: 0 }));
    expect(read).not.toBeNull();
    expect(read?.port).toBe(7842);
    expect(read?.maxBodyBytes).toBe(1_024);
    expect(read?.maxConcurrent).toBe(1);
    expect(read?.tokenSecretRef).toBe(MESSAGING_API_SERVER_TOKEN_SECRET_REF);
  });

  it("returns null for absent, disabled and foreign records", () => {
    expect(readApiServerSettings({})).toBeNull();
    expect(readApiServerSettings(record({ enabled: false }))).toBeNull();
    expect(readApiServerSettings(record({ format: "someone-elses" }))).toBeNull();
    expect(readApiServerSettings(record({ version: 99 }))).toBeNull();
  });
});

describe("the token comparison", () => {
  it("accepts only the stored value", () => {
    expect(apiServerTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(apiServerTokenMatches("", TOKEN)).toBe(false);
    expect(apiServerTokenMatches(null, TOKEN)).toBe(false);
    expect(apiServerTokenMatches(TOKEN, "  ")).toBe(false);
    // A different value of the same length and a different length both fail,
    // and both take the same path: two digests are compared either way.
    expect(apiServerTokenMatches("test-token-3f5b9c1e", TOKEN)).toBe(false);
    expect(apiServerTokenMatches(`${TOKEN}extra`, TOKEN)).toBe(false);
  });
});

describe("loopback classification", () => {
  it("accepts the three exact loopback spellings and nothing that only starts like one", () => {
    expect(isLoopbackBindAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackBindAddress("::1")).toBe(true);
    expect(isLoopbackBindAddress("[::1]")).toBe(true);
    expect(isLoopbackBindAddress("localhost")).toBe(true);
    expect(isLoopbackBindAddress("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackBindAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackBindAddress("192.168.1.10")).toBe(false);
  });
});
