import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSessions,
  listComputers,
  normalizeAddress,
  pairComputer,
  removeComputer,
} from "./computers";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const plugins: Record<string, unknown> = {};
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: { Plugins: plugins },
    localStorage,
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = localStorage;
});

function stubRemote(overrides: {
  certificate?: { pem: string; fingerprint: string };
  request?: (options: { path: string; method: string; token: string }) => {
    status: number;
    body: string;
  };
}) {
  const plugins = (globalThis as unknown as { window: { Capacitor: { Plugins: Record<string, unknown> } } })
    .window.Capacitor.Plugins;
  const request = vi.fn(async (options: { path: string; method: string; token: string }) =>
    overrides.request
      ? overrides.request(options)
      : { status: 200, body: JSON.stringify({ result: { sessions: [] } }) },
  );
  plugins.QnRemote = {
    fetchCertificate: vi.fn(async () => overrides.certificate ?? { pem: "-----BEGIN CERTIFICATE-----", fingerprint: "AA:BB" }),
    request,
  };
  return { request };
}

describe("addresses", () => {
  it("accepts what a person reads off the desktop", () => {
    expect(normalizeAddress(" 192.168.1.8:7317 ")).toBe("https://192.168.1.8:7317");
    expect(normalizeAddress("https://192.168.1.8:7317/")).toBe("https://192.168.1.8:7317");
  });

  it("refuses a plaintext address instead of silently upgrading it", () => {
    expect(() => normalizeAddress("http://192.168.1.8:7317")).toThrow(/https/);
  });

  it("insists on the port, because the desktop never listens on 443", () => {
    expect(() => normalizeAddress("192.168.1.8")).toThrow(/port/);
  });
});

describe("pairing", () => {
  it("keeps the certificate it pinned and replaces a repeat pairing", async () => {
    stubRemote({ certificate: { pem: "PEM-ONE", fingerprint: "AA:BB" } });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    stubRemote({ certificate: { pem: "PEM-TWO", fingerprint: "CC:DD" } });
    await pairComputer({ url: "https://192.168.1.8:7317", token: "pdt1.two" });

    const computers = listComputers();
    expect(computers).toHaveLength(1);
    expect(computers[0]?.pem).toBe("PEM-TWO");
    expect(computers[0]?.token).toBe("pdt1.two");
    expect(computers[0]?.label).toBe("192.168.1.8");
  });

  it("will not pair without a token", async () => {
    stubRemote({});
    await expect(pairComputer({ url: "192.168.1.8:7317", token: "  " })).rejects.toThrow(/token/);
    expect(listComputers()).toHaveLength(0);
  });

  it("survives a corrupted store instead of throwing on open", () => {
    store.set("qn.remote.computers", "{not json");
    expect(listComputers()).toEqual([]);
  });

  it("forgets a computer", async () => {
    stubRemote({});
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    expect(removeComputer("https://192.168.1.8:7317")).toBe(true);
    expect(listComputers()).toEqual([]);
  });
});

describe("talking to a paired computer", () => {
  it("sends the pinned certificate and the device token on every call", async () => {
    const remote = stubRemote({});
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await fetchSessions(listComputers()[0]!);

    const call = remote.request.mock.calls[0]?.[0] as unknown as {
      url: string;
      path: string;
      token: string;
      pem: string;
    };
    expect(call.url).toBe("https://192.168.1.8:7317");
    expect(call.path).toBe("/v1/sessions");
    expect(call.token).toBe("pdt1.one");
    expect(call.pem).toBe("-----BEGIN CERTIFICATE-----");
  });

  it("reads the sessions envelope and sorts newest first", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            sessions: [
              { id: "s1", title: "Older", updatedAt: 100 },
              { id: "s2", title: "Newer", updatedAt: 900 },
              { id: "s3", updatedAt: 500 },
              { nope: true },
            ],
          },
        }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    const sessions = await fetchSessions(listComputers()[0]!);

    expect(sessions.map((session) => session.id)).toEqual(["s2", "s3", "s1"]);
    expect(sessions[1]?.title).toBe("未命名会话");
  });

  it("turns a rejected token into a sentence, not a status code", async () => {
    stubRemote({ request: () => ({ status: 401, body: "" }) });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await expect(fetchSessions(listComputers()[0]!)).rejects.toThrow(/device token/);
  });
});
