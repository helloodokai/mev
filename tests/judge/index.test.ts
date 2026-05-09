import { describe, expect, it } from "bun:test";
import { collectValidationIssues, stripThinking } from "../../src/judge/index.js";
import type { EvalCase } from "../../src/types/index.js";

function makeEvalCase(overrides?: Partial<EvalCase>): EvalCase {
  return {
    id: "c1",
    generatedAt: new Date().toISOString(),
    difficultyTier: 2,
    evolutions: [],
    tags: [],
    input: { content: "input" },
    reference: { output: "output", synthesizerConfidence: 0.9 },
    rubric: { quality: "behavioral anchor" },
    ...overrides,
  };
}

describe("stripThinking", () => {
  it("removes thinking blocks from output", () => {
    const input = "Some text<thinking>internal reasoning here</thinking>More text";
    const result = stripThinking(input);
    expect(result).toBe("Some textMore text");
  });

  it("handles multiple thinking blocks", () => {
    const input = "<thinking>first</thinking>Hello<thinking>second</thinking>World";
    const result = stripThinking(input);
    expect(result).toBe("HelloWorld");
  });

  it("handles multiline thinking blocks", () => {
    const input = "Before<thinking>\nline1\nline2\n</thinking>After";
    const result = stripThinking(input);
    expect(result).toBe("BeforeAfter");
  });

  it("returns unchanged text without thinking blocks", () => {
    const input = "No thinking blocks here";
    const result = stripThinking(input);
    expect(result).toBe("No thinking blocks here");
  });
});

describe("collectValidationIssues", () => {
  it("flags invalid JSON when the reference expects JSON", () => {
    const issues = collectValidationIssues(
      makeEvalCase({ reference: { output: '{"entities": []}', synthesizerConfidence: 0.9 } }),
      "not json",
    );
    expect(issues.some((issue) => issue.message.includes("valid JSON"))).toBe(true);
  });

  it("flags changed output when the reference should be unchanged", () => {
    const issues = collectValidationIssues(
      makeEvalCase({ input: { content: "leave me alone" }, reference: { output: "leave me alone", synthesizerConfidence: 0.9 } }),
      "rewritten",
    );
    expect(issues.some((issue) => issue.message.includes("unchanged output"))).toBe(true);
  });

  it("flags missing required redaction tokens", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output: "Contact [REDACTED_NAME] at [REDACTED_EMAIL].",
          synthesizerConfidence: 0.9,
        },
      }),
      "Contact [REDACTED_NAME] at jane@example.com.",
    );
    expect(issues.some((issue) => issue.message.includes("[REDACTED_EMAIL]"))).toBe(true);
  });
});
