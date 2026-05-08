import type { z } from "zod";
import { isParallelMapError, parallelMap } from "../concurrency/index.js";
import type {
  CompletionRequest,
  EvalCase,
  JudgeResult,
  JudgeScore,
  PairwiseVerdict,
  PromptSha,
  Provider,
} from "../types/index.js";
import { JudgeOutputSchema, PairwiseJudgeOutputSchema } from "../types/index.js";

const CALIBRATION_EXAMPLES = [
  {
    input: "Find the type error in this TypeScript code",
    output: "Line 3 has an implicit 'any' from the missing type annotation on parameter 'data'.",
    expected: "Excellent: identifies a specific type error precisely.",
    scores: { precision: 5, actionability: 5 },
  },
  {
    input: "Suggest an idiomatic refactor for this function",
    output: "Consider refactoring.",
    expected: "Poor: completely vague, no actionable advice.",
    scores: { precision: 1, actionability: 1 },
  },
  {
    input: "Review this diff for type safety issues",
    output:
      "Line 5 uses 'as any' which is unsafe. Replace with a proper type guard: 'if (typeof val === \"string\")'. The variable on line 2 could use a narrowing type.",
    expected: "Good: identifies issues AND provides actionable fixes.",
    scores: { precision: 4, actionability: 5 },
  },
];

const ABSOLUTE_JUDGE_SYSTEM = `You are an impartial evaluator. Score each rubric criterion independently on a 1-5 scale using the behavioral anchors provided.

Rules:
- Score-then-explain: give the numeric score FIRST, then justify.
- Length is NOT a quality signal. A concise correct answer beats a verbose one.
- Do not favor one model due to verbosity.
- Use the full 1-5 range. Do not cluster around 3.
- Apply each criterion's behavioral anchor literally.

Output valid JSON:
{
  "scores": [{"criterion": "...", "score": 1-5, "confidence": 0.0-1.0, "justification": "..."}],
  "overall_assessment": "brief summary"
}`;

const PAIRWISE_JUDGE_SYSTEM = `You are an impartial pairwise evaluator. You will see two model outputs (Model A and Model B) for the same input.

Rules:
- Do NOT favor longer outputs. Length is not quality.
- Do NOT favor any particular style unless the rubric explicitly requires it.
- Evaluate each criterion independently.
- Score-then-explain.
- Use the full 1-5 range.

Output valid JSON:
{
  "winner": "A" | "B" | "tie_uncertain",
  "rationale": "...",
  "confidence": 0.0-1.0,
  "criterion_scores": [{"criterion": "...", "model_a_score": 1-5, "model_b_score": 1-5}]
}`;

export interface JudgeOptions {
  provider: Provider; // judge provider
  model: string; // judge model
  cases: ReadonlyArray<EvalCase>;
  models: ReadonlyArray<{ alias: string; promptSha: PromptSha; promptText: string }>;
  caseSetSha: string;
  concurrency?: number;
  completionProvider: Provider; // provider used to run the prompts being judged
  completionModel: string; // model used to run the prompts being judged
}

async function executePrompt(
  promptText: string,
  caseData: EvalCase,
  provider: Provider,
  model: string,
): Promise<{ text: string; latencyMs: number; costUsd: number | null; finishReason: string }> {
  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: promptText,
    userPrompt: caseData.input.content,
    temperature: 0.2,
    maxTokens: 2048,
  };
  const resp = await provider.complete(request);
  return {
    text: resp.text,
    latencyMs: resp.latencyMs,
    costUsd: resp.costUsd,
    finishReason: resp.finishReason,
  };
}

export async function judgeAbsolute(opts: JudgeOptions): Promise<JudgeResult[]> {
  const tasks: Array<() => Promise<JudgeResult>> = [];

  for (const modelConfig of opts.models) {
    for (const case_ of opts.cases) {
      tasks.push(async () => {
        // 1. Execute the prompt to get real model output
        const execution = await executePrompt(
          modelConfig.promptText,
          case_,
          opts.completionProvider,
          opts.completionModel,
        );

        // 2. Judge the actual output
        const scores = await runAbsoluteJudge(case_, execution.text, opts.provider, opts.model);
        return {
          caseId: case_.id,
          modelAlias: modelConfig.alias,
          promptSha: modelConfig.promptSha,
          scores,
          meanScore: scores.reduce((sum, s) => sum + s.score, 0) / Math.max(scores.length, 1),
          raw: { execution, scores },
        };
      });
    }
  }

  const judged = await parallelMap(tasks, (t) => t(), opts.concurrency ?? 2, 180_000);
  const results: JudgeResult[] = [];
  for (const item of judged) {
    if (isParallelMapError(item)) {
      // Create a placeholder result for the failed task
      // We need to know which case/model this was for, but we lost that context
      // In practice, we should log this
      console.warn(`[judgeAbsolute] Task failed: ${item.__error}`);
      continue;
    }
    results.push(item);
  }
  return results;
}

export async function judgePairwise(
  caseData: EvalCase,
  modelA: { alias: string; promptSha: PromptSha; promptText: string; output: string },
  modelB: { alias: string; promptSha: PromptSha; promptText: string; output: string },
  provider: Provider,
  model: string,
): Promise<PairwiseVerdict> {
  const [runAB, runBA] = await Promise.all([
    runPairwiseJudge(caseData, modelA.output, modelB.output, provider, model, "A", "B"),
    runPairwiseJudge(caseData, modelB.output, modelA.output, provider, model, "B", "A"),
  ]);

  // Position-swap: if A won in first run, B should win in swapped run
  const abWinner = runAB.winner;
  const baWinner = runBA.winner;

  // In runAB: labels are A=A, B=B - no remapping needed
  // In runBA: labels are A=B, B=A, so "A" means B won, "B" means A won
  let originalAB: "A" | "B" | "tie_uncertain";
  let originalBA: "A" | "B" | "tie_uncertain";

  if (abWinner === "A") originalAB = "A";
  else if (abWinner === "B") originalAB = "B";
  else originalAB = "tie_uncertain";

  if (baWinner === "A") originalBA = "B"; // "A" in runBA means model B won
  else if (baWinner === "B") originalBA = "A"; // "B" in runBA means model A won
  else originalBA = "tie_uncertain";

  const agreement = originalAB === originalBA;

  let finalWinner: "A" | "B" | "tie_uncertain";
  if (!agreement) {
    finalWinner = "tie_uncertain";
  } else {
    finalWinner = originalAB;
  }

  return {
    caseId: caseData.id,
    promptSha: modelA.promptSha,
    modelAAlias: modelA.alias,
    modelBAlias: modelB.alias,
    winner: finalWinner,
    swappedWinner: originalBA,
    agreement,
    rationale: runAB.rationale,
  };
}

async function runAbsoluteJudge(
  caseData: EvalCase,
  promptText: string,
  provider: Provider,
  model: string,
): Promise<JudgeScore[]> {
  const rubricText = Object.entries(caseData.rubric)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const calibration = CALIBRATION_EXAMPLES.map(
    (ex, i) =>
      `<example-${i + 1}>\nInput: ${ex.input}\nModel output: ${ex.output}\nExpected: ${ex.expected}\nScores: ${JSON.stringify(ex.scores)}\n</example-${i + 1}>`,
  ).join("\n\n");

  const userPrompt = `## Task
Evaluate the model output for this case.

## Rubric
${rubricText}

## Input
${caseData.input.content}

## Reference Output (strong signal, not the only valid answer)
${caseData.reference.output}

## Model Output to Evaluate
${stripThinking(promptText)}

## Calibration Examples (score patterns)
${calibration}

Score each rubric criterion 1-5. Output JSON.`;

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: ABSOLUTE_JUDGE_SYSTEM,
    userPrompt,
    temperature: 0,
    maxTokens: 2048,
    responseSchema: JudgeOutputSchema,
  };

  const resp = await provider.complete(request);
  if (resp.finishReason === "error") {
    return Object.keys(caseData.rubric).map((criterion) => ({
      criterion,
      score: 0,
      confidence: 0,
      justification: `Judge failed: ${JSON.stringify(resp.raw)}`,
    }));
  }

  try {
    const parsed = JudgeOutputSchema.parse(JSON.parse(resp.text || "{}"));
    return parsed.scores.map((s) => ({
      criterion: s.criterion,
      score: Math.max(1, Math.min(5, Math.round(s.score))),
      confidence: s.confidence,
      justification: s.justification,
    }));
  } catch {
    return Object.keys(caseData.rubric).map((criterion) => ({
      criterion,
      score: 0,
      confidence: 0,
      justification: `Parse error: ${resp.text?.slice(0, 200) || "empty"}`,
    }));
  }
}

async function runPairwiseJudge(
  caseData: EvalCase,
  outputA: string,
  outputB: string,
  provider: Provider,
  model: string,
  labelA: string,
  labelB: string,
): Promise<z.infer<typeof PairwiseJudgeOutputSchema>> {
  const rubricText = Object.entries(caseData.rubric)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const userPrompt = `## Rubric
${rubricText}

## Input
${caseData.input.content}

## Model ${labelA} Output
${stripThinking(outputA)}

## Model ${labelB} Output
${stripThinking(outputB)}

Evaluate both outputs. Output JSON.`;

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: PAIRWISE_JUDGE_SYSTEM,
    userPrompt,
    temperature: 0,
    maxTokens: 2048,
    responseSchema: PairwiseJudgeOutputSchema,
  };

  const resp = await provider.complete(request);
  if (resp.finishReason === "error") {
    return {
      winner: "tie_uncertain",
      rationale: `Judge error: ${JSON.stringify(resp.raw)}`,
      confidence: 0,
      criterion_scores: Object.keys(caseData.rubric).map((c) => ({
        criterion: c,
        model_a_score: 3,
        model_b_score: 3,
      })),
    };
  }

  try {
    const parsed = PairwiseJudgeOutputSchema.parse(JSON.parse(resp.text || "{}"));
    // If labels are not the standard A/B, we need to understand the mapping
    // In our current usage, labelA is either "A" or "B", and labelB is the other
    // We don't do remapping here anymore - the caller handles it
    return parsed;
  } catch {
    return {
      winner: "tie_uncertain",
      rationale: `Parse error: ${resp.text?.slice(0, 200) || "empty"}`,
      confidence: 0,
      criterion_scores: Object.keys(caseData.rubric).map((c) => ({
        criterion: c,
        model_a_score: 3,
        model_b_score: 3,
      })),
    };
  }
}

export function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
}