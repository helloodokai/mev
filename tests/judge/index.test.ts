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

  it("flags missing expected JSON top-level fields", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output: '{"entities": [{"text": "Acme", "type": "ORG", "start": 0}]}',
          synthesizerConfidence: 0.9,
        },
        rubric: { quality: "Adheres strictly to the required JSON schema and outputs ONLY the JSON object." },
      }),
      '[]',
    );
    expect(issues.some((issue) => issue.message.includes("root type") || issue.message.includes("entities"))).toBe(true);
  });

  it("flags missing expected JSON nested fields", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output: '{"entities": [{"text": "Acme", "type": "ORG", "start": 0}]}',
          synthesizerConfidence: 0.9,
        },
        rubric: {
          quality:
            "Maintains precise character indexing ('start') for every extracted entity and preserves the exact casing and spacing of the original text in the 'text' field.",
        },
      }),
      '{"entities": [{"text": "Acme"}]}',
    );
    expect(issues.some((issue) => issue.message.includes("entities[].type"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("entities[].start"))).toBe(true);
  });

  it("does not require extra reference-only alias fields", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output: '[{"entity": "Acme", "text": "Acme", "type": "ORG", "start": 0, "end": 4}]',
          synthesizerConfidence: 0.9,
        },
      }),
      '[{"text": "Acme", "type": "ORG", "start": 0}]',
    );
    expect(issues.some((issue) => issue.message.includes("entity"))).toBe(false);
  });

  it("flags invalid intent parser keys and enum values", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output:
            '{"intentType":"one-time","scheduleCron":null,"requiredCapabilities":[],"clarifyingQuestions":[],"domainContext":"general","description":"Do the thing"}',
          synthesizerConfidence: 0.9,
        },
      }),
      '{"intentType":"sometimes","scheduleCron":null,"requiredCapabilities":[],"clarifyingQuestions":[],"domainContext":"general","description":"Do the thing","extra":true}',
    );
    expect(issues.some((issue) => issue.message.includes("intentType must be one-time or recurring"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("unexpected intent parser key"))).toBe(true);
  });

  it("flags invalid cron and capabilities in intent parser output", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        reference: {
          output:
            '{"intentType":"recurring","scheduleCron":"0 9 * * 1-5","requiredCapabilities":["email"],"clarifyingQuestions":[],"domainContext":"reporting","description":"Every weekday at 9am email me a report"}',
          synthesizerConfidence: 0.9,
        },
      }),
      '{"intentType":"recurring","scheduleCron":"every day at 9","requiredCapabilities":["email","slack"],"clarifyingQuestions":[],"domainContext":"reporting","description":"Every weekday at 9am email me a report"}',
    );
    expect(issues.some((issue) => issue.message.includes("valid 5-field cron"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("requiredCapabilities contains invalid value"))).toBe(true);
  });

  it("flags quoted responses on single-next-sentence tasks", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        input: {
          content:
            "Scenario: Bundle failed. Constraint: For this evaluation, do not call tools. Reply with only the single next sentence you'd say before using tools.",
        },
        reference: { output: "Running build_app to inspect the diagnostic.", synthesizerConfidence: 0.9 },
      }),
      '"Running build_app to inspect the diagnostic."',
    );
    expect(issues.some((issue) => issue.message.includes("wrapped in quotes"))).toBe(true);
  });

  it("flags overlong responses on single-next-sentence tasks", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        input: {
          content:
            "Scenario: Add tldraw. Constraint: For this evaluation, do not call tools. Reply with only the single next sentence you'd say before using tools.",
        },
        reference: { output: "Checking the current tldraw docs first.", synthesizerConfidence: 0.9 },
      }),
      "I'll create a collaborative canvas app using tldraw by first checking the current tldraw documentation to ensure I implement it correctly and then proceed carefully.",
    );
    expect(issues.some((issue) => issue.message.includes("too verbose"))).toBe(true);
  });

  it("flags wrong question-vs-action mode on single-next-sentence tasks", () => {
    const issues = collectValidationIssues(
      makeEvalCase({
        input: {
          content:
            "Scenario: Database unclear. Constraint: For this evaluation, do not call tools. Reply with only the single next sentence you'd say before using tools.",
        },
        reference: {
          output: "Should this store customer records in your database or stay client-side only?",
          synthesizerConfidence: 0.9,
        },
      }),
      "Building the client-side version now.",
    );
    expect(issues.some((issue) => issue.message.includes("blocking question"))).toBe(true);
  });
});
