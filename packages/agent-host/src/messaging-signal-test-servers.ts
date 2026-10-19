/**
 * A fake signal-cli HTTP bridge, for tests.
 *
 * It is a *real* HTTP server on `127.0.0.1:0` speaking the documented JSON-RPC
 * shape, because the rules this channel holds are wire rules: the method name,
 * the params object, the request body, the status code, the answer's shape. A
 * double that returned pre-built objects would skip every one of them.
 *
 * Test support only; nothing imports this from production code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake bridge received, as it arrived. */
export type RecordedSignalRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
  /** The parsed body, or `null` when it was not JSON. */
  json: Record<string, unknown> | null;
};

/** One `send` the bridge accepted, with its params exactly as posted. */
export type RecordedSignalSend = {
  account: string;
  recipient?: string;
  groupId?: string;
  message: string;
  /** The raw params object, for a test that wants to assert on all of it. */
  params: Record<string, unknown>;
};

export type FakeBridgeMode = "ok" | "rpc-error" | "malformed" | "not-json" | "http-500" | "redirect";

/**
 * The fake bridge.
 *
 * `mode` decides how the *next* answer is written, so a test can prove the loop
 * survives one bad answer and then reads a good one:
 *
 * - `ok` — a normal JSON-RPC answer;
 * - `rpc-error` — `{ error: { code, message } }` with HTTP 200;
 * - `malformed` — a JSON object with neither `result` nor `error`;
 * - `not-json` — an HTML error page with HTTP 200;
 * - `http-500` — a server error;
 * - `redirect` — a 302, which the client must not follow.
 *
 * A `receive` call with an empty queue answers `[]` immediately unless
 * `holdReceive` is set, in which case the request is held until
 * [`releaseHeldReceive`] is called — that is how an abort or a deadline is
 * exercised without sleeping.
 */
export class FakeSignalBridge {
  readonly requests: RecordedSignalRequest[] = [];
  readonly sent: RecordedSignalSend[] = [];
  /** Envelopes the next `receive` calls will hand over, in order. */
  readonly envelopes: unknown[] = [];
  /** How many `receive` calls have been answered. */
  receives = 0;
  mode: FakeBridgeMode = "ok";
  /** A bearer token the bridge demands, when set. */
  requiredToken: string | null = null;
  private server: Server | null = null;
  private port = 0;
  private held: ServerResponse | null = null;

  /** The base URL, valid after `start()`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The RPC path every call must use. */
  get rpcPath(): string {
    return "/api/v1/rpc";
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const held = this.held;
    this.held = null;
    held?.destroy();
    this.heldSend?.destroy();
    this.heldSend = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  /** Queue one envelope for the next `receive`. */
  push(envelope: unknown): void {
    this.envelopes.push(envelope);
  }

  /** Hold the next `receive` open until `releaseHeldReceive()`. */
  holdNextReceive = false;
  /** Hold the next `send` open, so the client's deadline has something to fire on. */
  holdNextSend = false;
  private heldSend: ServerResponse | null = null;

  /** Answer a held `receive` with whatever is queued. */
  releaseHeldReceive(): void {
    const held = this.held;
    this.held = null;
    if (held) this.answerReceive(held);
  }

  /** Every JSON-RPC method the client posted, in order. */
  get methods(): string[] {
    return this.requests
      .map((request) => request.json)
      .filter((body): body is Record<string, unknown> => body !== null)
      .map((body) => (typeof body.method === "string" ? body.method : ""))
      .filter((method) => method !== "");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(body) as unknown;
      json = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      json = null;
    }
    this.requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body,
      json,
    });

    if (this.requiredToken !== null) {
      const header = request.headers.authorization;
      if (header !== `Bearer ${this.requiredToken}`) {
        this.writeJson(response, 401, { jsonrpc: "2.0", error: { code: 401, message: "unauthorized" } });
        return;
      }
    }

    const mode = this.mode;
    if (mode === "http-500") {
      this.writeJson(response, 500, { error: "boom" });
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { Location: "http://example.invalid/rpc" });
      response.end();
      return;
    }
    if (mode === "not-json") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html><body>a proxy's error page</body></html>");
      return;
    }
    if (mode === "malformed") {
      this.writeJson(response, 200, { jsonrpc: "2.0", id: json?.id ?? null });
      return;
    }
    if (mode === "rpc-error") {
      this.writeJson(response, 200, {
        jsonrpc: "2.0",
        id: json?.id ?? null,
        error: { code: -1, message: "the account is not registered" },
      });
      return;
    }

    const method = typeof json?.method === "string" ? json.method : "";
    const params =
      typeof json?.params === "object" && json.params !== null && !Array.isArray(json.params)
        ? (json.params as Record<string, unknown>)
        : {};

    if (method === "send") {
      const account = typeof params.account === "string" ? params.account : "";
      const message = typeof params.message === "string" ? params.message : "";
      this.sent.push({
        account,
        ...(typeof params.recipient === "string" ? { recipient: params.recipient } : {}),
        ...(typeof params.groupId === "string" ? { groupId: params.groupId } : {}),
        message,
        params,
      });
      if (this.holdNextSend) {
        // Held after recording, so a test can see the request arrived and then
        // prove the client's deadline fires against a bridge that went quiet.
        this.holdNextSend = false;
        this.heldSend = response;
        return;
      }
      this.writeJson(response, 200, {
        jsonrpc: "2.0",
        id: json?.id ?? null,
        result: { timestamp: 1_760_000_000_000 + this.sent.length },
      });
      return;
    }

    if (method === "receive") {
      this.receives += 1;
      if (this.holdNextReceive) {
        this.holdNextReceive = false;
        this.held = response;
        return;
      }
      this.answerReceive(response);
      return;
    }

    this.writeJson(response, 200, {
      jsonrpc: "2.0",
      id: json?.id ?? null,
      error: { code: -32601, message: `unknown method ${method}` },
    });
  }

  private answerReceive(response: ServerResponse): void {
    const batch = this.envelopes.splice(0, this.envelopes.length);
    this.writeJson(response, 200, { jsonrpc: "2.0", id: "signal-rpc", result: batch });
  }

  private writeJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}

/** One envelope wrapper in the documented shape: `{ account, envelope }`. */
export function signalEnvelope(options: {
  from?: string;
  text?: string;
  timestamp?: number;
  groupId?: string;
  account?: string;
  sourceUuid?: string;
}): Record<string, unknown> {
  const stamp = options.timestamp ?? 1_760_000_000_000;
  return {
    account: options.account ?? "+15550000000",
    envelope: {
      sourceNumber: options.from ?? "+15551110000",
      ...(options.sourceUuid ? { sourceUuid: options.sourceUuid } : {}),
      source: options.from ?? "+15551110000",
      sourceDevice: 1,
      timestamp: stamp,
      dataMessage: {
        timestamp: stamp,
        message: options.text ?? "hello",
        ...(options.groupId
          ? { groupInfo: { groupId: options.groupId, type: "DELIVER" } }
          : {}),
      },
    },
  };
}

/** An envelope carrying a read receipt and nothing else. */
export function signalReceiptEnvelope(options: { from?: string; timestamp?: number } = {}): unknown {
  return {
    account: "+15550000000",
    envelope: {
      sourceNumber: options.from ?? "+15551110000",
      timestamp: options.timestamp ?? 1_760_000_000_001,
      receiptMessage: { isDelivery: false, isRead: true, timestamps: [1_760_000_000_000] },
    },
  };
}

/** An envelope carrying a typing notification and nothing else. */
export function signalTypingEnvelope(options: { from?: string; timestamp?: number } = {}): unknown {
  return {
    account: "+15550000000",
    envelope: {
      sourceNumber: options.from ?? "+15551110000",
      timestamp: options.timestamp ?? 1_760_000_000_002,
      typingMessage: { action: "STARTED", timestamp: 1_760_000_000_000 },
    },
  };
}

/** An envelope for a message this channel itself sent (a sync frame). */
export function signalOwnSyncEnvelope(options: { text?: string; timestamp?: number } = {}): unknown {
  return {
    account: "+15550000000",
    envelope: {
      sourceNumber: "+15550000000",
      sourceDevice: 2,
      timestamp: options.timestamp ?? 1_760_000_000_003,
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15551110000",
          timestamp: options.timestamp ?? 1_760_000_000_003,
          message: options.text ?? "a reply this channel sent",
        },
      },
    },
  };
}
