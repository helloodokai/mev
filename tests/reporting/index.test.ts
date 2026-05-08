import { describe, expect, it } from "bun:test";
import { generateHtmlReport, generateSummary } from "../../src/reporting/index.js";
import type { EscalationEvent, EvolutionStep, FrontierPoint } from "../../src/types/core.js";
import { brandPromptSha } from "../../src/types/core.js";

describe("generateHtmlReport", () => {
  it("generates valid HTML", () => {
    const frontier: FrontierPoint[] = [
      {
        promptSha: brandPromptSha("abc123"),
        promptText: "prompt text",
        modelAlias: "sonnet",
        meanScore: 4.41,
        totalCostUsd: 0.44,
        p95LatencyMs: 1400,
        generation: 1,
      },
    ];
    const steps: EvolutionStep[] = [];
    const escalations: EscalationEvent[] = [];
    const html = generateHtmlReport({
      frontier,
      evolutionSteps: steps,
      escalations,
      runId: "test-run",
      kneeIndex: 0,
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test-run");
    expect(html).toContain("abc123");
  });

  it("includes escalation section", () => {
    const frontier: FrontierPoint[] = [];
    const escalations: EscalationEvent[] = [
      {
        kind: "calibration_drift",
        priority: 0.6,
        details: "Score mean was 4.5",
        defaultAction: "Keep judgments",
        timestamp: "2026-01-01",
      },
    ];
    const html = generateHtmlReport({
      frontier,
      evolutionSteps: [],
      escalations,
      runId: "test",
      kneeIndex: 0,
    });
    expect(html).toContain("calibration_drift");
  });
});

describe("generateSummary", () => {
  it("generates a markdown summary", () => {
    const frontier: FrontierPoint[] = [
      {
        promptSha: brandPromptSha("abc123"),
        promptText: "prompt",
        modelAlias: "qwen3-coder",
        meanScore: 4.12,
        totalCostUsd: 0.04,
        p95LatencyMs: 800,
        generation: 3,
      },
    ];
    const summary = generateSummary({
      runId: "2026-05-05",
      frontier,
      kneeIndex: 0,
      totalCost: 3.5,
      escalations: [],
      generationsUsed: 6,
      casesCount: 30,
      bestScore: 4.12,
      openWeightImprovement: 0.61,
      baselineScore: 3.5,
    });
    expect(summary).toContain("# mev run summary");
    expect(summary).toContain("2026-05-05");
    // Improvement is computed and shown (now formatted as percentage in headline)
    expect(summary).toContain("0.6%"); // 0.61 rounded to one decimal
  });
});
