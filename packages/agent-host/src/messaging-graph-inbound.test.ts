import { describe, expect, it, vi } from "vitest";

import { createGraphClient, createGraphSubscriptionLease } from "./messaging-graph-client.js";
import {
  createGraphAdapter,
  createGraphValidation,
  createGraphVerifier,
  graphNotifications,
  graphText,
} from "./messaging-graph-inbound.js";

const CLIENT_STATE = "client-state-value";

function notification(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: "sub-1",
    clientState: CLIENT_STATE,
    changeType: "created",
    resource: "/teams/t1/channels/c1/messages/1699999999999",
    tenantId: "tenant-1",
    resourceData: { id: "1699999999999" },
    ...overrides,
  };
}

function body(...entries: Record<string, unknown>[]): string {
  return JSON.stringify({ value: entries });
}

function verifier() {
  return createGraphVerifier({ clientState: CLIENT_STATE });
}

describe("the Graph verifier", () => {
  it("accepts notifications carrying this channel's client state", async () => {
    const result = await verifier().verify(Buffer.from(body(notification())), {});
    expect(result).toMatchObject({ ok: true, deliveryId: "sub-1:1699999999999" });
  });

  it("refuses a batch where one entry disagrees", async () => {
    const result = await verifier().verify(
      Buffer.from(body(notification(), notification({ clientState: "someone-else" }))),
      {},
    );
    expect(result).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a body that is not a notification batch", async () => {
    const result = await verifier().verify(Buffer.from("{}"), {});
    expect(result).toMatchObject({ ok: false, reason: "missing-delivery-id" });
  });

  it("refuses when no client state is stored", async () => {
    expect(
      await createGraphVerifier({ clientState: " " }).verify(Buffer.from(body(notification())), {}),
    ).toMatchObject({ ok: false });
  });

  it("names a delivery id stable across a redelivery", async () => {
    const first = await verifier().verify(Buffer.from(body(notification())), {});
    const second = await verifier().verify(Buffer.from(body(notification())), {});
    expect(first.ok && first.deliveryId).toBe(second.ok && second.deliveryId);
  });
});

describe("the Graph validation", () => {
  it("echoes the token Graph posts", () => {
    const answer = createGraphValidation()(
      new URL("https://host.test/webhooks/microsoft-graph?validationToken=abc123"),
    );
    expect(answer).toMatchObject({ status: 200, body: "abc123" });
  });

  it("does not answer a request without a token", () => {
    expect(createGraphValidation()(new URL("https://host.test/webhooks/microsoft-graph"))).toBeNull();
  });
});

describe("the Graph adapter", () => {
  /** The projection always goes through `prepare`, which is typed optional. */
  async function project(get: unknown, raw: unknown) {
    const adapter = createGraphAdapter({ client: { get } as never });
    const prepared = await adapter.prepare?.(raw);
    if (!prepared) throw new Error("the adapter must project with a request");
    return prepared;
  }

  const message = {
    id: "1699999999999",
    messageType: "message",
    body: { contentType: "html", content: "<p>deploy <b>please</b></p>" },
    from: { user: { id: "user-1", displayName: "Ann" } },
  };

  it("fetches the message the notification names", async () => {
    const get = vi.fn(async () => message);
    const result = await project(get, JSON.parse(body(notification())) as unknown);
    expect(get).toHaveBeenCalledWith("/teams/t1/channels/c1/messages/1699999999999");
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      text: "deploy please",
      chatId: "/teams/t1/channels/c1",
      chatKind: "group",
      sender: { id: "user-1", name: "Ann" },
    });
  });

  it("filters a lifecycle event without fetching anything", async () => {
    const get = vi.fn();
    const result = await project(
      get,
      JSON.parse(body({ subscriptionId: "sub-1", lifecycleEvent: "reauthorizationRequired" })) as unknown,
    );
    expect(get).not.toHaveBeenCalled();
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("reauthorizationRequired");
  });

  it("filters a message whose fetch failed, without throwing", async () => {
    const get = vi.fn(async () => {
      throw new Error("HTTP 404 (NotFound)");
    });
    const result = await project(get, JSON.parse(body(notification())) as unknown);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("could not be read");
  });
});

describe("reading Graph's own shapes", () => {
  it("strips html into plain text", () => {
    expect(graphText("<p>hello</p><p>world</p>", "html")).toBe("hello\nworld");
    expect(graphText("plain", "text")).toBe("plain");
  });

  it("reads notifications out of a raw body", () => {
    expect(graphNotifications(body(notification()))).toHaveLength(1);
    expect(graphNotifications("not json")).toEqual([]);
  });
});

describe("the Graph client", () => {
  const tokenBody = { access_token: "tok", expires_in: 3600 };

  function fetchStub(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift() ?? { status: 200, json: {} };
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        json: async () => next.json ?? {},
        text: async () => next.text ?? "",
      } as unknown as Response;
    };
    return { fetch, calls };
  }

  it("mints a token and reuses it", async () => {
    const stub = fetchStub([{ json: tokenBody }, { json: { ok: true } }, { json: { ok: true } }]);
    const client = createGraphClient({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      fetch: stub.fetch as never,
      now: () => 0,
    });
    await client.get("/me");
    await client.get("/me");
    const tokenCalls = stub.calls.filter((call) => call.url.includes("/oauth2/v2.0/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("surfaces Graph's error code and message", async () => {
    const stub = fetchStub([
      { json: tokenBody },
      { status: 403, text: JSON.stringify({ error: { code: "Forbidden", message: "no scope" } }) },
    ]);
    const client = createGraphClient({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      fetch: stub.fetch as never,
      now: () => 0,
    });
    await expect(client.get("/teams")).rejects.toThrow(/403.*Forbidden.*no scope/);
  });

  it("refuses to build without a credential", () => {
    expect(() =>
      createGraphClient({ tenantId: "t", clientId: "", clientSecret: "s" }),
    ).toThrow(/tenant/);
  });
});

describe("the Graph subscription lease", () => {
  it("creates once and renews by patching", async () => {
    const post = vi.fn(async (_url: string, _body: unknown) => ({ id: "sub-9" }));
    const patch = vi.fn(async () => ({}));
    const lease = createGraphSubscriptionLease({
      client: { post, patch } as never,
      notificationUrl: "https://host.test/webhooks/microsoft-graph",
      resource: "/teams/t1/channels/c1/messages",
      clientState: CLIENT_STATE,
      now: () => 0,
    });

    const created = await lease.ensure();
    expect(created.id).toBe("sub-9");
    expect(post).toHaveBeenCalledTimes(1);
    const sent = post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent).toMatchObject({
      changeType: "created",
      resource: "/teams/t1/channels/c1/messages",
      clientState: CLIENT_STATE,
    });

    await lease.ensure();
    expect(patch).toHaveBeenCalledTimes(1);
    lease.stop();
  });

  it("creates a new subscription when the held one is gone", async () => {
    const post = vi
      .fn(async (_url: string, _body: unknown) => ({ id: "sub-1" }))
      .mockResolvedValueOnce({ id: "sub-1" })
      .mockResolvedValueOnce({ id: "sub-2" });
    const patch = vi.fn(async () => {
      throw new Error("HTTP 404 (NotFound)");
    });
    const failures: string[] = [];
    const lease = createGraphSubscriptionLease({
      client: { post, patch } as never,
      notificationUrl: "https://host.test/webhooks/microsoft-graph",
      resource: "/teams/t1/channels/c1/messages",
      clientState: CLIENT_STATE,
      onFailure: (error) => failures.push(error),
      now: () => 0,
    });

    await lease.ensure();
    const renewed = await lease.ensure();
    expect(renewed.id).toBe("sub-2");
    expect(failures[0]).toContain("404");
    lease.stop();
  });

  it("refuses to build without a client state", () => {
    expect(() =>
      createGraphSubscriptionLease({
        client: {} as never,
        notificationUrl: "https://host.test/x",
        resource: "/x",
        clientState: " ",
      }),
    ).toThrow(/client state/);
  });
});
