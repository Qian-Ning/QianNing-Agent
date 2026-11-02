import { afterEach, describe, expect, it } from "vitest";
import { PhoneBridge } from "./desktop-bridge";
import { MemoryStore } from "../agent/store";

/**
 * The composer's attach button used to answer "the phone host does not
 * implement composer/pickFiles yet". It has to hand the composer a token, then
 * the picked files in the shape the chips read — and a cancel has to look like
 * a cancel, not like an empty import.
 */
function bridge() {
  return new PhoneBridge({ store: new MemoryStore(), platform: "android", version: "2.2.0" });
}

function fakePicker(files: Array<{ name: string; path: string; size: number; mimeType: string | null }>) {
  const calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      Plugins: {
        QnFiles: {
          pick: async () => {
            calls.push("pick");
            return { files };
          },
          readDataUrl: async ({ path }: { path: string }) => ({
            kind: "image" as const,
            dataUrl: `data:image/png;base64,${path.length}`,
          }),
        },
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("composer attachments on the phone", () => {
  it("picks through the device and imports the same paths into the composer", async () => {
    const calls = fakePicker([
      {
        name: "notes.txt",
        path: "/data/user/0/app.qianning.agent/cache/picked/notes.txt",
        size: 12,
        mimeType: "text/plain",
      },
    ]);
    const bridgeUnderTest = bridge();

    const picked = await bridgeUnderTest.invoke("pi-desktop/composer/pickFiles");
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    const token = (picked.data as { token: string | null }).token;
    expect(token).toBeTruthy();
    expect(calls).toEqual(["pick"]);

    const imported = await bridgeUnderTest.invoke("pi-desktop/composer/importFiles", {
      sessionId: "s1",
      token,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const files = (imported.data as { files: Array<Record<string, unknown>> }).files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "notes.txt",
      path: "/data/user/0/app.qianning.agent/cache/picked/notes.txt",
      kind: "file",
      mimeType: "text/plain",
      size: 12,
    });
  });

  it("marks an image pick as an image so the composer previews it", async () => {
    fakePicker([
      { name: "shot.png", path: "/cache/picked/shot.png", size: 99, mimeType: "image/png" },
    ]);
    const bridgeUnderTest = bridge();
    const picked = await bridgeUnderTest.invoke("pi-desktop/composer/pickFiles");
    if (!picked.ok) throw new Error("pick failed");
    const token = (picked.data as { token: string | null }).token;
    const imported = await bridgeUnderTest.invoke("pi-desktop/composer/importFiles", { token });
    if (!imported.ok) throw new Error("import failed");
    const files = (imported.data as { files: Array<Record<string, unknown>> }).files;
    expect(files[0].kind).toBe("image");
  });

  it("answers a dismissed picker with a cancel, not an empty file list", async () => {
    fakePicker([]);
    const bridgeUnderTest = bridge();
    const picked = await bridgeUnderTest.invoke("pi-desktop/composer/pickFiles");
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.data).toMatchObject({ canceled: true, token: null });
  });

  it("does not reuse a token twice", async () => {
    fakePicker([{ name: "a.txt", path: "/cache/picked/a.txt", size: 1, mimeType: "text/plain" }]);
    const bridgeUnderTest = bridge();
    const picked = await bridgeUnderTest.invoke("pi-desktop/composer/pickFiles");
    if (!picked.ok) throw new Error("pick failed");
    const token = (picked.data as { token: string | null }).token;
    await bridgeUnderTest.invoke("pi-desktop/composer/importFiles", { token });
    const second = await bridgeUnderTest.invoke("pi-desktop/composer/importFiles", { token });
    if (!second.ok) throw new Error("second import failed");
    expect((second.data as { files: unknown[] }).files).toHaveLength(0);
  });

  it("previews a picked image through the device reader", async () => {
    fakePicker([]);
    const bridgeUnderTest = bridge();
    const result = await bridgeUnderTest.invoke("pi-desktop/fs/readImageDataUrl", {
      ref: "/cache/picked/shot.png",
      mimeType: "image/png",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ kind: "image" });
  });
});
