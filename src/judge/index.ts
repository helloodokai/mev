import type { z } from "zod";
import { parallelMap } from "../concurrency/index.js";
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
    output_a: "Line 3 has an implicit 'any' from the missing type annotation on parameter 'data'.",
    output_b: "The code looks fine to me, no issues found.",
    expected:
      "A is clearly better: it identifies a specific type error. B gives a vacuous response.",
    verdict: "A",
    score_a: 5,
    score_b: 1,
  },
  {
    input: "Suggest an idiomatic refactor for this function",
    output_a: "Consider refactoring.",
    output_b:
      "Replace the 'for' loop with 'items.filter(x => x.active).map(x => x.name)'. This is more idiomatic TypeScript and eliminates the mutable accumulator.",
    expected: "B is better: it provides a specific, actionable refactoring. A is vague.",
    verdict: "B",
    score_a: 2,
    score_b: 5,
  },
  {
    input: "Review this diff for type safety issues",
    output_a:
      "I notice a few things. The variable on line 2 could be typed more narrowly. Also line 5 uses 'as any'.",
    output_b:
      "Line 5 uses 'as any' which is unsafe. Replace with a proper type guard: 'if (typeof val === \"string\")'. The variable on line 2 could use a narrowing type.",
    expected:
      "B is slightly better: both identify the issues, but B gives an actionable alternative. A is decent but less helpful.",
    verdict: "B",
    score_a: 3,
    score_b: 4,
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

const PAIRWISE_JUDGE_SYSTEM = `You are an impartial pairwise evaluator. You will see two model outputs (Model X and Model Y) for the same input.

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
  const results: JudgeResult[] = [];
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

  const judged = await parallelMap(tasks, (t) => t(), opts.concurrency ?? 4);
  results.push(...judged);
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
    runPairwiseJudge(caseData, modelA.output, modelB.output, provider, model, "X", "Y"),
    runPairwiseJudge(caseData, modelB.output, modelA.output, provider, model, "X", "Y"),
  ]);

  // Position-swap: if A won in first run, B should win in swapped run
  const abWinner = runAB.winner;
  const baWinner = runBA.winner;

  // Map back: in runBA, X=B and Y=A, so "A" in runBA means B actually won
  let originalAB: "A" | "B" | "tie_uncertain";
  let originalBA: "A" | "B" | "tie_uncertain";

  if (abWinner === "A") originalAB = "A";
  else if (abWinner === "B") originalAB = "B";
  else originalAB = "tie_uncertain";

  if (baWinner === "A")
    originalBA = "B"; // X is B in swapped run
  else if (baWinner === "B")
    originalBA = "A"; // Y is A in swapped run
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
      `<example-${i + 1}>\nInput: ${ex.input}\nModel output: ${ex.output_b}\nExpected: ${ex.expected}\nScores: ${JSON.stringify(Object.fromEntries(ex.score_a !== undefined ? [] : []))}\n</example-${i + 1}>`,
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
${promptText}

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
  if (resp.finishReason === "error" || !resp.text) {
    return Object.keys(caseData.rubric).map((criterion) => ({
      criterion,
      score: 0,
      confidence: 0,
      justification: "Judge failed",
    }));
  }

  try {
    const parsed = JudgeOutputSchema.parse(JSON.parse(resp.text));
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
      justification: "Parse error",
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
  if (resp.finishReason === "error" || !resp.text) {
    return {
      winner: "tie_uncertain",
      rationale: "Judge error",
      confidence: 0,
      criterion_scores: Object.keys(caseData.rubric).map((c) => ({
        criterion: c,
        model_a_score: 3,
        model_b_score: 3,
      })),
    };
  }

  try {
    const parsed = PairwiseJudgeOutputSchema.parse(JSON.parse(resp.text));
    // Remap labels back to A/B
    if (labelA !== "A") {
      if (parsed.winner === "A") parsed.winner = "B";
      else if (parsed.winner === "B") parsed.winner = "A";
      // Map criterion scores
      parsed.criterion_scores = parsed.criterion_scores.map((s) => ({
        criterion: s.criterion,
        model_a_score: s.model_b_score,
        model_b_score: s.model_a_score,
      }));
    }
    return parsed;
  } catch {
    return {
      winner: "tie_uncertain",
      rationale: "Parse error",
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
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}
