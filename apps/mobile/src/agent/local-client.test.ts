/**
 * The screens talk RACP. This checks that the in-process Host answers the same
 * paths a desktop Host answers, so the phone's agent needs no special-case UI.
 */

import { describe, expect, it } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Model } from "@earendil-works/pi-ai";
import { LocalAgentHost } from "./host";
import { LocalClient } from "./local-client";
import { MemoryStore } from "./store";
import type { HostEvent } from "../lib/racp";

function build(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
  const faux = createFauxCore({ models: [{ id: "scripted" }], tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const host = new LocalAgentHost(
    new MemoryStore(),
    { baseUrl: "https://example.invalid/v1", apiKey: "k", modelId: "scripted" },
    { stream: faux.streamSimple, model: faux.getModel() as Model<"openai-completions"> },
  );
  return new LocalClient(host);
}

describe("the local Host speaks RACP", () => {
  it("creates a session, lists it, and deletes it", async () => {
    const client = build([fauxAssistantMessage("hi")]);

    const created = await client.call<{ session: { id: string } }>("/v1/sessions", {
      method: "POST",
      body: { title: "phone" },
    });
    const id = created.session.id;
    expect(id).toBeTruthy();

    const listed = await client.call<{ sessions: { id: string; title: string }[] }>("/v1/sessions");
    expect(listed.sessions.map((row) => row.title)).toEqual(["phone"]);

    await client.call("/v1/sessions/" + id + ":delete", { method: "POST", body: {} });
    const after = await client.call<{ sessions: unknown[] }>("/v1/sessions");
    expect(after.sessions).toHaveLength(0);
  });

  it("streams a turn and returns history the way the wire does", async () => {
    const client = build([
      fauxAssistantMessage(fauxToolCall("write_file", { path: "a.txt", content: "x" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const created = await client.call<{ session: { id: string } }>("/v1/sessions", {
      method: "POST",
      body: {},
    });
    const id = created.session.id;

    const events: HostEvent[] = [];
    const stop = client.stream(id, { onEvent: (event) => events.push(event), onState: () => {} });

    await client.call("/v1/sessions/" + id + "/turns", {
      method: "POST",
      body: { input: { text: "write a file" } },
    });
    stop();

    expect(events[0]?.kind).toBe("turn.started");
    expect(events.at(-1)?.kind).toBe("turn.completed");
    expect(events.some((event) => event.kind === "item.delta")).toBe(true);

    const history = await client.call<
      { itemId: string; itemType?: string; status?: string; event?: { message?: { role?: string } } }[]
    >("/v1/sessions/" + id + "/history");
    expect(history).toHaveLength(4);
    expect(history[0]?.event?.message?.role).toBe("user");
    expect(history.filter((row) => row.itemType === "tool")).toHaveLength(1);
  });

  it("refuses a diff instead of pretending there is one", async () => {
    const client = build([]);
    const created = await client.call<{ session: { id: string } }>("/v1/sessions", {
      method: "POST",
      body: {},
    });

    await expect(client.call("/v1/sessions/" + created.session.id + "/diff")).rejects.toThrow(
      /no project workspace/,
    );
  });
});

describe("capabilities beyond the wire", () => {
  it("renames through the client so the list label follows", async () => {
    const client = build([fauxAssistantMessage("hi")]);
    const created = await client.call<{ session: { id: string } }>("/v1/sessions", {
      method: "POST",
      body: { title: "old" },
    });

    await client.renameSession?.(created.session.id, "new name");
    const listed = await client.call<{ sessions: { id: string; title: string }[] }>("/v1/sessions");

    expect(listed.sessions.find((row) => row.id === created.session.id)?.title).toBe("new name");
  });

  it("refuses to rename a session that is not there", async () => {
    const client = build([fauxAssistantMessage("hi")]);
    await expect(client.renameSession?.("missing", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the conversation alive across a model change", async () => {
    const client = build([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const created = await client.call<{ session: { id: string } }>("/v1/sessions", {
      method: "POST",
      body: { title: "swap" },
    });
    const path = "/v1/sessions/" + created.session.id + "/turns";
    await client.call(path, { method: "POST", body: { input: { text: "one" } } });

    // A model swap drops the cached loop; the transcript must survive it.
    await client.configure?.({ modelId: "other-model", thinking: "high" });
    await client.call(path, { method: "POST", body: { input: { text: "two" } } });

    const rows = await client.call<{ itemId: string }[]>(
      "/v1/sessions/" + created.session.id + "/history",
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});
