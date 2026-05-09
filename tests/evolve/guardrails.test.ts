import { describe, expect, it } from "bun:test";
import {
  applyAntiDriftGuardrails,
  detectPromptDrift,
} from "../../src/evolve/index.js";
import type { EditedPrompt, TaskSpec } from "../../src/types/index.js";

function makeTaskSpec(overrides?: Partial<TaskSpec>): TaskSpec {
  return {
    taskSummary:
      "Redact names, emails, phone numbers, and account IDs from support ticket text using fixed replacement tokens.",
    inputs: [{ name: "text", description: "Support ticket text", example: "Jane emailed support" }],
    outputs: [
      {
        name: "redacted_text",
        description: "Support ticket text with fixed replacement tokens",
        example: "[REDACTED_NAME] emailed support",
      },
    ],
    successCriteria: [
      "Accurately replaces names, emails, phone numbers, and account IDs.",
      "Uses only the mandated replacement tokens.",
      "Preserves surrounding text structure exactly.",
    ],
    failureModes: ["Misses sensitive fields", "Changes surrounding wording"],
    difficultyAxes: ["format variability"],
    outOfScope: [],
    ...overrides,
  };
}

describe("anti-drift guardrails", () => {
  it("detects unsupported structural constraints introduced by edits", () => {
    const reasons = detectPromptDrift({
      baselinePrompts: ["Redact names and emails using fixed tokens."],
      candidatePrompt: [
        "Redact names and emails using fixed tokens.",
        "The replacement token MUST match the exact character length of the original segment.",
      ].join("\n"),
      taskSpec: makeTaskSpec(),
    });

    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain("exact character length");
  });

  it("allows grounded constraints already present in the task spec", () => {
    const reasons = detectPromptDrift({
      baselinePrompts: ["Extract entities from text."],
      candidatePrompt: [
        "Extract entities from text.",
        "Return a character-for-character copy of the original JSON envelope.",
      ].join("\n"),
      taskSpec: makeTaskSpec({
        taskSummary: "Return a character-for-character copy of the original JSON envelope.",
      }),
    });

    expect(reasons.length).toBe(0);
  });

  it("falls back to the prior grounded prompt when drift is detected", () => {
    const candidate: EditedPrompt = {
      prompt: [
        "Redact names and emails using fixed tokens.",
        "Build an internal mapping and assign a unique, sequential index to each entity.",
      ].join("\n"),
      changes_made: ["added indexing"],
      expected_improvement: "more consistency",
    };

    const guarded = applyAntiDriftGuardrails({
      fallbackPrompt: "Redact names and emails using fixed tokens.",
      baselinePrompts: ["Redact names and emails using fixed tokens."],
      candidate,
      taskSpec: makeTaskSpec(),
    });

    expect(guarded.prompt).toBe("Redact names and emails using fixed tokens.");
    expect(guarded.changes_made[0]).toContain("anti-drift guard");
  });

  it("catches character-space preservation variants seen in redaction runs", () => {
    const reasons = detectPromptDrift({
      baselinePrompts: ["Preserve surrounding text structure exactly."],
      candidatePrompt: [
        "Preserve surrounding text structure exactly.",
        "Character Space Preservation: the replacement tokens must occupy the exact character space of the original PII.",
        "Do not collapse or expand spacing.",
      ].join("\n"),
      taskSpec: makeTaskSpec(),
    });

    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.join("\n")).toContain("character-space preservation");
    expect(reasons.join("\n")).toContain("spacing-width preservation");
  });

  it("catches forced string-length matching variants", () => {
    const reasons = detectPromptDrift({
      baselinePrompts: ["Use fixed replacement tokens."],
      candidatePrompt: [
        "Use fixed replacement tokens.",
        "The resulting string length must exactly match the length of the original PII segment.",
      ].join("\n"),
      taskSpec: makeTaskSpec(),
    });

    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain("forced string-length matching");
  });
});
