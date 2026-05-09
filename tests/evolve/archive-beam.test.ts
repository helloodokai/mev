import { describe, expect, it } from "bun:test";
import {
  createArchive,
  paretoUpdate,
  topKDiverseBeam,
} from "../../src/evolve/archive.js";
import type { FrontierPoint } from "../../src/types/core.js";
import { brandPromptSha } from "../../src/types/core.js";

function makePoint(sha: string, score: number, prompt: string): FrontierPoint {
  return {
    promptSha: brandPromptSha(sha),
    promptText: prompt,
    modelAlias: "test",
    meanScore: score,
    totalCostUsd: 0,
    p95LatencyMs: 0,
    generation: 1,
  };
}

describe("topKDiverseBeam", () => {
  it("returns top-K when K=1", () => {
    let archive = createArchive();
    archive = paretoUpdate(archive, makePoint("aaa", 4.0, "you are a helpful agent"));
    archive = paretoUpdate(archive, makePoint("bbb", 3.0, "you are a friendly bot"));
    const beam = topKDiverseBeam(archive, 1);
    expect(beam.length).toBe(1);
    expect(beam[0]?.promptSha as string).toBe("aaa");
  });

  it("prefers the simpler prompt when top scores tie", () => {
    let archive = createArchive();
    archive = paretoUpdate(archive, makePoint("aaa", 4.0, "short prompt"));
    archive = paretoUpdate(
      archive,
      makePoint("bbb", 4.0, "## Very\n**long** prompt with extra formatting and many more tokens"),
    );
    const beam = topKDiverseBeam(archive, 1);
    expect(beam[0]?.promptSha as string).toBe("aaa");
  });

  it("prefers diverse prompts over near-duplicates", () => {
    let archive = createArchive();
    // Two near-identical high scorers and one different lower scorer
    archive = paretoUpdate(archive, makePoint("aaa", 4.5, "be precise and accurate always"));
    archive = paretoUpdate(archive, makePoint("aab", 4.4, "be precise and accurate always always"));
    archive = paretoUpdate(archive, makePoint("ccc", 3.8, "completely different style here"));
    const beam = topKDiverseBeam(archive, 2);
    expect(beam.length).toBe(2);
    // First pick should be highest score
    expect(beam[0]?.promptSha as string).toBe("aaa");
    // Second pick should NOT be the near-duplicate (aab) but the diverse one (ccc)
    expect(beam[1]?.promptSha as string).toBe("ccc");
  });

  it("returns up to K items even with duplicates", () => {
    let archive = createArchive();
    archive = paretoUpdate(archive, makePoint("aaa", 4.0, "x"));
    archive = paretoUpdate(archive, makePoint("bbb", 3.5, "y"));
    archive = paretoUpdate(archive, makePoint("ccc", 3.0, "z"));
    const beam = topKDiverseBeam(archive, 5);
    expect(beam.length).toBe(3);
  });

  it("returns empty array on empty archive", () => {
    const archive = createArchive();
    const beam = topKDiverseBeam(archive, 3);
    expect(beam).toEqual([]);
  });
});
