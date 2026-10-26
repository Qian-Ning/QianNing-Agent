/**
 * The token ↔ plaintext table.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **The same secret always produces the same token.** A user pasting the
 *    same key in two turns must not produce two placeholders, or the model
 *    reads one credential as two unrelated ones and the restore step has to
 *    track both.
 * 2. **The file on disk is not a readable list of secrets.** Entries are keyed
 *    by a truncated SHA-256 of the plaintext, and the file is written with
 *    owner-only permissions. The plaintext side still exists — a restore needs
 *    it — but nothing about the file's structure invites casual reading.
 *
 * Writes are debounced and atomic (tmp + rename), and a corrupt file is treated
 * as an empty table rather than an error: losing the mapping costs one turn's
 * readability, while throwing would break the request that triggered it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatPlaceholder, newPlaceholderId, parsePlaceholder } from "./placeholder.js";

/** First 16 hex characters of SHA-256: collision-free at any realistic table size. */
export function mappingKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 16);
}

interface Entry {
  token: string;
  plaintext: string;
  type: string;
  createdAt: number;
  lastSeen: number;
}

interface FileShape {
  version: 1;
  entries: Record<string, Entry>;
}

export interface MappingStoreOptions {
  path: string;
  /** Entries untouched for this long are dropped on load. 0 disables expiry. */
  ttlDays?: number;
  /** Hard cap; the oldest entries are evicted beyond it. */
  cap?: number;
  now?: () => number;
}

export class MappingStore {
  private readonly entries = new Map<string, Entry>();
  private readonly byToken = new Map<string, Entry>();
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(options: MappingStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    const ttlDays = options.ttlDays ?? 90;
    this.ttlMs = ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : 0;
    this.cap = options.cap ?? 10_000;
  }

  /** Reads the table, dropping expired and unparseable entries. Never throws. */
  async load(): Promise<{ loaded: number; evicted: number }> {
    let raw: FileShape;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8")) as FileShape;
    } catch {
      return { loaded: 0, evicted: 0 };
    }
    const now = this.now();
    let evicted = 0;
    for (const [key, entry] of Object.entries(raw.entries ?? {})) {
      if (!entry?.token || typeof entry.plaintext !== "string" || !parsePlaceholder(entry.token)) {
        evicted += 1;
        continue;
      }
      if (this.ttlMs > 0 && now - (entry.lastSeen ?? 0) > this.ttlMs) {
        evicted += 1;
        continue;
      }
      this.entries.set(key, entry);
      this.byToken.set(entry.token, entry);
    }
    if (evicted > 0) this.dirty = true;
    return { loaded: this.entries.size, evicted };
  }

  /** The token for `plaintext`, issuing one on first sight. */
  getOrInsert(type: string, plaintext: string): string {
    const key = mappingKey(plaintext);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastSeen = this.now();
      this.dirty = true;
      return existing.token;
    }
    const entry: Entry = {
      token: formatPlaceholder({ type, id: newPlaceholderId(this.now()) }),
      plaintext,
      type,
      createdAt: this.now(),
      lastSeen: this.now(),
    };
    this.entries.set(key, entry);
    this.byToken.set(entry.token, entry);
    this.evict();
    this.dirty = true;
    this.scheduleWrite();
    return entry.token;
  }

  /**
   * The plaintext a token stands for, or undefined when this table never issued
   * it. A model may quote an example token verbatim; that is not a value to
   * restore, it is text to leave alone.
   */
  lookup(token: string): string | undefined {
    const entry = this.byToken.get(token);
    if (!entry) return undefined;
    entry.lastSeen = this.now();
    this.dirty = true;
    return entry.plaintext;
  }

  size(): number {
    return this.entries.size;
  }

  /** Rows for a settings surface; the plaintext is masked. */
  preview(limit = 50): Array<{ token: string; type: string; masked: string; createdAt: number }> {
    return [...this.entries.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((entry) => ({
        token: entry.token,
        type: entry.type,
        masked: maskSecret(entry.plaintext),
        createdAt: entry.createdAt,
      }));
  }

  clear(): Promise<void> {
    this.entries.clear();
    this.byToken.clear();
    this.dirty = true;
    return this.scheduleWrite();
  }

  flush(): Promise<void> {
    if (this.dirty) this.scheduleWrite();
    return this.writing;
  }

  private evict(): void {
    if (this.entries.size <= this.cap) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key, entry] of oldest.slice(0, this.entries.size - this.cap)) {
      this.entries.delete(key);
      this.byToken.delete(entry.token);
    }
  }

  /** Coalesces a burst of inserts into one write. */
  private scheduleWrite(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot: FileShape = { version: 1, entries: Object.fromEntries(this.entries) };
    const body = JSON.stringify(snapshot);
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.path);
    };
    // A failed write must not fail the turn that triggered it: the in-memory
    // table stays authoritative and the next write retries the whole snapshot.
    // Disk trouble is an expected external failure here, not a bug to surface
    // as an unhandled rejection.
    this.writing = this.writing.then(run, run).catch(() => undefined);
    return this.writing;
  }
}

/** `138****8000` — recognizable in a list, useless if the screen is photographed. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "•".repeat(Math.max(4, value.length));
  return `${value.slice(0, 3)}${"•".repeat(Math.min(8, value.length - 7))}${value.slice(-4)}`;
}
