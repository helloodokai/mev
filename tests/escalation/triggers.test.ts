import { describe, expect, it } from "bun:test";
import {
  checkCalibrationDrift,
  checkCriticPerCaseUncertainty,
  checkCriticRejectionRate,
  checkInterRubricVariance,
  checkOptimizerPlateau,
  createEscalationQueue,
} from "../../src/escalation/index.js";
import type { FrontierPoint, JudgeResult } from "../../src/types/core.js";
import { brandPromptSha } from "../../src/types/core.js";
import type { CriticVerdict } from "../../src/types/schemas.js";

describe("EscalationQueue", () => {
  it("adds and drains events by priority", () => {
    const queue = createEscalationQueue();
    queue.add({
      kind: "calibration_drift",
      priority: 0.3,
      details: "low",
      defaultAction: "keep",
      timestamp: "2026-01-01",
    });
    queue.add({
      kind: "position_swap_disagreement",
      priority: 0.85,
      details: "high",
      defaultAction: "keep",
      timestamp: "2026-01-01",
    });

    const drained = queue.drain();
    expect(drained.length).toBe(2);
    expect(drained[0]!.kind).toBe("position_swap_disagreement");
    expect(drained[1]!.kind).toBe("calibration_drift");
  });

  it("caps at 7 events", () => {
    const queue = createEscalationQueue();
    for (let i = 0; i < 10; i++) {
      queue.add({
        kind: "calibration_drift",
        priority: 0.1 * i,
        details: `event ${i}`,
        defaultAction: "keep",
        timestamp: "2026-01-01",
      });
    }

    const drained = queue.drain();
    expect(drained.length).toBe(7);
  });

  it("hasEvents reports correctly", () => {
    const queue = createEscalationQueue();
    expect(queue.hasEvents()).toBe(false);
    queue.add({
      kind: "lockin_preflight",
      priority: 1,
      details: "",
      defaultAction: "",
      timestamp: "",
    });
    expect(queue.hasEvents()).toBe(true);
  });
});

describe("checkCriticRejectionRate", () => {
  it("fires when rejection rate exceeds 30%", () => {
    const event = checkCriticRejectionRate(20, 15, ["unclear", "out of scope", "trivial"]);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("critic_rejection_rate_elevated");
  });

  it("does not fire when rejection rate is below 30%", () => {
    const event = checkCriticRejectionRate(35, 10, ["unclear"]);
    expect(event).toBeNull();
  });

  it("does not fire with zero total", () => {
    const event = checkCriticRejectionRate(0, 0, []);
    expect(event).toBeNull();
  });
});

describe("checkCalibrationDrift", () => {
  it("fires when mean score is inflated (>4.2)", () => {
    const results: JudgeResult[] = [
      {
        caseId: "1",
        modelAlias: "test",
        promptSha: brandPromptSha("abc"),
        meanScore: 4.5,
        scores: [
          { criterion: "a", score: 5, confidence: 0.9, justification: "" },
          { criterion: "b", score: 4, confidence: 0.8, justification: "" },
        ],
        raw: null,
      },
    ];
    const event = checkCalibrationDrift(results);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("calibration_drift");
  });

  it("does not fire when scores are centered (~3.0)", () => {
    const results: JudgeResult[] = [
      {
        caseId: "1",
        modelAlias: "test",
        promptSha: brandPromptSha("abc"),
        meanScore: 3.0,
        scores: [
          { criterion: "a", score: 3, confidence: 0.9, justification: "" },
          { criterion: "b", score: 3, confidence: 0.8, justification: "" },
        ],
        raw: null,
      },
    ];
    const event = checkCalibrationDrift(results);
    expect(event).toBeNull();
  });
});

describe("checkInterRubricVariance", () => {
  it("fires for criterion with zero variance (not discriminating)", () => {
    const results: JudgeResult[] = Array.from({ length: 10 }, (_, i) => ({
      caseId: String(i),
      modelAlias: "test",
      promptSha: brandPromptSha("abc"),
      meanScore: 3,
      scores: [
        { criterion: "catches_errors", score: 3, confidence: 0.9, justification: "" },
        { criterion: "concise", score: 3, confidence: 0.8, justification: "" },
      ],
      raw: null,
    }));

    const event = checkInterRubricVariance(results, ["catches_errors", "concise"]);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("inter_rubric_variance");
  });

  it("does not fire when criteria have healthy variance", () => {
    // Scores from 1-5 with good spread: variance should be in (0.3, 2.0)
    const healthyScores = [1, 2, 3, 4, 5, 2, 3, 4, 3, 4];
    const conciseScores = [2, 3, 4, 3, 2, 4, 3, 5, 3, 4];
    const results: JudgeResult[] = Array.from({ length: 10 }, (_, i) => ({
      caseId: String(i),
      modelAlias: "test",
      promptSha: brandPromptSha("abc"),
      meanScore: 3,
      scores: [
        {
          criterion: "catches_errors",
          score: healthyScores[i] ?? 3,
          confidence: 0.9,
          justification: "",
        },
        { criterion: "concise", score: conciseScores[i] ?? 3, confidence: 0.8, justification: "" },
      ],
      raw: null as unknown,
    }));

    const event = checkInterRubricVariance(results, ["catches_errors", "concise"]);
    expect(event).toBeNull();
  });

  it("fires for zero-variance criterion but not healthy-variance ones", () => {
    const results: JudgeResult[] = Array.from({ length: 10 }, (_, i) => ({
      caseId: String(i),
      modelAlias: "test",
      promptSha: brandPromptSha("abc"),
      meanScore: 3,
      scores: [
        { criterion: "catches_errors", score: 2 + (i % 4), confidence: 0.9, justification: "" },
        { criterion: "concise", score: 3, confidence: 0.8, justification: "" },
      ],
      raw: null as unknown,
    }));

    const event = checkInterRubricVariance(results, ["catches_errors", "concise"]);
    // "concise" has variance 0 (should fire)
    expect(event).not.toBeNull();
    expect(event!.rubricCriterion).toBe("concise");
  });
});

describe("checkOptimizerPlateau", () => {
  it("fires when plateaued for 2+ generations with narrow score band", () => {
    const frontier: FrontierPoint[] = [
      {
        promptSha: brandPromptSha("a"),
        promptText: "",
        modelAlias: "test",
        meanScore: 3.1,
        totalCostUsd: 1,
        p95LatencyMs: 100,
        generation: 1,
      },
    ];
    const event = checkOptimizerPlateau([frontier, frontier, frontier], 2);
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("optimizer_plateau");
  });

  it("does not fire when score band is wide", () => {
    const wideFrontier: FrontierPoint[] = [
      {
        promptSha: brandPromptSha("a"),
        promptText: "",
        modelAlias: "test",
        meanScore: 2.0,
        totalCostUsd: 0.1,
        p95LatencyMs: 100,
        generation: 1,
      },
      {
        promptSha: brandPromptSha("b"),
        promptText: "",
        modelAlias: "test",
        meanScore: 4.5,
        totalCostUsd: 2.0,
        p95LatencyMs: 500,
        generation: 2,
      },
    ];
    // Two separate frontier snapshots (history), wide score band in latest
    const event = checkOptimizerPlateau([wideFrontier], 2);
    // Latest frontier has score band 2.5 (4.5 - 2.0), which is > 0.5, so no trigger
    expect(event).toBeNull();
  });
});

describe("checkCriticPerCaseUncertainty", () => {
  it("fires when critic says not clear", () => {
    const verdict: CriticVerdict = {
      is_clear: false,
      is_unambiguous: true,
      is_aligned_with_intent: true,
      is_trivially_solvable: false,
      is_within_scope: true,
      difficulty_tier: 3,
      reasoning: "Ambiguous input",
    };
    const event = checkCriticPerCaseUncertainty("0017", verdict);
    expect(event).not.toBeNull();
    expect(event!.caseId).toBe("0017");
  });

  it("does not fire when critic is confident", () => {
    const verdict: CriticVerdict = {
      is_clear: true,
      is_unambiguous: true,
      is_aligned_with_intent: true,
      is_trivially_solvable: false,
      is_within_scope: true,
      difficulty_tier: 3,
      reasoning: "Clear case",
    };
    const event = checkCriticPerCaseUncertainty("0017", verdict);
    expect(event).toBeNull();
  });
});
