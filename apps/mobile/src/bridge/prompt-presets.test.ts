import { beforeEach, describe, expect, it } from "vitest";
import { deletePreset, listPresets, savePreset } from "./prompt-presets";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("prompt presets", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("starts empty", () => {
    expect(listPresets(storage)).toEqual([]);
  });

  it("saves a preset and reads it back", () => {
    const preset = savePreset("写作", "你是一个小说家。", storage);
    expect(preset.name).toBe("写作");
    expect(preset.text).toBe("你是一个小说家。");
    expect(preset.id.startsWith("pp_")).toBe(true);
    expect(listPresets(storage)).toHaveLength(1);
  });

  it("replaces a preset saved under the same name", () => {
    const first = savePreset("写作", "旧文本", storage);
    const second = savePreset("写作", "新文本", storage);
    expect(second.id).toBe(first.id);
    const rows = listPresets(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("新文本");
  });

  it("falls back to a name when none is given", () => {
    expect(savePreset("   ", "正文", storage).name).toBe("未命名提示词");
  });

  it("deletes by id and reports whether it removed anything", () => {
    const preset = savePreset("甲", "正文", storage);
    expect(deletePreset(preset.id, storage)).toBe(true);
    expect(listPresets(storage)).toEqual([]);
    expect(deletePreset(preset.id, storage)).toBe(false);
  });

  it("survives a corrupted shelf", () => {
    storage.setItem("qn.local.promptPresets", "{not json");
    expect(listPresets(storage)).toEqual([]);
    expect(savePreset("新", "正文", storage).name).toBe("新");
  });

  it("drops rows that are not presets", () => {
    storage.setItem("qn.local.promptPresets", JSON.stringify([{ id: "x" }, { id: "a", name: "n", text: "t", createdAt: "1", updatedAt: "1" }]));
    expect(listPresets(storage)).toHaveLength(1);
  });
});
