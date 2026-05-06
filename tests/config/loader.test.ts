import { describe, expect, it } from "bun:test";
import { CaseFileSchema, MevConfigSchema, TaskSpecSchema } from "../../src/types/config.js";

describe("MevConfigSchema", () => {
  it("parses a valid config", () => {
    const config = {
      project: {
        name: "test",
        intent: "Do things",
        seed_examples: [],
      },
      constraints: {
        max_latency_p95_ms: 5000,
        must_be_local: false,
        forbid_data_leakage: false,
      },
      budget: {
        max_usd: 5,
        max_minutes: 15,
        generations: 8,
        cases: 40,
      },
      models: [{ alias: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6" }],
      judge: { provider: "anthropic", model: "claude-sonnet-4-6" },
      synthesizer: { provider: "anthropic", model: "claude-sonnet-4-6" },
      critic: { provider: "anthropic", model: "claude-haiku-4-5" },
    };

    const result = MevConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("rejects missing intent", () => {
    const config = {
      project: { name: "test", seed_examples: [] },
      constraints: { max_latency_p95_ms: 5000, must_be_local: false, forbid_data_leakage: false },
      budget: { max_usd: 5, max_minutes: 15, generations: 8, cases: 40 },
      models: [{ alias: "s", provider: "anthropic", model: "x" }],
      judge: { provider: "anthropic", model: "x" },
      synthesizer: { provider: "anthropic", model: "x" },
      critic: { provider: "anthropic", model: "x" },
    };

    const result = MevConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("applies defaults", () => {
    const config = {
      project: { name: "test", intent: "test", seed_examples: [] },
      constraints: { max_latency_p95_ms: 5000, must_be_local: false, forbid_data_leakage: false },
      budget: { max_usd: 5, max_minutes: 15, generations: 8, cases: 40 },
      models: [{ alias: "s", provider: "anthropic" as const, model: "x" }],
      judge: { provider: "anthropic" as const, model: "x" },
      synthesizer: { provider: "anthropic" as const, model: "x" },
      critic: { provider: "anthropic" as const, model: "x" },
    };

    const result = MevConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.constraints.max_latency_p95_ms).toBe(5000);
      expect(result.data.budget.generations).toBe(8);
    }
  });
});

describe("CaseFileSchema", () => {
  it("parses a valid case file", () => {
    const caseFile = {
      id: "0001",
      generated_at: "2026-01-01T00:00:00Z",
      difficulty_tier: 3,
      evolutions: ["add_constraint"],
      tags: ["type-safety"],
      input: { content: "test input" },
      reference: { output: "test output", synthesizer_confidence: 0.8 },
      rubric: { catches_error: "Identifies the error" },
    };

    const result = CaseFileSchema.safeParse(caseFile);
    expect(result.success).toBe(true);
  });

  it("rejects empty input content", () => {
    const caseFile = {
      id: "0001",
      generated_at: "2026-01-01T00:00:00Z",
      difficulty_tier: 3,
      evolutions: [],
      tags: [],
      input: { content: "" },
      reference: { output: "output", synthesizer_confidence: 0.5 },
      rubric: {},
    };

    const result = CaseFileSchema.safeParse(caseFile);
    expect(result.success).toBe(false);
  });

  it("rejects difficulty tier out of range", () => {
    const caseFile = {
      id: "0001",
      generated_at: "2026-01-01T00:00:00Z",
      difficulty_tier: 6,
      evolutions: [],
      tags: [],
      input: { content: "test" },
      reference: { output: "output", synthesizer_confidence: 0.5 },
      rubric: {},
    };

    const result = CaseFileSchema.safeParse(caseFile);
    expect(result.success).toBe(false);
  });
});

describe("TaskSpecSchema", () => {
  it("parses a valid spec", () => {
    const spec = {
      task_summary: "Review TypeScript PRs",
      inputs: [{ name: "diff", description: "Git diff", example: "..." }],
      outputs: [{ name: "review", description: "Review output", example: "..." }],
      success_criteria: ["Finds type errors"],
      failure_modes: ["Misses obvious errors"],
      difficulty_axes: ["complexity"],
      out_of_scope: ["Python"],
    };

    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it("rejects empty success criteria", () => {
    const spec = {
      task_summary: "Do things",
      inputs: [],
      outputs: [],
      success_criteria: [],
      failure_modes: ["bad"],
      difficulty_axes: ["x"],
      out_of_scope: [],
    };

    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it("rejects more than 7 success criteria", () => {
    const spec = {
      task_summary: "Do things",
      inputs: [],
      outputs: [],
      success_criteria: Array(8).fill("criteria"),
      failure_modes: ["bad"],
      difficulty_axes: ["x"],
      out_of_scope: [],
    };

    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });
});
