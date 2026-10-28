import { HeadlessRunner, parseJob } from "./headless";
import { BrowserStore } from "./store";
import { FileStore } from "./file-store";

/**
 * Process entry point for the headless host (ADR 0338).
 *
 * Protocol, deliberately boring: one JSON job on stdin, one JSON event per line
 * on stdout, exit 0 when the turn completed and 1 when it did not. The Service
 * parses the stream; nothing here knows about Android.
 */
// The Service's runtime supplies `localStorage`; a bare Node test run does not.
// QN_HEADLESS_MEMORY=1 stands in with a throwaway store so the protocol can be
// exercised without a device.
if (process.env.QN_HEADLESS_MEMORY === "1" && typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
    clear: () => mem.clear(),
    key: (index: number) => [...mem.keys()][index] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

const chunks: string[] = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(String(chunk)));
process.stdin.on("end", () => {
  void main(chunks.join(""));
});

async function main(raw: string): Promise<void> {
  let job: ReturnType<typeof parseJob>;
  try {
    job = parseJob(raw);
  } catch (cause) {
    process.stdout.write(JSON.stringify({ kind: "done", ok: false, error: (cause as Error).message }) + "\n");
    process.exitCode = 1;
    return;
  }

  // A file the app drains on next launch, or the WebView's storage when this
  // runs inside the browser bundle (tests, local probes).
  const store = process.env.QN_HEADLESS_DATA ? new FileStore(process.env.QN_HEADLESS_DATA) : new BrowserStore();
  const runner = new HeadlessRunner(store, job.provider);
  const result = await runner.run(job, (event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  process.exitCode = result.ok ? 0 : 1;
}
