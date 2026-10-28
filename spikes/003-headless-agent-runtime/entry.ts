// localStorage shim: the phone host persists through it, plain node has none.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;

const { LocalAgentHost } = await import("../../apps/mobile/src/agent/host");
const { BrowserStore } = await import("../../apps/mobile/src/agent/store");

const host = new LocalAgentHost(new BrowserStore(), {
  baseUrl: "http://127.0.0.1:4601/v1",
  apiKey: "test-key",
  modelId: "fake-model",
});

const session = host.createSession("headless spike");
const seen: string[] = [];
let answer = "";
host.subscribe(session.id, (event) => {
  seen.push(event.kind);
  if (event.kind === "item.completed") {
    answer += JSON.stringify(event.payload ?? {}).slice(0, 400) + String.fromCharCode(10);
  }
});

await host.send(session.id, "say hello");
const done = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000);
  const stop = host.subscribe(session.id, (event) => {
    if (event.kind === "turn.completed" || event.kind === "turn.failed") {
      clearTimeout(timer);
      stop();
      resolve(event.kind === "turn.completed");
    }
  });
});

console.log(
  JSON.stringify(
    {
      completed: seen.includes("turn.completed"),
      browserGlobals: { window: typeof window, document: typeof document },
      answer,
      seen,
      history: host.history(session.id).length,
    },
    null,
    2,
  ),
);
process.exit(done ? 0 : 1);
