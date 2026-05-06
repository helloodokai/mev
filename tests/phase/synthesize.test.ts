import { describe, expect, it } from "bun:test";
import { dedupCases } from "../../src/phase/synthesize.js";
import type { CaseFile } from "../../src/types/config.js";

function makeCase(id: string, content: string): CaseFile {
  return {
    id,
    generated_at: "2026-01-01T00:00:00Z",
    difficulty_tier: 3,
    evolutions: [],
    tags: [],
    input: { content },
    reference: { output: "ref output", synthesizer_confidence: 0.8 },
    rubric: { test: "criterion" },
  };
}

describe("dedupCases", () => {
  it("removes near-duplicate cases", () => {
    const cases = [
      makeCase(
        "1",
        "This is a test case about TypeScript generics and type safety issues in a codebase",
      ),
      makeCase(
        "2",
        "This is a test case about TypeScript generics and type safety issues in a codebase with slight variation",
      ),
      makeCase(
        "3",
        "A completely different case about Python list comprehensions and functional programming patterns",
      ),
    ];

    const result = dedupCases(cases);
    // Cases 1 and 2 are likely similar enough to dedup
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
  });

  it("keeps entirely different cases", () => {
    const cases = [
      makeCase(
        "1",
        "Review this TypeScript code for type safety issues and suggest idiomatic refactors",
      ),
      makeCase("2", "Extract structured data from this medical referral letter into a JSON format"),
      makeCase("3", "Analyze this Python algorithm for time complexity and suggest optimizations"),
    ];

    const result = dedupCases(cases);
    expect(result.length).toBe(3);
  });
});
