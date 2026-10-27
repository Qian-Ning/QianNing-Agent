import { describe, expect, it } from "vitest";
import { splitBlocksForTest } from "./markdown";

describe("markdown blocks", () => {
  it("keeps a fenced block intact, language and all", () => {
    const blocks = splitBlocksForTest("before\n\n```ts\nconst a = 1;\n```\n\nafter");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "before" },
      { kind: "code", lang: "ts", text: "const a = 1;" },
      { kind: "paragraph", text: "after" },
    ]);
  });

  it("does not treat a fence inside a paragraph as a block boundary", () => {
    const blocks = splitBlocksForTest("```\nplain\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", text: "plain" });
  });

  it("collects consecutive bullets into one list", () => {
    const blocks = splitBlocksForTest("- one\n- two\n- three");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false, items: ["one", "two", "three"] });
  });

  it("distinguishes an ordered list from a bullet list", () => {
    const blocks = splitBlocksForTest("1. one\n2. two");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
  });

  it("reads headings and quotes", () => {
    const blocks = splitBlocksForTest("## Title\n\n> quoted");
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2, text: "Title" });
    expect(blocks[1]).toMatchObject({ kind: "quote", text: "quoted" });
  });

  it("leaves an unterminated fence as a code block rather than losing the text", () => {
    const blocks = splitBlocksForTest("```js\nstill streaming");
    expect(blocks[0]).toMatchObject({ kind: "code", text: "still streaming" });
  });
});
