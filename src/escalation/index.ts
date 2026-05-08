import type {
  EscalationEvent,
  EscalationKind,
  FrontierPoint,
  JudgeResult,
} from "../types/index.js";
import type { CriticVerdict } from "../types/index.js";

const TRIGGER_CONFIG = {
  positionSwapOnHighLeverage: true,
  judgeConfidenceDecile: 0.1,
  interRubricVarianceThreshold: 0.3,
  criticRejectionRateThreshold: 0.5, // Relaxed: more cases can be rejected without escalation
  criticPerCaseUncertaintyThreshold: 0.5,
  optimizerPlateauGenerations: 3, // More lenient plateau detection
  optimizerPlateauScoreBand: 0.3,
  calibrationDriftHigh: 4.5, // Wider band for 1-5 scale
  calibrationDriftLow: 1.5,
  maxEscalationsInView: 7,
} as const;

export type TriggerConfig = typeof TRIGGER_CONFIG;

export interface EscalationQueue {
  events: EscalationEvent[];
  add(event: EscalationEvent): void;
  drain(): EscalationEvent[];
  hasEvents(): boolean;
}

export function createEscalationQueue(): EscalationQueue {
  const events: EscalationEvent[] = [];

  return {
    events,
    add(event: EscalationEvent) {
      events.push(event);
    },
    drain(): EscalationEvent[] {
      const sorted = [...events].sort((a, b) => b.priority - a.priority);
      events.length = 0;
      return sorted.slice(0, TRIGGER_CONFIG.maxEscalationsInView);
    },
    hasEvents(): boolean {
      return events.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger 1: Position-swap disagreement on high-leverage case
// ---------------------------------------------------------------------------
export function checkPositionSwapDisagreement(
  verdicts: Array<{
    caseId: string;
    winner: "A" | "B" | "tie_uncertain";
    agreement: boolean;
    affectsTop2: boolean;
  }>,
): EscalationEvent | null {
  const highLeverage = verdicts.filter((v) => !v.agreement && v.affectsTop2);
  if (highLeverage.length === 0) return null;

  const caseIds = highLeverage.map((v) => v.caseId).join(", ");
  return {
    kind: "position_swap_disagreement",
    priority: computeInfoGain("position_swap_disagreement", 0.9),
    details: `Judges disagreed on position-swap for case(s) ${caseIds}. These affect the top-2 leaderboard.`,
    defaultAction: "Mark as tie_uncertain, drop from leaderboard math, keep in suite.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 2: Judge confidence below threshold
// ---------------------------------------------------------------------------
export function checkJudgeConfidence(results: JudgeResult[]): EscalationEvent | null {
  const allConfidences = results.flatMap((r) => r.scores.map((s) => s.confidence));
  if (allConfidences.length === 0) return null;

  const sorted = [...allConfidences].sort((a, b) => a - b);
  const decileIndex = Math.max(
    0,
    Math.floor(sorted.length * TRIGGER_CONFIG.judgeConfidenceDecile) - 1,
  );
  const bottomDecile = sorted[decileIndex];
  if (bottomDecile === undefined) return null;

  if (bottomDecile > 0.3) return null;

  const lowConfCases = results.filter((r) => r.scores.some((s) => s.confidence <= bottomDecile));

  return {
    kind: "judge_confidence_below_threshold",
    priority: computeInfoGain("judge_confidence_below_threshold", bottomDecile),
    details: `${lowConfCases.length} case-judge pairs had confidence ≤ ${bottomDecile.toFixed(2)} (bottom decile).`,
    defaultAction: "Keep judgments as-is.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 3: Inter-rubric variance
// ---------------------------------------------------------------------------
export function checkInterRubricVariance(
  results: JudgeResult[],
  rubricCriteria: string[],
): EscalationEvent | null {
  for (const criterion of rubricCriteria) {
    const scores = results
      .flatMap((r) => r.scores.filter((s) => s.criterion === criterion))
      .map((s) => s.score);
    if (scores.length < 3) continue;

    const variance = computeVariance(scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    if (variance < TRIGGER_CONFIG.interRubricVarianceThreshold || variance > 2.0) {
      return {
        kind: "inter_rubric_variance",
        priority: computeInfoGain("inter_rubric_variance", variance),
        rubricCriterion: criterion,
        details: `Criterion "${criterion}" has variance ${variance.toFixed(2)} (mean ${mean.toFixed(2)}). This suggests the criterion is either too vague (low variance, everyone scores the same) or too noisy (high variance, scores don't track overall quality).`,
        defaultAction: "Keep original wording.",
        timestamp: new Date().toISOString(),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trigger 4: Critic rejection rate elevated
// ---------------------------------------------------------------------------
export function checkCriticRejectionRate(
  accepted: number,
  rejected: number,
  rejectionReasons: string[],
): EscalationEvent | null {
  const total = accepted + rejected;
  if (total === 0) return null;
  const rate = rejected / total;

  if (rate <= TRIGGER_CONFIG.criticRejectionRateThreshold) return null;

  return {
    kind: "critic_rejection_rate_elevated",
    priority: computeInfoGain("critic_rejection_rate_elevated", rate),
    details: `Critic rejected ${(rate * 100).toFixed(0)}% of cases (${rejected}/${total}). Top reasons: ${rejectionReasons.slice(0, 3).join("; ")}. The intent may be ambiguous.`,
    defaultAction: "Continue with surviving cases.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 5: Critic per-case uncertainty
// ---------------------------------------------------------------------------
export function checkCriticPerCaseUncertainty(
  caseId: string,
  verdict: CriticVerdict,
): EscalationEvent | null {
  const isUncertain = !verdict.is_clear || !verdict.is_unambiguous;

  if (!isUncertain) return null;

  return {
    kind: "critic_per_case_uncertainty",
    priority: computeInfoGain("critic_per_case_uncertainty", verdict.difficulty_tier / 5),
    caseId,
    details: `Critic flagged case ${caseId}: is_clear=${verdict.is_clear}, is_unambiguous=${verdict.is_unambiguous}. Reasoning: ${verdict.reasoning}`,
    defaultAction: "Drop case from suite.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 6: Optimizer plateau
// ---------------------------------------------------------------------------
export function checkOptimizerPlateau(
  frontierHistory: ReadonlyArray<ReadonlyArray<FrontierPoint>>,
  generationsWithoutImprovement: number,
): EscalationEvent | null {
  if (generationsWithoutImprovement < TRIGGER_CONFIG.optimizerPlateauGenerations) return null;

  const latestFrontier = frontierHistory[frontierHistory.length - 1];
  if (!latestFrontier || latestFrontier.length === 0) return null;

  const scores = latestFrontier.map((p) => p.meanScore);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const band = maxScore - minScore;

  if (band >= TRIGGER_CONFIG.optimizerPlateauScoreBand) return null;

  return {
    kind: "optimizer_plateau",
    priority: computeInfoGain("optimizer_plateau", band),
    details: `Evolution plateaued for ${generationsWithoutImprovement} generations with frontier score band ${band.toFixed(2)} (max=${maxScore.toFixed(2)}, min=${minScore.toFixed(2)}). The rubric may be the bottleneck.`,
    defaultAction: "Halt evolution, use current frontier.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 7: Calibration drift
// ---------------------------------------------------------------------------
export function checkCalibrationDrift(results: JudgeResult[]): EscalationEvent | null {
  const allScores = results.flatMap((r) => r.scores.map((s) => s.score));
  if (allScores.length === 0) return null;

  const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;

  if (mean >= TRIGGER_CONFIG.calibrationDriftLow && mean <= TRIGGER_CONFIG.calibrationDriftHigh) {
    return null;
  }

  const direction = mean > TRIGGER_CONFIG.calibrationDriftHigh ? "inflation" : "deflation";

  return {
    kind: "calibration_drift",
    priority: computeInfoGain("calibration_drift", Math.abs(mean - 3)),
    details: `Judge score distribution shows ${direction}: mean = ${mean.toFixed(2)} (expected ~3.0). This may indicate systematic bias.`,
    defaultAction: "Keep judgments, log warning.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trigger 8: Lock-in preflight (always fires)
// ---------------------------------------------------------------------------
export function createLockinPreflight(_frontier: FrontierPoint[]): EscalationEvent {
  return {
    kind: "lockin_preflight",
    priority: 1.0,
    details: "Final Pareto frontier review. Select your preferred (model, prompt) combination.",
    defaultAction: "Select knee point.",
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Info-gain priority scoring
// ---------------------------------------------------------------------------
function computeInfoGain(kind: EscalationKind, magnitude: number): number {
  const basePriority: Record<EscalationKind, number> = {
    position_swap_disagreement: 0.85,
    judge_confidence_below_threshold: 0.3,
    inter_rubric_variance: 0.7,
    critic_rejection_rate_elevated: 0.5,
    critic_per_case_uncertainty: 0.2,
    optimizer_plateau: 0.75,
    calibration_drift: 0.6,
    lockin_preflight: 1.0,
  };
  return basePriority[kind] * Math.max(0.1, magnitude);
}

function computeVariance(numbers: number[]): number {
  if (numbers.length < 2) return 0;
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return numbers.reduce((sum, n) => sum + (n - mean) ** 2, 0) / numbers.length;
}
