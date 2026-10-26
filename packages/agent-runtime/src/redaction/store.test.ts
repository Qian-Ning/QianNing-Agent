import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MappingStore } from "./store.js";

const dirs: string[] = [];
const stores: MappingStore[] = [];

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "redaction-store-"));
  dirs.push(dir);
  return join(dir, "mappings.json");
}

function track(store: MappingStore): MappingStore {
  stores.push(store);
  return store;
}

afterEach(async () => {
  // Let every pending atomic write finish before the directory goes away:
  // on Windows an open handle turns the cleanup into EBUSY.
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("MappingStore", () => {
  it("issues the same token for the same secret", async () => {
    const store = track(new MappingStore({ path: await storePath() }));
    const first = store.getOrInsert("PHONE", "13812345678");
    const second = store.getOrInsert("PHONE", "13812345678");
    expect(second).toBe(first);
    expect(store.size()).toBe(1);
  });

  it("issues different tokens for different secrets", async () => {
    const store = track(new MappingStore({ path: await storePath() }));
    expect(store.getOrInsert("PHONE", "13812345678")).not.toBe(store.getOrInsert("PHONE", "13912345678"));
  });

  it("restores a token it issued and refuses one it did not", async () => {
    const store = track(new MappingStore({ path: await storePath() }));
    const token = store.getOrInsert("APIKEY", "sk-ant-secret-value-123");
    expect(store.lookup(token)).toBe("sk-ant-secret-value-123");
    expect(store.lookup("{{PHONE_01J0000000000000000000000}}")).toBeUndefined();
  });

  it("writes the table with owner-only permissions and reads it back", async () => {
    const path = await storePath();
    const store = track(new MappingStore({ path }));
    const token = store.getOrInsert("PHONE", "13812345678");
    await store.flush();

    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const written = JSON.parse(await readFile(path, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(written.entries)).toHaveLength(1);

    const reopened = new MappingStore({ path });
    expect(await reopened.load()).toEqual({ loaded: 1, evicted: 0 });
    expect(reopened.lookup(token)).toBe("13812345678");
  });

  it("drops entries past their ttl on load", async () => {
    const path = await storePath();
    let now = 1_000_000;
    const store = track(new MappingStore({ path, ttlDays: 1, now: () => now }));
    store.getOrInsert("PHONE", "13812345678");
    await store.flush();

    now += 2 * 24 * 60 * 60 * 1000;
    const reopened = new MappingStore({ path, ttlDays: 1, now: () => now });
    expect(await reopened.load()).toEqual({ loaded: 0, evicted: 1 });
  });

  it("evicts the oldest entries beyond the cap", async () => {
    let now = 1_000_000;
    const store = track(new MappingStore({ path: await storePath(), cap: 2, now: () => now }));
    const first = store.getOrInsert("PHONE", "13800000001");
    now += 1;
    store.getOrInsert("PHONE", "13800000002");
    now += 1;
    store.getOrInsert("PHONE", "13800000003");
    expect(store.size()).toBe(2);
    expect(store.lookup(first)).toBeUndefined();
  });

  it("treats a corrupt file as an empty table", async () => {
    const path = await storePath();
    await writeFile(path, "{not json", "utf8");
    const store = track(new MappingStore({ path }));
    expect(await store.load()).toEqual({ loaded: 0, evicted: 0 });
  });

  it("masks secrets in the preview", async () => {
    const store = track(new MappingStore({ path: await storePath() }));
    store.getOrInsert("PHONE", "13812345678");
    const [row] = store.preview();
    expect(row?.masked).not.toContain("12345678");
    expect(row?.masked.startsWith("138")).toBe(true);
  });
});
