import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMappingStore } from "./session-store.js";

const dirs: string[] = [];
const stores: ReturnType<typeof openMappingStore>[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "redaction-session-"));
  dirs.push(dir);
  return dir;
}

async function open(dir: string) {
  const pending = openMappingStore(dir);
  stores.push(pending);
  return pending;
}

afterEach(async () => {
  for (const pending of stores.splice(0)) {
    const store = await pending;
    await store.flush();
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe("openMappingStore", () => {
  it("creates the directory and starts empty", async () => {
    const dir = join(await tempDir(), "not-yet-there");
    const store = await open(dir);
    expect(store.size()).toBe(0);
  });

  it("carries tokens across sessions that share the directory", async () => {
    const dir = await tempDir();
    const first = await open(dir);
    const token = first.getOrInsert("PHONE", "13812345678");
    await first.flush();

    const second = await open(dir);
    expect(second.lookup(token)).toBe("13812345678");
  });

  it("opens empty when the table on disk is corrupt", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "mappings.json"), "{not json", "utf8");
    const store = await open(dir);
    expect(store.size()).toBe(0);
    expect(store.getOrInsert("PHONE", "13812345678")).toMatch(/^1[3-9][0-9]{9}$/);
  });

  it("writes the table beside the session directory it was given", async () => {
    const dir = await tempDir();
    const store = await open(dir);
    store.getOrInsert("PHONE", "13812345678");
    await store.flush();
    const written = JSON.parse(await readFile(join(dir, "mappings.json"), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(written.entries)).toHaveLength(1);
  });
});
