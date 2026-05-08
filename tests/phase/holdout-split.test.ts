import { describe, expect, it } from "bun:test";
import type { CaseFile } from "../../src/types/config.js";

// Re-implement the stratified split here for testing because it's not exported.
// We test the externally observable behavior via the synthesize result.
import { dedupCases } from "../../src/phase/synthesize.js";

function makeCase(id: string, tier: number, content: string): CaseFile {
  return {
    id,
    generated_at: "2026-01-01",
    difficulty_tier: tier,
    evolutions: [],
    tags: [],
    input: { content },
    reference: { output: "ref", synthesizer_confidence: 0.9 },
    rubric: { c1: "test" },
  };
}

describe("dedupCases", () => {
  it("removes near-duplicate inputs", () => {
    const cases = [
      makeCase("0001", 2, "calculate the average of a list of numbers"),
      makeCase("0002", 2, "calculate the average of a list of numbers"),
      makeCase("0003", 3, "completely different task about strings"),
    ];
    const result = dedupCases(cases, 0.85);
    expect(result.length).toBe(2);
    expect(result.find((c) => c.id === "0003")).toBeDefined();
  });

  it("keeps all cases when none are similar", () => {
    const cases = [
      makeCase("0001", 1, "string manipulation task here"),
      makeCase("0002", 2, "math computation completely different"),
      makeCase("0003", 3, "graph traversal algorithm something"),
    ];
    const result = dedupCases(cases, 0.85);
    expect(result.length).toBe(3);
  });

  it("respects custom threshold", () => {
    const cases = [
      makeCase("0001", 2, "alpha beta gamma delta epsilon"),
      makeCase("0002", 2, "alpha beta gamma delta epsilon zeta"),
    ];
    // High threshold (0.99) - should keep both
    const strict = dedupCases(cases, 0.99);
    expect(strict.length).toBe(2);
    // Low threshold (0.4) - should dedupe
    const loose = dedupCases(cases, 0.4);
    expect(loose.length).toBe(1);
  });
});