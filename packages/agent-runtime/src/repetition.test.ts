import { describe, expect, it } from "vitest";

import { findRepetition, trailingRepetition, watchRepetition } from "./repetition.js";

const PARAGRAPH =
  "这个函数的边界条件还没覆盖到，重复调用会把状态写坏，需要先补一个守卫，再补一条回归用例，然后才能继续往下改。";

const NEWLINE = String.fromCharCode(10);
const BLANK_LINE = NEWLINE + NEWLINE;

describe("findRepetition", () => {
  it("catches the same paragraph repeated", () => {
    const text = Array.from({ length: 6 }, () => PARAGRAPH).join(BLANK_LINE);
    const hit = findRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.period).toBe(PARAGRAPH.length + BLANK_LINE.length);
  });

  it("catches a short unit repeated many times", () => {
    const hit = findRepetition("<|end|>".repeat(40));
    expect(hit).not.toBeNull();
    expect(hit?.period).toBe(7);
  });

  it("leaves ordinary prose alone", () => {
    expect(findRepetition(`第一行说明。${NEWLINE}第二行是别的话。${NEWLINE}第三行继续新的内容。`)).toBeNull();
  });

  it("does not mistake a numbered list for a loop", () => {
    const list = Array.from({ length: 40 }, (_, index) => `${index + 1}. 第 ${index + 1} 项待办`).join(NEWLINE);
    expect(findRepetition(list)).toBeNull();
  });

  it("does not mistake a status table for a loop", () => {
    const rows = Array.from(
      { length: 30 },
      (_, index) => `| tests/${index + 1}.test.ts | ${index % 7 === 0 ? "FAIL" : "PASS"} |`,
    ).join(NEWLINE);
    expect(findRepetition(rows)).toBeNull();
  });

  it("does not mistake a long hex run of the same digit for a loop", () => {
    expect(findRepetition(`sha256: ${"0".repeat(64)}`)).toBeNull();
  });
});

describe("trailingRepetition", () => {
  it("reports a region that ends the text", () => {
    const hit = trailingRepetition(`前面是正常内容。${NEWLINE}${"abcd".repeat(60)}`);
    expect(hit).not.toBeNull();
    expect(hit?.period).toBe(4);
    expect(hit?.span).toBeGreaterThanOrEqual(200);
  });

  it("stays quiet while the text is not looping", () => {
    expect(trailingRepetition("一段正常的中文说明，长度不够也不重复。")).toBeNull();
  });

  it("ignores a loop followed by real text", () => {
    expect(trailingRepetition(`${"ab".repeat(200)}结论：以上是重复内容。`)).toBeNull();
  });
});

describe("watchRepetition", () => {
  it("sees a loop that arrives in chunks", () => {
    const watch = watchRepetition();
    const chunk = "重复的句子。".repeat(4);
    let hit: unknown = null;
    for (let index = 0; index < 12 && !hit; index += 1) hit = watch(chunk);
    expect(hit).not.toBeNull();
  });

  it("stays quiet for normal streaming text", () => {
    const watch = watchRepetition();
    const chunks = ["第一段。", "第二段写点别的。", "第三段也不同。", "收尾。"];
    expect(chunks.map((chunk) => watch(chunk)).every((hit) => hit === null)).toBe(true);
  });
});
