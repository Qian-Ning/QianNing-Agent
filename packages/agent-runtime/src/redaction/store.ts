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
import { synthesizeStandIn, usesFakeValue } from "./fake.js";

/** First 16 hex characters of SHA-256: collision-free at any realistic table size. */
export function mappingKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 16);
}

interface Entry {
  token: string;
  /**
   * What the provider actually sees. A phone number is replaced by a
   * same-shaped stand-in, so the model has no privacy-filter tell to react to;
   * every other type keeps the typed placeholder.
   */
  display: string;
  plaintext: string;
  type: string;
  createdAt: number;
  lastSeen: number;
}

interface FileShape {
  version: 2;
  entries: Record<string, Entry>;
}

export interface MappingStoreOptions {
  path: string;
  /** Entries untouched for this long are dropped on load. 0 disables expiry. */
  ttlDays?: number;
  /** Hard cap; the oldest entries are evicted beyond it. */
  cap?: number;
  now?: () => number;
  /** Injectable randomness, so tests get deterministic stand-ins. */
  random?: () => number;
}

export class MappingStore {
  private readonly entries = new Map<string, Entry>();
  private readonly byToken = new Map<string, Entry>();
  private readonly byDisplay = new Map<string, Entry>();
  /** Every value the table must never reuse: plaintexts and issued stand-ins. */
  private readonly known = new Set<string>();
  private displayCache?: string[];
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: MappingStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
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
      // A table written before stand-ins existed has no `display`; the token was
      // the display then. Phone numbers are migrated to a stand-in on load so an
      // upgrade stops showing the placeholder to the model, while the token stays
      // in the table for restoring messages that already quoted it.
      let display = typeof entry.display === "string" && entry.display.length > 0 ? entry.display : entry.token;
      let migrated = false;
      if (usesFakeValue(entry.type) && display === entry.token) {
        display = synthesizeStandIn(entry.type, (candidate) => this.known.has(candidate), this.random) ?? entry.token;
        migrated = true;
      }
      const normalized: Entry = { ...entry, display };
      this.entries.set(key, normalized);
      this.byToken.set(normalized.token, normalized);
      this.byDisplay.set(normalized.display, normalized);
      this.known.add(normalized.plaintext);
      this.known.add(normalized.display);
      if (migrated) this.dirty = true;
    }
    if (evicted > 0) this.dirty = true;
    return { loaded: this.entries.size, evicted };
  }

  /** What the provider should see for `plaintext`, issuing a mapping on first sight. */
  getOrInsert(type: string, plaintext: string): string {
    const key = mappingKey(plaintext);
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(existing);
      return existing.display;
    }
    const token = formatPlaceholder({ type, id: newPlaceholderId(this.now()) });
    // A stand-in must never equal a value this table has seen — reusing a real
    // number as the fake for a different one would restore the wrong value.
    const display = synthesizeStandIn(type, (candidate) => this.known.has(candidate), this.random) ?? token;
    const entry: Entry = {
      token,
      display,
      plaintext,
      type,
      createdAt: this.now(),
      lastSeen: this.now(),
    };
    this.entries.set(key, entry);
    this.byToken.set(token, entry);
    this.byDisplay.set(display, entry);
    this.known.add(plaintext);
    this.known.add(display);
    this.displayCache = undefined;
    this.evict();
    this.dirty = true;
    this.scheduleWrite();
    return display;
  }

  /**
   * The plaintext a token or stand-in stands for, or undefined when this table
   * never issued it. A model may quote an example value verbatim; that is not a
   * value to restore, it is text to leave alone.
   */
  lookup(value: string): string | undefined {
    const entry = this.byToken.get(value) ?? this.byDisplay.get(value);
    if (!entry) return undefined;
    this.touch(entry);
    return entry.plaintext;
  }

  /** True when `value` is a stand-in this table issued for some other value. */
  isDisplay(value: string): boolean {
    return this.byDisplay.has(value);
  }

  /** Stand-ins only: what the provider saw for a value that is not a token. */
  displayValues(): string[] {
    if (this.displayCache) return this.displayCache;
    this.displayCache = [...this.byDisplay.values()]
      .filter((entry) => entry.display !== entry.token)
      .map((entry) => entry.display);
    return this.displayCache;
  }

  /**
   * Replaces issued stand-ins in `text`, longest first.
   *
   * Longest first matters because a stand-in may be a prefix of another; without
   * it a shorter match would rewrite the head of a longer one.
   */
  restoreDisplays(text: string): string {
    const values = this.displayValues();
    if (values.length === 0 || text.length === 0) return text;
    let output = text;
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      if (!output.includes(value)) continue;
      const plaintext = this.lookup(value);
      if (plaintext === undefined) continue;
      output = output.split(value).join(plaintext);
    }
    return output;
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
    // Every index has to go, not only the two that answer a lookup: a table
    // whose `byDisplay` still holds rows keeps restoring stand-ins from memory
    // after the user asked for them gone, and `isDisplay` keeps skipping values
    // the next walk should treat as new.
    this.entries.clear();
    this.byToken.clear();
    this.byDisplay.clear();
    this.known.clear();
    this.displayCache = undefined;
    this.dirty = true;
    return this.scheduleWrite();
  }

  /** Count and age of the rows, without exposing a single plaintext. */
  stats(): { count: number; oldest: number | null; newest: number | null } {
    if (this.entries.size === 0) return { count: 0, oldest: null, newest: null };
    let oldest = Number.POSITIVE_INFINITY;
    let newest = 0;
    for (const entry of this.entries.values()) {
      if (entry.createdAt < oldest) oldest = entry.createdAt;
      if (entry.createdAt > newest) newest = entry.createdAt;
    }
    return { count: this.entries.size, oldest, newest };
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
      this.byDisplay.delete(entry.display);
      this.displayCache = undefined;
    }
  }

  /**
   * Marks an entry as recently used and schedules a coalesced write.
   *
   * A hit has to reach the disk as well as the memory: expiry is decided from
   * `lastSeen` on load, so a table that only wrote on first sight would expire
   * exactly the values the user keeps pasting. The write is delayed because one
   * turn restores many tokens, and each restore would otherwise rewrite the
   * whole snapshot.
   */
  private touch(entry: Entry): void {
    entry.lastSeen = this.now();
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.scheduleWrite();
    }, 1_000);
    this.flushTimer.unref?.();
  }

  /** Coalesces a burst of inserts into one write. */
  private scheduleWrite(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot: FileShape = { version: 2, entries: Object.fromEntries(this.entries) };
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
