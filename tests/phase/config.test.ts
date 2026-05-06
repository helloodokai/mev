import { describe, expect, it } from "bun:test";
import { computeCaseSetSha } from "../../src/config/loader.js";
import type { CaseFile } from "../../src/types/config.js";

describe("computeCaseSetSha", () => {
  it("produces deterministic hash for same cases", () => {
    const cases: CaseFile[] = [
      {
        id: "0001",
        generated_at: "2026-01-01T00:00:00Z",
        difficulty_tier: 3,
        evolutions: [],
        tags: [],
        input: { content: "test input" },
        reference: { output: "test output", synthesizer_confidence: 0.8 },
        rubric: { test: "Identifies errors" },
      },
    ];
    const sha1 = computeCaseSetSha(cases);
    const sha2 = computeCaseSetSha(cases);
    expect(sha1).toBe(sha2);
  });

  it("produces different hash for different cases", () => {
    const casesA: CaseFile[] = [
      {
        id: "0001",
        generated_at: "2026-01-01",
        difficulty_tier: 3,
        evolutions: [],
        tags: [],
        input: { content: "input A" },
        reference: { output: "output A", synthesizer_confidence: 0.8 },
        rubric: {},
      },
    ];
    const casesB: CaseFile[] = [
      {
        id: "0001",
        generated_at: "2026-01-01",
        difficulty_tier: 3,
        evolutions: [],
        tags: [],
        input: { content: "input B" },
        reference: { output: "output B", synthesizer_confidence: 0.8 },
        rubric: {},
      },
    ];
    expect(computeCaseSetSha(casesA)).not.toBe(computeCaseSetSha(casesB));
  });
});
