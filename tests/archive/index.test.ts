import { describe, expect, it } from "bun:test";
import {
  createArchive,
  findKneePoint,
  paretoUpdate,
  sampleFromFrontier,
} from "../../src/evolve/archive.js";
import type { FrontierPoint } from "../../src/types/core.js";
import { brandPromptSha } from "../../src/types/core.js";

function makePoint(sha: string, score: number, cost: number, latency: number): FrontierPoint {
  return {
    promptSha: brandPromptSha(sha),
    promptText: `prompt-${sha}`,
    modelAlias: "test",
    meanScore: score,
    totalCostUsd: cost,
    p95LatencyMs: latency,
    generation: 1,
  };
}

describe("ParetoArchive", () => {
  it("starts empty", () => {
    const archive = createArchive();
    expect(archive.frontier.length).toBe(0);
    expect(archive.dominated.length).toBe(0);
  });

  it("adds first point to frontier", () => {
    let archive = createArchive();
    const point = makePoint("a", 3.0, 1.0, 500);
    archive = paretoUpdate(archive, point);
    expect(archive.frontier.length).toBe(1);
    expect(archive.frontier[0]!.promptSha).toBe(brandPromptSha("a"));
  });

  it("keeps both non-dominated points", () => {
    let archive = createArchive();
    const cheap = makePoint("cheap", 2.5, 0.5, 300);
    const expensive = makePoint("expensive", 4.0, 2.0, 800);
    archive = paretoUpdate(archive, cheap);
    archive = paretoUpdate(archive, expensive);
    // Neither dominates: cheap is cheaper, expensive is better
    expect(archive.frontier.length).toBe(2);
  });

  it("dominates and removes inferior point", () => {
    let archive = createArchive();
    const worse = makePoint("worse", 2.0, 2.0, 800);
    const better = makePoint("better", 4.0, 1.0, 300);
    archive = paretoUpdate(archive, worse);
    archive = paretoUpdate(archive, better);
    // better dominates worse on all dimensions
    expect(archive.frontier.length).toBe(1);
    expect(archive.frontier[0]!.promptSha).toBe(brandPromptSha("better"));
  });

  it("handles three-way frontier", () => {
    let archive = createArchive();
    const budget = makePoint("budget", 2.0, 0.1, 100);
    const mid = makePoint("mid", 3.5, 1.0, 500);
    const premium = makePoint("premium", 4.5, 5.0, 1000);
    archive = paretoUpdate(archive, budget);
    archive = paretoUpdate(archive, mid);
    archive = paretoUpdate(archive, premium);
    // All three non-dominated
    expect(archive.frontier.length).toBe(3);
  });
});

describe("sampleFromFrontier", () => {
  it("samples from frontier when epsilon=1 (always dominated)", () => {
    let archive = createArchive();
    archive = paretoUpdate(archive, makePoint("a", 3.0, 1.0, 500));
    // No dominated points, so will sample from frontier
    const sample = sampleFromFrontier(archive, 0);
    expect(sample.promptSha).toBe(brandPromptSha("a"));
  });

  it("throws on empty frontier", () => {
    const archive = createArchive();
    expect(() => sampleFromFrontier(archive, 0.2)).toThrow("Cannot sample from empty frontier");
  });
});

describe("findKneePoint", () => {
  it("finds best quality-per-dollar", () => {
    const frontier = [
      makePoint("premium", 4.5, 5.0, 1000),
      makePoint("budget", 2.0, 0.1, 100),
      makePoint("mid", 3.5, 1.0, 500),
    ];
    const knee = findKneePoint(frontier);
    // budget has best quality/cost ratio (20.0)
    expect(frontier[knee]!.promptSha).toBe(brandPromptSha("budget"));
  });

  it("returns 0 for single point", () => {
    const frontier = [makePoint("only", 3.0, 1.0, 500)];
    const knee = findKneePoint(frontier);
    expect(knee).toBe(0);
  });
});
