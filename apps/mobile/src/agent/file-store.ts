import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SnapshotStore, emptySnapshot, parseSnapshot, type StoreSnapshot } from "./json-store";
import type { StoredMessage, StoredSession } from "./store";

/**
 * The headless runtime's store: a snapshot file the app drains on next launch.
 *
 * Node-only on purpose — the WebView build never imports this file. Writes go
 * through a temp file and a rename so a kill mid-write cannot leave a truncated
 * transcript that the app would then refuse to parse.
 */
export class FileStore extends SnapshotStore {
  constructor(private readonly path: string) {
    super(load(path));
  }

  override writeSession(session: StoredSession): void {
    super.writeSession(session);
    this.save();
  }

  override writeMessages(sessionId: string, messages: StoredMessage[]): void {
    super.writeMessages(sessionId, messages);
    this.save();
  }

  override writeValue(key: string, value: string): void {
    super.writeValue(key, value);
    this.save();
  }

  save(): void {
    const target = this.path;
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(this.snapshot()), "utf8");
    renameSync(temp, target);
  }
}

function load(path: string): StoreSnapshot {
  if (!existsSync(path)) return emptySnapshot();
  try {
    return parseSnapshot(readFileSync(path, "utf8")) ?? emptySnapshot();
  } catch {
    // A corrupt file must not stop a scheduled task from running; the run's
    // own transcript will overwrite it on first write.
    return emptySnapshot();
  }
}
