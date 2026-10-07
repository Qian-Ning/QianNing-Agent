import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  detectTrigger,
  fileReferenceLabel,
  findSkillMentions,
  formatCommandInsert,
  formatFileInsert,
  isComposerCommandSlash,
  normalizeLargePasteThreshold,
  restoreInlineComposerFileReferenceTokens,
  rewriteIdeographicCommaTrigger,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
  stripInlineComposerFileReferenceTokens,
} from "./composer-trigger.js";

describe("detectTrigger — slash mode", () => {
  it("triggers on a bare slash at position 0", () => {
    expect(detectTrigger("/", 1)).toEqual({
      mode: "slash",
      query: "",
      tokenStart: 0,
      tokenEnd: 1,
      commandPosition: true,
    });
  });

  it("carries the typed query", () => {
    expect(detectTrigger("/rev", 4)).toMatchObject({ mode: "slash", query: "rev" });
  });

  it("does not trigger before the slash", () => {
    expect(detectTrigger("/rev", 0)).toBeNull();
  });

  it("closes once the first token has whitespace before the cursor", () => {
    expect(detectTrigger("/review src", 11)).toBeNull();
    expect(detectTrigger("/review ", 8)).toBeNull();
  });

  it("stays open when the cursor is inside the first token", () => {
    expect(detectTrigger("/review src", 4)).toMatchObject({
      mode: "slash",
      query: "rev",
      tokenEnd: 4,
    });
  });

  it("targets later slash tokens independently", () => {
    expect(detectTrigger("hi /cmd", 7)).toMatchObject({ tokenStart: 3, query: "cmd" });
    expect(detectTrigger("hi\n/cmd", 7)).toMatchObject({ tokenStart: 3, query: "cmd" });
    expect(detectTrigger("https://example.com", 8)).toBeNull();
  });

  it("opens from inside a CJK sentence, with no space before the slash (D673)", () => {
    expect(detectTrigger("继续/qn", 5)).toMatchObject({
      mode: "slash",
      query: "qn",
      tokenStart: 2,
      tokenEnd: 5,
      commandPosition: true,
    });
    expect(detectTrigger("你好/", 3)).toEqual({
      mode: "slash",
      query: "",
      tokenStart: 2,
      tokenEnd: 3,
      commandPosition: true,
    });
  });

  it("opens after Latin text too, without claiming a command position", () => {
    const trigger = detectTrigger("hello/qn", 8);
    expect(trigger).toMatchObject({ mode: "slash", query: "qn", tokenStart: 5 });
    expect(trigger?.commandPosition).toBeUndefined();
    expect(detectTrigger("src/foo", 7)).toMatchObject({ tokenStart: 3, query: "foo" });
  });

  it("prefers the nearest slash and still replaces the whole token", () => {
    expect(detectTrigger("a/b/c", 5)).toMatchObject({ tokenStart: 3, query: "c" });
    expect(detectTrigger("hi /cm tail", 5)).toMatchObject({
      tokenStart: 3,
      tokenEnd: 6,
      query: "c",
    });
  });

  it("never summons a command out of an address", () => {
    expect(detectTrigger("https://", 8)).toBeNull();
    expect(detectTrigger("C:\\work\\", 8)).toBeNull();
    expect(detectTrigger("//host", 6)).toBeNull();
  });

  it("opens on an ideographic comma typed mid-draft, without rewriting it", () => {
    expect(detectTrigger("继续、", 3)).toEqual({
      mode: "slash",
      query: "",
      tokenStart: 2,
      tokenEnd: 3,
      commandPosition: true,
    });
    // Prose after the mark is text again: the mark is no longer last.
    expect(detectTrigger("继续、写第11章", 8)).toBeNull();
  });
});

describe("rewriteIdeographicCommaTrigger", () => {
  it("turns a leading ideographic comma into the slash trigger", () => {
    expect(rewriteIdeographicCommaTrigger("、")).toBe("/");
    expect(rewriteIdeographicCommaTrigger("、rev")).toBe("/rev");
  });

  it("leaves the mark alone anywhere else in the draft", () => {
    expect(rewriteIdeographicCommaTrigger("你好、世界")).toBe("你好、世界");
    expect(rewriteIdeographicCommaTrigger("/cmd 、")).toBe("/cmd 、");
    expect(rewriteIdeographicCommaTrigger("")).toBe("");
  });

  it("opens the menu through the ordinary detector once rewritten", () => {
    const draft = rewriteIdeographicCommaTrigger("、rev");
    expect(detectTrigger(draft, draft.length)).toMatchObject({
      mode: "slash",
      query: "rev",
      tokenStart: 0,
    });
  });
});

describe("detectTrigger — file mode", () => {
  it("triggers on a bare @ at start", () => {
    expect(detectTrigger("@", 1)).toEqual({
      mode: "file",
      query: "",
      tokenStart: 0,
      tokenEnd: 1,
    });
  });

  it("triggers after whitespace and pi delimiters", () => {
    expect(detectTrigger("see @src/a", 10)).toMatchObject({
      mode: "file",
      query: "src/a",
      tokenStart: 4,
    });
    expect(detectTrigger("path=@conf", 10)).toMatchObject({ mode: "file", query: "conf" });
    expect(detectTrigger("a\t@x", 4)).toMatchObject({ mode: "file", query: "x" });
  });

  it("does not trigger on a mid-word @ (emails)", () => {
    expect(detectTrigger("mail a@b.com", 12)).toBeNull();
  });

  it("does not trigger when the cursor is outside the token", () => {
    expect(detectTrigger("@src ok", 7)).toBeNull();
  });

  it("supports the quoted form with spaces", () => {
    expect(detectTrigger('@"my file', 9)).toEqual({
      mode: "file",
      query: "my file",
      tokenStart: 0,
      tokenEnd: 9,
    });
    expect(detectTrigger('see @"a b/c', 11)).toMatchObject({
      mode: "file",
      query: "a b/c",
      tokenStart: 4,
    });
  });

  it("treats a just-opened quote as an empty query", () => {
    expect(detectTrigger('@"', 2)).toMatchObject({ mode: "file", query: "" });
  });

  it("closes after the quote is closed", () => {
    expect(detectTrigger('@"a b" next', 11)).toBeNull();
    expect(detectTrigger('@"a b" ', 7)).toBeNull();
  });

  it("keeps completing inside an inserted quoted directory", () => {
    const draft = '@"my dir/sr';
    expect(detectTrigger(draft, draft.length)).toMatchObject({
      mode: "file",
      query: "my dir/sr",
    });
  });

  it("returns null for out-of-range cursors", () => {
    expect(detectTrigger("@a", 5)).toBeNull();
    expect(detectTrigger("@a", -1)).toBeNull();
  });
});

describe("insert formatting", () => {
  it("formats commands with a trailing space", () => {
    expect(formatCommandInsert("review")).toBe("/review ");
  });

  it("formats plain files with a trailing space", () => {
    expect(formatFileInsert("src/a.ts", "file")).toBe("@src/a.ts ");
  });

  it("quotes files containing spaces", () => {
    expect(formatFileInsert("my file.md", "file")).toBe('@"my file.md" ');
  });

  it("leaves directories open for continued completion", () => {
    expect(formatFileInsert("src", "dir")).toBe("@src/");
    expect(formatFileInsert("my dir", "dir")).toBe('@"my dir/');
  });
});

describe("applyCompletion", () => {
  it("replaces the trigger token and moves the cursor", () => {
    const trigger = detectTrigger("see @sr tail", 7);
    expect(trigger).not.toBeNull();
    const result = applyCompletion(
      "see @sr tail",
      trigger!,
      formatFileInsert("src/a.ts", "file"),
    );
    expect(result.value).toBe("see @src/a.ts  tail");
    expect(result.cursor).toBe("see @src/a.ts ".length);
  });

  it("replaces a slash token from the start of the draft", () => {
    const trigger = detectTrigger("/rev", 4);
    const result = applyCompletion("/rev", trigger!, formatCommandInsert("review"));
    expect(result).toEqual({ value: "/review ", cursor: 8 });
  });

  it("chains directory completion into a deeper trigger", () => {
    const step1 = applyCompletion("@", detectTrigger("@", 1)!, formatFileInsert("src", "dir"));
    expect(step1.value).toBe("@src/");
    const next = detectTrigger(step1.value, step1.cursor);
    expect(next).toMatchObject({ mode: "file", query: "src/" });
  });
});

describe("compact file references", () => {
  it("derives leaf labels across path separators without changing unicode", () => {
    expect(fileReferenceLabel("src/components/Composer.tsx")).toBe("Composer.tsx");
    expect(fileReferenceLabel("C:\\work\\界面\\截图.png")).toBe("截图.png");
    expect(fileReferenceLabel("src/fallback.ts", "original name.ts")).toBe(
      "original name.ts",
    );
  });

  it("serializes canonical paths after the visible draft", () => {
    expect(
      serializeComposerFileReferences("inspect these", [
        { path: "src/a.ts" },
        { path: "/tmp/session scratch/image.png" },
      ]),
    ).toBe('inspect these\n@src/a.ts @"/tmp/session scratch/image.png"');
  });

  it("supports reference-only prompts and preserves duplicate paths", () => {
    expect(
      serializeComposerFileReferences("", [
        { path: "src/index.ts" },
        { path: "test/index.ts" },
      ]),
    ).toBe("@src/index.ts @test/index.ts");
  });

  it("resolves generated inline tokens in place and leaves chip references separate", () => {
    expect(
      serializeInlineComposerFileReferences("before @pasted-text.txt after", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
      ]),
    ).toBe("before @/tmp/session/pasted/pasted-text.txt after");
    expect(
      serializeComposerFileReferences("before @pasted-text.txt after", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
        { path: "src/a.ts" },
      ]),
    ).toBe(
      "before @/tmp/session/pasted/pasted-text.txt after\n@src/a.ts",
    );
  });

  it("does not serialize an inline reference after its token is removed", () => {
    expect(
      serializeComposerFileReferences("the token was removed", [
        { path: "/tmp/session/pasted/pasted-text.txt", token: "@pasted-text.txt" },
      ]),
    ).toBe("the token was removed");
  });

  it("keeps one separating space between adjacent sentinel chips", () => {
    expect(
      serializeInlineComposerFileReferences("\uE001\uE002 inspect", [
        { path: "src/a.ts", token: "\uE001" },
        { path: "src/b.ts", token: "\uE002" },
      ]),
    ).toBe("@src/a.ts @src/b.ts inspect");
  });

  it("keeps inline chips intact while enhancing their surrounding text", () => {
    const references = [{ path: "/tmp/image.png", token: "\uE001" }];
    const source = "\uE001make this clearer";
    expect(stripInlineComposerFileReferenceTokens(source, references)).toBe(
      "make this clearer",
    );
    expect(
      restoreInlineComposerFileReferenceTokens(
        source,
        "\uE001Make this much clearer",
        references,
      ),
    ).toBe("\uE001Make this much clearer");
    expect(
      restoreInlineComposerFileReferenceTokens(
        source,
        "Make this much clearer",
        references,
      ),
    ).toBe("\uE001Make this much clearer");
  });

  it("normalizes large-paste thresholds to the supported range", () => {
    expect(normalizeLargePasteThreshold(undefined)).toBe(600);
    expect(normalizeLargePasteThreshold(600)).toBe(600);
    expect(normalizeLargePasteThreshold(0)).toBe(600);
    expect(normalizeLargePasteThreshold(1_000_001)).toBe(600);
    expect(normalizeLargePasteThreshold(601)).toBe(601);
  });
});

describe("isComposerCommandSlash", () => {
  it("accepts a summon with no space in front of it", () => {
    expect(isComposerCommandSlash("/cmd", 0)).toBe(true);
    expect(isComposerCommandSlash("hi /cmd", 3)).toBe(true);
    expect(isComposerCommandSlash("继续/qn-novel-write", 2)).toBe(true);
    expect(isComposerCommandSlash("写吧/qn-novel-write", 2)).toBe(true);
    expect(isComposerCommandSlash("abc/qn-novel-write", 3)).toBe(true);
    expect(isComposerCommandSlash("、/cmd", 1)).toBe(true);
  });

  it("never reads a slash of an address or a path as a command", () => {
    expect(isComposerCommandSlash("https://host/x", 6)).toBe(false);
    expect(isComposerCommandSlash("https://host/x", 5)).toBe(false);
    expect(isComposerCommandSlash("C:/Users/x", 2)).toBe(false);
    expect(isComposerCommandSlash("//host/x", 1)).toBe(false);
    expect(isComposerCommandSlash("a\\b/x", 3)).toBe(false);
    // An @reference owns its slashes: a directory named like a Skill is a path.
    expect(isComposerCommandSlash("@src/qn-novel-write", 4)).toBe(false);
  });

  it("only answers for the index it was given", () => {
    expect(isComposerCommandSlash("a/b", 2)).toBe(false);
    expect(isComposerCommandSlash("a/b", 1)).toBe(true);
  });
});

describe("findSkillMentions", () => {
  const skills = new Map([
    ["qn-novel-write", "skill-write"],
    ["qn-novel", "skill-novel"],
    ["ai", "skill-ai"],
  ]);

  it("resolves a summon typed straight after prose, with no space", () => {
    expect(findSkillMentions("继续/qn-novel-write", skills)).toEqual([
      { start: 2, end: 17, id: "skill-write" },
    ]);
    expect(findSkillMentions("写吧/qn-novel-write 第7章", skills)).toEqual([
      { start: 2, end: 17, id: "skill-write" },
    ]);
  });

  it("prefers the longest name and ignores unknown ones", () => {
    expect(findSkillMentions("/qn-novel-write", skills)).toEqual([
      { start: 0, end: 15, id: "skill-write" },
    ]);
    expect(findSkillMentions("/qn-novel", skills)).toEqual([
      { start: 0, end: 9, id: "skill-novel" },
    ]);
    expect(findSkillMentions("/nope", skills)).toEqual([]);
    // A longer word is not a summon, however much of a name it starts with.
    expect(findSkillMentions("/qn-novel-writes", skills)).toEqual([]);
    expect(findSkillMentions("/ai2", skills)).toEqual([]);
  });

  it("leaves an address, a drive path and an @reference alone", () => {
    expect(findSkillMentions("https://host/ai", skills)).toEqual([]);
    expect(findSkillMentions("C:/ai", skills)).toEqual([]);
    expect(findSkillMentions("@src/ai", skills)).toEqual([]);
  });

  it("finds every summon in one message", () => {
    const mentions = findSkillMentions("先/ai 再/qn-novel-write", skills);
    expect(mentions.map((mention) => mention.id)).toEqual([
      "skill-ai",
      "skill-write",
    ]);
  });
});
