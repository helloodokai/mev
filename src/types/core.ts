import type { z } from "zod";

// ---------------------------------------------------------------------------
// Brand types for traceability
// ---------------------------------------------------------------------------

export type PromptSha = string & { readonly __brand: "PromptSha" };
export type CaseSetSha = string & { readonly __brand: "CaseSetSha" };
export type RunId = string & { readonly __brand: "RunId" };

export function brandPromptSha(s: string): PromptSha {
  return s as PromptSha;
}
export function brandCaseSetSha(s: string): CaseSetSha {
  return s as CaseSetSha;
}
export function brandRunId(s: string): RunId {
  return s as RunId;
}

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = ["anthropic", "openai", "ollama-cloud", "ollama-local"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelInfo {
  id: string;
  alias: string;
  provider: ProviderId;
  contextWindow: number;
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
  supportsStructuredOutput: boolean;
}

export interface CompletionRequest {
  model: string;
  provider: ProviderId;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseSchema?: z.ZodType;
  minP?: number;
  stopSequences?: string[];
}

export interface CompletionResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number | null;
  finishReason: "stop" | "length" | "tool_use" | "error" | "other";
  raw: unknown;
}

export interface Provider {
  id: ProviderId;
  list(): Promise<ModelInfo[]>;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

// ---------------------------------------------------------------------------
// Task spec (Phase A output)
// ---------------------------------------------------------------------------

export interface TaskSpec {
  taskSummary: string;
  inputs: ReadonlyArray<{ name: string; description: string; example: string }>;
  outputs: ReadonlyArray<{ name: string; description: string; example: string }>;
  successCriteria: ReadonlyArray<string>;
  failureModes: ReadonlyArray<string>;
  difficultyAxes: ReadonlyArray<string>;
  outOfScope: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Eval case (Phase B output)
// ---------------------------------------------------------------------------

export interface CaseRubric {
  readonly [criterion: string]: string;
}

export interface EvalCase {
  id: string;
  generatedAt: string;
  difficultyTier: number;
  evolutions: ReadonlyArray<string>;
  tags: ReadonlyArray<string>;
  input: { content: string };
  reference: {
    output: string;
    synthesizerConfidence: number;
  };
  rubric: CaseRubric;
}

// ---------------------------------------------------------------------------
// Judge types
// ---------------------------------------------------------------------------

export interface JudgeScore {
  criterion: string;
  score: number;
  confidence: number;
  justification: string;
}

export interface JudgeResult {
  caseId: string;
  modelAlias: string;
  promptSha: PromptSha;
  scores: ReadonlyArray<JudgeScore>;
  meanScore: number;
  raw: unknown;
}

export interface PairwiseVerdict {
  caseId: string;
  promptSha: PromptSha;
  modelAAlias: string;
  modelBAlias: string;
  winner: "A" | "B" | "tie_uncertain";
  swappedWinner: "A" | "B" | "tie_uncertain";
  agreement: boolean;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Pareto / Archive types
// ---------------------------------------------------------------------------

export interface FrontierPoint {
  promptSha: PromptSha;
  promptText: string;
  modelAlias: string;
  meanScore: number;
  totalCostUsd: number;
  p95LatencyMs: number;
  generation: number;
}

export interface EvolutionStep {
  generation: number;
  parentId: PromptSha | null;
  childId: PromptSha;
  reflection: string;
  childPrompt: string;
  scores: ReadonlyArray<JudgeScore>;
  meanScore: number;
  costUsd: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Escalation types
// ---------------------------------------------------------------------------

export const ESCALATION_KINDS = [
  "position_swap_disagreement",
  "judge_confidence_below_threshold",
  "inter_rubric_variance",
  "critic_rejection_rate_elevated",
  "critic_per_case_uncertainty",
  "optimizer_plateau",
  "calibration_drift",
  "lockin_preflight",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export interface EscalationEvent {
  kind: EscalationKind;
  priority: number;
  caseId?: string;
  rubricCriterion?: string;
  details: string;
  defaultAction: string;
  proposedResolution?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Run-level types
// ---------------------------------------------------------------------------

export interface RunMeta {
  id: RunId;
  startedAt: string;
  completedAt: string | null;
  mevVersion: string;
  budgetUsd: number;
  budgetMinutes: number;
  generations: number;
  casesTarget: number;
}

export interface ParetoResult {
  frontier: ReadonlyArray<FrontierPoint>;
  kneePointIndex: number;
  runId: RunId;
  caseSetSha: CaseSetSha;
}
