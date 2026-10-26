import { describe, expect, it } from "vitest";

import { formatRacpCursor } from "@pi-desktop/shared";

import { bindRacpHttp } from "./http-binding.js";
import { OWNER_TOKEN, harness } from "./test-harness.js";

const HTTP_BINDINGS = ["RACP-WS", "RACP-HTTP"] as const;

async function withBinding<T>(
  run: (address: string, h: Awaited<ReturnType<typeof harness>>) => Promise<T>,
  limits: { maxFailedAttempts?: number; lockoutMs?: number } = {},
): Promise<T> {
  const h = await harness({ bindings: HTTP_BINDINGS });
  const binding = await bindRacpHttp({
    server: h.server,
    authenticator: h.authenticator,
    port: 0,
    log: () => undefined,
    ...limits,
  });
  try {
    return await run(`http://127.0.0.1:${binding.address.port}`, h);
  } finally {
    await binding.close();
  }
}

function auth(token = OWNER_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("RACP-HTTP over a loopback socket", () => {
  it("serves a list operation and answers with the operation's result", async () => {
    await withBinding(async (base, h) => {
      const response = await fetch(`${base}/v1/sessions`, { headers: auth() });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result?: { sessions?: unknown[] } };
      expect(Array.isArray(body.result?.sessions)).toBe(true);
      expect(h.server.connectionCount()).toBe(1);
    });
  });

  it("carries a POST body into the operation", async () => {
    await withBinding(async (base) => {
      const response = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ projectId: "proj_1", title: "from http" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result?: { session?: Record<string, unknown> } };
      // The body reached the operation: a session came back, not an empty result.
      expect(body.result?.session).toBeTruthy();
      expect(Object.keys(body.result?.session ?? {}).length).toBeGreaterThan(0);
    });
  });

  it("streams events over SSE with the cursor as the event id", async () => {
    await withBinding(async (base, h) => {
      const controller = new AbortController();
      const stream = await fetch(`${base}/v1/sessions/s1/events`, {
        headers: auth(),
        signal: controller.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");

      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readUntil = async (needle: string): Promise<string> => {
        while (!buffer.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream closed before the expected frame");
          buffer += decoder.decode(value, { stream: true });
        }
        return buffer;
      };

      await readUntil("event: ready");

      await fetch(`${base}/v1/sessions/s1/turns`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ input: { text: "hi" }, context: { requestId: "r_http_1" } }),
      });
      h.host.ingest({ sessionId: "s1", turnId: "rt_http_1", ts: 1, event: { type: "agent_start" } });

      const text = await readUntil("agent_start");
      const idLine = text.split("\n").find((line) => line.startsWith("id: "));
      expect(idLine).toBeDefined();
      const cursor = idLine!.slice(4).trim();
      expect(cursor).toMatch(/^.+:\d+$/);
      expect(text).toContain(formatRacpCursor({ epoch: cursor.slice(0, cursor.lastIndexOf(":")), sequence: Number(cursor.slice(cursor.lastIndexOf(":") + 1)) }));

      controller.abort();
    });
  });

  it("opens the host-scope event stream on its own path", async () => {
    await withBinding(async (base) => {
      const controller = new AbortController();
      const stream = await fetch(`${base}/v1/events`, { headers: auth(), signal: controller.signal });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!buffer.includes("event: ready")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the host stream closed before it was ready");
        buffer += decoder.decode(value, { stream: true });
      }
      controller.abort();
    });
  });

  it("refuses a request without a credential", async () => {
    await withBinding(async (base) => {
      const response = await fetch(`${base}/v1/sessions`);
      expect(response.status).toBe(401);
    });
  });

  it("refuses a credential placed in the URL", async () => {
    await withBinding(async (base) => {
      const response = await fetch(`${base}/v1/sessions?token=${OWNER_TOKEN}`);
      expect(response.status).toBe(400);
    });
  });

  it("answers an unknown route with 404 rather than an operation error", async () => {
    await withBinding(async (base) => {
      const response = await fetch(`${base}/v1/nope`, { headers: auth() });
      expect(response.status).toBe(404);
    });
  });
});

describe("RACP-HTTP failed-attempt lockout", () => {
  const wrong = { authorization: "Bearer race_00000000000000000000000000000000" };

  const failTimes = async (base: string, count: number): Promise<number[]> => {
    const codes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await fetch(`${base}/v1/sessions`, { headers: wrong });
      codes.push(response.status);
    }
    return codes;
  };

  it("locks a peer out after the configured number of failed attempts", async () => {
    await withBinding(async (base) => {
      expect(await failTimes(base, 3)).toEqual([401, 401, 401]);
      const locked = await fetch(`${base}/v1/sessions`, { headers: auth() });
      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).toBeTruthy();
    }, { maxFailedAttempts: 3 });
  });

  it("lets the peer back in once the lockout expires", async () => {
    await withBinding(async (base) => {
      await failTimes(base, 2);
      expect((await fetch(`${base}/v1/sessions`, { headers: auth() })).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect((await fetch(`${base}/v1/sessions`, { headers: auth() })).status).toBe(200);
    }, { maxFailedAttempts: 2, lockoutMs: 60 });
  });

  it("clears the failure count after a successful authentication", async () => {
    await withBinding(async (base) => {
      await failTimes(base, 2);
      expect((await fetch(`${base}/v1/sessions`, { headers: auth() })).status).toBe(200);
      await failTimes(base, 2);
      // Two more failures after a success must not reach a limit of four.
      expect((await fetch(`${base}/v1/sessions`, { headers: auth() })).status).toBe(200);
    }, { maxFailedAttempts: 4 });
  });
});

describe("a non-loopback bind", () => {
  it("is refused without TLS, because the protocol has no plaintext LAN mode", async () => {
    const h = await harness({ bindings: HTTP_BINDINGS });
    await expect(
      bindRacpHttp({
        server: h.server,
        authenticator: h.authenticator,
        host: "0.0.0.0",
        port: 0,
        log: () => undefined,
      }),
    ).rejects.toThrow(/requires TLS/);
  });
});
