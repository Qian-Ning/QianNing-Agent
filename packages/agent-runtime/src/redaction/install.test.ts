import { createAssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installRedaction } from "./install.js";
import { RuleSet, builtinRules } from "./rules.js";
import { MappingStore } from "./store.js";
import { restoreStream } from "./stream.js";

const dirs: string[] = [];
const stores: MappingStore[] = [];

async function makeStore(): Promise<MappingStore> {
  const dir = await mkdtemp(join(tmpdir(), "redaction-install-"));
  dirs.push(dir);
  const store = new MappingStore({ path: join(dir, "mappings.json") });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const rules = new RuleSet({ rules: builtinRules() });

function fakeModels(seen: unknown[]): Models {
  return {
    streamSimple: async (_model: unknown, _context: unknown, options: { onPayload?: (p: unknown, m: unknown) => unknown }) => {
      seen.push(await options.onPayload?.({ messages: [{ role: "user", content: "call 13812345678" }] }, {}));
      return createAssistantMessageEventStream();
    },
  } as unknown as Models;
}

describe("installRedaction", () => {
  it("redacts the body before the adapter sees it", async () => {
    const store = await makeStore();
    const seen: unknown[] = [];
    const models = fakeModels(seen);
    installRedaction(models, { store, rules });

    await models.streamSimple({} as never, {} as never, {});

    expect(JSON.stringify(seen[0])).not.toContain("13812345678");
    expect(JSON.stringify(seen[0])).toContain("{{PHONE_");
  });

  it("explains the placeholder to the model in the same request", async () => {
    const store = await makeStore();
    const seen: unknown[] = [];
    const models = fakeModels(seen);
    installRedaction(models, { store, rules });

    await models.streamSimple({} as never, {} as never, {});

    const body = seen[0] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[0]?.content).toContain("Local privacy filter");
    expect(body.messages[1]?.content).toContain("{{PHONE_");
  });

  it("redacts what an earlier onPayload produced", async () => {
    const store = await makeStore();
    const seen: unknown[] = [];
    const models = fakeModels(seen);
    installRedaction(models, { store, rules });

    await models.streamSimple({} as never, {} as never, {
      onPayload: (payload: unknown) => {
        const body = payload as { messages: unknown[] };
        return {
          ...body,
          messages: [...body.messages, { role: "system", content: "fallback 13912345678" }],
        };
      },
    });

    expect(JSON.stringify(seen[0])).not.toContain("13912345678");
  });

  it("fails the request instead of sending an unredacted body", async () => {
    const store = await makeStore();
    const failures: unknown[] = [];
    const models = fakeModels([]);
    const broken = { findHits: () => { throw new Error("rule table broken"); } } as unknown as RuleSet;
    installRedaction(models, { store, rules: broken, onFailure: (error) => failures.push(error) });

    await expect(models.streamSimple({} as never, {} as never, {})).rejects.toThrow("rule table broken");
    expect(failures).toHaveLength(1);
  });
});

describe("restoreStream", () => {
  it("restores text split across deltas and in the final message", async () => {
    const store = await makeStore();
    const token = store.getOrInsert("PHONE", "13812345678");
    const source = createAssistantMessageEventStream();
    const restored = restoreStream(source, store);

    const partial = (text: string) =>
      ({ role: "assistant", content: [{ type: "text", text }] }) as never;
    const cut = Math.floor(token.length / 2);

    (async () => {
      source.push({ type: "text_delta", contentIndex: 0, delta: `call ${token.slice(0, cut)}`, partial: partial("") });
      source.push({ type: "text_delta", contentIndex: 0, delta: `${token.slice(cut)} now`, partial: partial("") });
      source.end(partial("call 13812345678 now"));
    })();

    let text = "";
    for await (const event of restored) {
      if (event.type === "text_delta") text += event.delta;
    }
    expect(text).toBe("call 13812345678 now");
    const settled = (await restored.result()) as { content: Array<{ text?: string }> };
    expect(settled.content[0]?.text).toBe("call 13812345678 now");
  });

  it("restores parsed tool arguments", async () => {
    const store = await makeStore();
    const token = store.getOrInsert("PHONE", "13812345678");
    const source = createAssistantMessageEventStream();
    const restored = restoreStream(source, store);

    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "dial", arguments: { number: token } }],
    } as never;

    (async () => {
      source.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "dial", arguments: { number: token } } as never,
        partial: message,
      });
      source.end(message);
    })();

    for await (const event of restored) {
      if (event.type === "toolcall_end") {
        expect((event.toolCall.arguments as { number: string }).number).toBe("13812345678");
      }
    }
  });
});
