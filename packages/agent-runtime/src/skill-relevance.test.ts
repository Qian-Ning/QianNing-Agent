import { describe, expect, it } from "vitest";
import {
  chooseSkillToPreload,
  rankSkillsForPrompt,
  SKILL_PRELOAD_MIN_SCORE,
} from "./skill-relevance.js";
import type { PluginSkillDef } from "./plugin-skills.js";

const skills: PluginSkillDef[] = [
  {
    id: "qianning/release-verification",
    name: "Release verification",
    description: "a release is about to be tagged — prove the artefact, the tag, and the tested tree",
  },
  {
    id: "qianning/build-and-release",
    name: "Build and release",
    description: "a build is being wired to produce release artefacts",
  },
  {
    id: "qianning/audio-visualization",
    name: "Audio visualization",
    description: "a spectrogram, mel view, or chroma plot has to be read from an audio file",
  },
  {
    id: "qianning/dialogue-craft",
    name: "Dialogue",
    description: "spoken lines have to carry subtext and interruption",
  },
];

describe("rankSkillsForPrompt", () => {
  it("returns nothing for a prompt made of stop words", () => {
    expect(rankSkillsForPrompt("hey, can you help me with this", skills)).toEqual([]);
  });

  it("weights a rare word above a common one", () => {
    const ranked = rankSkillsForPrompt("spectrogram from the audio file", skills);
    expect(ranked[0]?.id).toBe("qianning/audio-visualization");
    // "audio" and "file" are shared across the catalog prose; "spectrogram" is not.
    expect(ranked[0]?.score).toBeGreaterThan(SKILL_PRELOAD_MIN_SCORE);
  });

  it("breaks score ties by id so the order is stable", () => {
    const ranked = rankSkillsForPrompt("release", skills);
    expect(ranked.map((entry) => entry.id)).toEqual([
      "qianning/build-and-release",
      "qianning/release-verification",
    ]);
  });
});

describe("chooseSkillToPreload", () => {
  it("picks the skill that the prompt unambiguously describes", () => {
    const chosen = chooseSkillToPreload(
      "the release is tagged but the artefact hash does not match what was tested",
      skills,
    );
    expect(chosen?.id).toBe("qianning/release-verification");
  });

  it("refuses when the best score is under the floor", () => {
    expect(chooseSkillToPreload("what is the release process", skills)).toBeUndefined();
  });

  it("refuses when two skills fit almost equally well", () => {
    // Both entries carry "release"; neither earns a second distinctive hit.
    expect(chooseSkillToPreload("release", skills)).toBeUndefined();
  });

  it("refuses on an empty prompt or an empty catalog", () => {
    expect(chooseSkillToPreload("", skills)).toBeUndefined();
    expect(chooseSkillToPreload("spectrogram", [])).toBeUndefined();
  });

  it("matches through id slug words as well as prose", () => {
    const chosen = chooseSkillToPreload("the dialogue keeps falling flat", skills);
    expect(chosen?.id).toBe("qianning/dialogue-craft");
  });
});
