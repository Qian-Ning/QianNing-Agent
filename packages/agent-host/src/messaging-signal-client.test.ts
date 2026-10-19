/**
 * The signal-cli bridge client, against a real HTTP server on loopback.
 *
 * Every assertion here is about the wire: the path, the JSON-RPC method, the
 * params object, the answer's shape, and what the client does when the answer is
 * not one. Nothing is mocked at the class boundary, so a change to the request
 * body fails a test rather than passing a fake.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SIGNAL_DEFAULT_BRIDGE_URL,
  SIGNAL_RPC_PATH,
  SignalRpcClient,
  readSignalRpcAnswer,
  signalRpcUrl,
} from "./messaging-signal-client.js";
import { FakeSignalBridge, signalEnvelope } from "./messaging-signal-test-servers.js";

const ACCOUNT = "+15550000000";

let bridge: FakeSignalBridge;
let clients: SignalRpcClient[] = [];

function client(options: { token?: string; timeoutMs?: number; receiveTimeoutS?: number } = {}) {
  const built = new SignalRpcClient({
    bridgeUrl: bridge.url,
    account: ACCOUNT,
    ...(options.token !== undefined ? { token: options.token } : {}),
    requestTimeoutMs: options.timeoutMs ?? 5_000,
    receiveTimeoutS: options.receiveTimeoutS ?? 1,
  });
  clients.push(built);
  return built;
}

beforeEach(async () => {
  bridge = new FakeSignalBridge();
  await bridge.start();
  clients = [];
});

afterEach(async () => {
  await bridge.close();
});

describe("signalRpcUrl", () => {
  it("appends the documented JSON-RPC path to the default bridge base", () => {
    const result = signalRpcUrl(SIGNAL_DEFAULT_BRIDGE_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(`http://127.0.0.1:8080${SIGNAL_RPC_PATH}`);
  });

  it("accepts a base that already names the path, without doubling it", () => {
    const result = signalRpcUrl("http://127.0.0.1:8080/api/v1/rpc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe("http://127.0.0.1:8080/api/v1/rpc");
  });

  it("refuses plaintext to a host that is not this machine", () => {
    const result = signalRpcUrl("http://signal.example.org:8080");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("HTTPS");
  });

  it("refuses a URL carrying a user name or password", () => {
    expect(signalRpcUrl("https://user:pass@bridge.example.org").ok).toBe(false);
  });

  it("refuses a scheme that is not HTTP", () => {
    expect(signalRpcUrl("ftp://127.0.0.1:8080").ok).toBe(false);
  });
});

describe("readSignalRpcAnswer", () => {
  const read = (value: unknown) => readSignalRpcAnswer(value, (result) => result as number);

  it("refuses a body with neither result nor error", () => {
    const answer = read({ jsonrpc: "2.0", id: 1 });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("malformed");
  });

  it("refuses a result the method does not promise", () => {
    const answer = readSignalRpcAnswer({ result: "not-an-array" }, (result) =>
      Array.isArray(result) ? (result as unknown[]) : null,
    );
    expect(answer.ok).toBe(false);
  });

  it("reports the bridge's own error code", () => {
    const answer = read({ error: { code: -1, message: "not registered" } });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("rpc-error");
    expect(answer.code).toBe(-1);
  });
});

describe("SignalRpcClient.send", () => {
  it("posts a JSON-RPC send with the account, recipient and message", async () => {
    const answer = await client().send({ recipient: "+15551110000" }, "hello there");
    expect(answer.ok).toBe(true);

    expect(bridge.requests).toHaveLength(1);
    const request = bridge.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(SIGNAL_RPC_PATH);
    const body = request.json!;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("send");
    expect(typeof body.id).toBe("string");
    expect(body.params).toEqual({
      account: ACCOUNT,
      recipient: "+15551110000",
      message: "hello there",
    });
    expect(bridge.sent).toEqual([
      {
        account: ACCOUNT,
        recipient: "+15551110000",
        message: "hello there",
        params: { account: ACCOUNT, recipient: "+15551110000", message: "hello there" },
      },
    ]);
  });

  it("names a group with groupId instead of recipient", async () => {
    const answer = await client().send({ groupId: "abc123==" }, "to the group");
    expect(answer.ok).toBe(true);
    expect(bridge.sent[0]!.groupId).toBe("abc123==");
    expect(bridge.sent[0]!.recipient).toBeUndefined();
    expect(answer.ok && answer.result.timestamp).toBe(1_760_000_000_001);
  });

  it("sends the bearer token in the header and never in the body", async () => {
    const answer = await client({ token: "bridge-token-xyz" }).send(
      { recipient: "+15551110000" },
      "hello",
    );
    expect(answer.ok).toBe(true);
    const request = bridge.requests[0]!;
    expect(request.headers.authorization).toBe("Bearer bridge-token-xyz");
    expect(request.body).not.toContain("bridge-token-xyz");
  });

  it("reports a refused credential as an HTTP status, without the token", async () => {
    bridge.requiredToken = "expected";
    const answer = await client({ token: "wrong" }).send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("http-status");
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer)).not.toContain("wrong");
  });

  it("reports a 500 as an HTTP status rather than an empty success", async () => {
    bridge.mode = "http-500";
    const answer = await client().send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.status).toBe(500);
  });

  it("does not follow a redirect", async () => {
    bridge.mode = "redirect";
    const answer = await client().send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("http-status");
    expect(answer.error).toContain("redirect");
  });

  it("reports a non-JSON body as malformed", async () => {
    bridge.mode = "not-json";
    const answer = await client().send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("malformed");
  });

  it("reports an unreachable bridge as unreachable", async () => {
    const built = client();
    await bridge.close();
    const answer = await built.send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("unreachable");
    expect(answer.error).toContain("signal-cli");
  });

  it("abandons a send the bridge never answers", async () => {
    bridge.holdNextSend = true;
    const built = client({ timeoutMs: 1_000 });
    const started = Date.now();
    const answer = await built.send({ recipient: "+15551110000" }, "hi");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    // The request did arrive: the failure is the answer's absence, not the call's.
    expect(bridge.sent).toHaveLength(1);
  });

  it("stops on the caller's abort", async () => {
    const built = client({ timeoutMs: 5_000 });
    const controller = new AbortController();
    controller.abort();
    const answer = await built.send({ recipient: "+15551110000" }, "hi", controller.signal);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("aborted");
    expect(bridge.requests).toHaveLength(0);
  });
});

describe("SignalRpcClient.receive", () => {
  it("posts a receive with the long-poll timeout in seconds", async () => {
    bridge.push(signalEnvelope({ text: "first" }));
    const answer = await client({ receiveTimeoutS: 7 }).receive();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.result.envelopes).toHaveLength(1);
    const body = bridge.requests[0]!.json!;
    expect(body.method).toBe("receive");
    expect(body.params).toEqual({ account: ACCOUNT, timeout: 7 });
  });

  it("answers an empty array when the bridge has nothing", async () => {
    const answer = await client().receive();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.result.envelopes).toEqual([]);
  });

  it("reports a JSON-RPC refusal with the bridge's message", async () => {
    bridge.mode = "rpc-error";
    const answer = await client().receive();
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("rpc-error");
    expect(answer.code).toBe(-1);
    expect(answer.error).toContain("not registered");
  });

  it("reports a body that is not JSON as malformed", async () => {
    bridge.mode = "not-json";
    const answer = await client().receive();
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe("malformed");
  });

  it("probes the bridge with a one-second receive", async () => {
    const result = await client().probe();
    expect(result.ok).toBe(true);
    const body = bridge.requests[0]!.json!;
    expect(body.method).toBe("receive");
    expect(body.params).toEqual({ account: ACCOUNT, timeout: 1 });
  });
});
