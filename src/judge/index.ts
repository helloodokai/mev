import type { z } from "zod";
import { isParallelMapError, parallelMap } from "../concurrency/index.js";
import type {
  CompletionRequest,
  EvalCase,
  FewShotExample,
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

interface ValidationIssue {
  cap: number;
  message: string;
}

const ALLOWED_INTENT_CAPABILITIES = new Set([
  "web_search",
  "file_read",
  "file_write",
  "email",
  "database",
  "api_call",
  "code_execution",
  "image_generation",
  "summarization",
  "data_export",
  "notification",
  "calendar",
  "spreadsheet",
]);

const INTENT_PARSER_KEYS = [
  "intentType",
  "scheduleCron",
  "requiredCapabilities",
  "clarifyingQuestions",
  "domainContext",
  "description",
] as const;

export interface JudgeOptions {
  provider: Provider; // judge provider
  model: string; // judge model
  cases: ReadonlyArray<EvalCase>;
  models: ReadonlyArray<{
    alias: string;
    promptSha: PromptSha;
    promptText: string;
    examples?: ReadonlyArray<FewShotExample>;
  }>;
  caseSetSha: string;
  concurrency?: number;
  completionProvider: Provider; // provider used to run the prompts being judged
  completionModel: string; // model used to run the prompts being judged
  judgeSamples?: number; // self-consistency: # of judge samples (default 1)
  bestOfN?: number; // best-of-N inference: run completion N times, judge picks best
}

async function executePrompt(
  promptText: string,
  caseData: EvalCase,
  provider: Provider,
  model: string,
  examples?: ReadonlyArray<FewShotExample>,
  temperature = 0.2,
): Promise<{ text: string; latencyMs: number; costUsd: number | null; finishReason: string }> {
  // Build user prompt with optional few-shot examples
  let userPrompt = caseData.input.content;
  if (examples && examples.length > 0) {
    const exampleBlock = examples
      .map(
        (ex, i) =>
          `## Example ${i + 1}\nInput:\n${ex.input}\n\nExpected Output:\n${ex.output}`,
      )
      .join("\n\n");
    userPrompt = `${exampleBlock}\n\n## Now do the following:\n${caseData.input.content}`;
  }

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: promptText,
    userPrompt,
    temperature,
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

/**
 * Self-consistency judge: runs N samples and aggregates by median per-criterion.
 * The variance is preserved as confidence-weakening when high.
 */
async function runAbsoluteJudgeWithConsistency(
  caseData: EvalCase,
  output: string,
  provider: Provider,
  model: string,
  nSamples: number,
): Promise<JudgeScore[]> {
  if (nSamples <= 1) {
    return runAbsoluteJudge(caseData, output, provider, model);
  }
  const sampleTasks = Array.from({ length: nSamples }, () =>
    runAbsoluteJudge(caseData, output, provider, model, 0.3 + Math.random() * 0.4),
  );
  const samples = await Promise.all(sampleTasks);

  // Aggregate per criterion: median score, mean confidence, attenuated by inter-sample variance
  const criteria = new Set<string>();
  for (const s of samples) for (const sc of s) criteria.add(sc.criterion);

  const aggregated: JudgeScore[] = [];
  for (const criterion of criteria) {
    const scoresForC: number[] = [];
    const confidencesForC: number[] = [];
    const justifications: string[] = [];
    for (const sample of samples) {
      const found = sample.find((sc) => sc.criterion === criterion);
      if (found) {
        scoresForC.push(found.score);
        confidencesForC.push(found.confidence);
        justifications.push(found.justification);
      }
    }
    if (scoresForC.length === 0) continue;
    const sorted = [...scoresForC].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] ?? 3) + (sorted[mid] ?? 3)) / 2)
        : sorted[mid] ?? 3;
    const mean = scoresForC.reduce((a, b) => a + b, 0) / scoresForC.length;
    const variance =
      scoresForC.reduce((sum, n) => sum + (n - mean) ** 2, 0) / scoresForC.length;
    const baseConf = confidencesForC.reduce((a, b) => a + b, 0) / confidencesForC.length;
    // Attenuate confidence by variance (high variance = low confidence)
    const attenuated = baseConf * Math.max(0, 1 - variance / 4);
    aggregated.push({
      criterion,
      score: median,
      confidence: attenuated,
      justification:
        scoresForC.length > 1
          ? `[SC mean=${mean.toFixed(2)} var=${variance.toFixed(2)}] ${justifications[0] ?? ""}`
          : justifications[0] ?? "",
    });
  }
  return aggregated;
}

export async function judgeAbsolute(opts: JudgeOptions): Promise<JudgeResult[]> {
  const tasks: Array<() => Promise<JudgeResult>> = [];
  const judgeSamples = opts.judgeSamples ?? 1;
  const bestOfN = opts.bestOfN ?? 1;

  for (const modelConfig of opts.models) {
    for (const case_ of opts.cases) {
      tasks.push(async () => {
        // 1. Execute the prompt N times if best-of-N is enabled
        let bestExecution: Awaited<ReturnType<typeof executePrompt>> | null = null;
        let bestScores: JudgeScore[] | null = null;
        let bestMean = -Infinity;

        const runsToTry = Math.max(1, bestOfN);
        for (let attempt = 0; attempt < runsToTry; attempt++) {
          // Vary temperature slightly between attempts for diversity
          const baseTemp = defaultExecutionTemperature(case_);
          const temp = bestOfN > 1 ? baseTemp + attempt * 0.1 : baseTemp;
          const execution = await executePrompt(
            modelConfig.promptText,
            case_,
            opts.completionProvider,
            opts.completionModel,
            modelConfig.examples,
            temp,
          );
          // Judge this candidate
          const scores = await runAbsoluteJudgeWithConsistency(
            case_,
            execution.text,
            opts.provider,
            opts.model,
            judgeSamples,
          );
          const validatedScores = applyDeterministicValidators(case_, execution.text, scores);
          const mean =
            validatedScores.reduce((sum, s) => sum + s.score, 0) / Math.max(validatedScores.length, 1);
          if (mean > bestMean) {
            bestMean = mean;
            bestExecution = execution;
            bestScores = validatedScores;
          }
          // Early exit if perfect
          if (mean >= 5 && bestOfN > 1) break;
        }

        const execution = bestExecution!;
        const scores = bestScores ?? [];
        return {
          caseId: case_.id,
          modelAlias: modelConfig.alias,
          promptSha: modelConfig.promptSha,
          scores,
          meanScore: bestMean === -Infinity ? 0 : bestMean,
          raw: { execution, scores, attempts: runsToTry },
        };
      });
    }
  }

  const judged = await parallelMap(tasks, (t) => t(), opts.concurrency ?? 2, 240_000);
  const results: JudgeResult[] = [];
  for (const item of judged) {
    if (isParallelMapError(item)) {
      console.warn(`[judgeAbsolute] Task failed: ${item.__error}`);
      continue;
    }
    results.push(item);
  }
  return results;
}

function defaultExecutionTemperature(caseData: EvalCase): number {
  const reference = caseData.reference.output.trim();
  if (looksLikeJson(reference)) return 0;
  if (/\[REDACTED_[A-Z_]+\]/.test(reference)) return 0;
  return 0.2;
}

export function applyDeterministicValidators(
  caseData: EvalCase,
  output: string,
  scores: ReadonlyArray<JudgeScore>,
): JudgeScore[] {
  const issues = collectValidationIssues(caseData, output);
  if (issues.length === 0) return [...scores];

  const cap = Math.max(0, Math.min(...issues.map((issue) => issue.cap)));
  const note = `[auto-validator] ${issues.map((issue) => issue.message).join("; ")}`;
  return scores.map((score) => ({
    ...score,
    score: Math.min(score.score, cap),
    justification: `${note} | ${score.justification}`,
  }));
}

export function collectValidationIssues(caseData: EvalCase, output: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trimmedOutput = stripThinking(output).trim();
  const reference = caseData.reference.output.trim();
  const input = caseData.input.content.trim();

  const singleSentenceIssues = collectSingleSentenceActionIssues(input, reference, trimmedOutput);
  issues.push(...singleSentenceIssues);

  if (reference === input && trimmedOutput !== reference) {
    issues.push({
      cap: 1,
      message: "expected unchanged output for a no-op case",
    });
  }

  if (looksLikeJson(reference)) {
    if (!isValidJson(trimmedOutput)) {
      issues.push({
        cap: 1,
        message: "expected valid JSON output",
      });
    } else {
      const schemaIssues = collectJsonShapeIssues(caseData, reference, trimmedOutput);
      issues.push(...schemaIssues);
      const intentIssues = collectIntentParserIssues(reference, trimmedOutput);
      issues.push(...intentIssues);
    }
  }

  const requiredRedactionTokens = Array.from(
    new Set(reference.match(/\[REDACTED_[A-Z_]+\]/g) ?? []),
  );
  if (requiredRedactionTokens.length > 0) {
    const missingTokens = requiredRedactionTokens.filter((token) => !trimmedOutput.includes(token));
    if (missingTokens.length > 0) {
      issues.push({
        cap: 2,
        message: `missing required redaction token(s): ${missingTokens.join(", ")}`,
      });
    }
  }

  return issues;
}

function collectSingleSentenceActionIssues(
  input: string,
  reference: string,
  output: string,
): ValidationIssue[] {
  if (!/reply with only the single next sentence/i.test(input)) return [];
  if (looksLikeJson(reference)) return [];

  const issues: ValidationIssue[] = [];
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [{ cap: 1, message: "expected a single concise action sentence" }];
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    issues.push({ cap: 3, message: "single-sentence action should not be wrapped in quotes" });
  }

  const sentenceCount = countSentences(trimmed);
  if (sentenceCount > 1) {
    issues.push({ cap: 2, message: "expected exactly one sentence" });
  }

  const referenceIsQuestion = reference.trim().endsWith("?");
  const outputIsQuestion = trimmed.endsWith("?");
  if (referenceIsQuestion !== outputIsQuestion) {
    issues.push({
      cap: 3,
      message: referenceIsQuestion
        ? "expected a single blocking question"
        : "expected an action sentence, not a question",
    });
  }

  const referenceWordCount = countWords(reference);
  const outputWordCount = countWords(trimmed);
  const maxWords = Math.max(18, Math.round(referenceWordCount * 1.8));
  if (outputWordCount > maxWords) {
    issues.push({
      cap: 3,
      message: `single-sentence action is too verbose (${outputWordCount} words > ${maxWords})`,
    });
  }

  return issues;
}

function countSentences(text: string): number {
  const normalized = text.trim();
  if (normalized.length === 0) return 0;
  const matches = normalized.match(/[.!?](?:\s|$)/g);
  return matches ? matches.length : 1;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function collectIntentParserIssues(reference: string, output: string): ValidationIssue[] {
  const referenceJson = JSON.parse(reference) as unknown;
  if (!looksLikeIntentParserShape(referenceJson)) return [];

  const issues: ValidationIssue[] = [];
  const outputJson = JSON.parse(output) as unknown;
  if (typeof outputJson !== "object" || outputJson === null || Array.isArray(outputJson)) {
    return [{ cap: 1, message: "expected intent parser JSON object" }];
  }

  const outputRecord = outputJson as Record<string, unknown>;
  const missingKeys = INTENT_PARSER_KEYS.filter((key) => !(key in outputRecord));
  if (missingKeys.length > 0) {
    issues.push({ cap: 1, message: `missing intent parser key(s): ${missingKeys.join(", ")}` });
  }

  const extraKeys = Object.keys(outputRecord).filter(
    (key) => !INTENT_PARSER_KEYS.includes(key as (typeof INTENT_PARSER_KEYS)[number]),
  );
  if (extraKeys.length > 0) {
    issues.push({ cap: 2, message: `unexpected intent parser key(s): ${extraKeys.join(", ")}` });
  }

  if (
    "intentType" in outputRecord &&
    outputRecord["intentType"] !== "one-time" &&
    outputRecord["intentType"] !== "recurring"
  ) {
    issues.push({ cap: 1, message: "intentType must be one-time or recurring" });
  }

  if ("scheduleCron" in outputRecord && !isValidIntentCronValue(outputRecord["scheduleCron"])) {
    issues.push({ cap: 1, message: "scheduleCron must be null or a valid 5-field cron" });
  }

  if ("requiredCapabilities" in outputRecord) {
    if (!Array.isArray(outputRecord["requiredCapabilities"])) {
      issues.push({ cap: 1, message: "requiredCapabilities must be a string array" });
    } else {
      const invalidCapabilities = outputRecord["requiredCapabilities"].filter(
        (cap) => typeof cap !== "string" || !ALLOWED_INTENT_CAPABILITIES.has(cap),
      );
      if (invalidCapabilities.length > 0) {
        issues.push({
          cap: 1,
          message: `requiredCapabilities contains invalid value(s): ${invalidCapabilities.join(", ")}`,
        });
      }
    }
  }

  if (
    "clarifyingQuestions" in outputRecord &&
    (!Array.isArray(outputRecord["clarifyingQuestions"]) ||
      outputRecord["clarifyingQuestions"].some((value) => typeof value !== "string"))
  ) {
    issues.push({ cap: 1, message: "clarifyingQuestions must be a string array" });
  }

  if (
    "domainContext" in outputRecord &&
    (typeof outputRecord["domainContext"] !== "string" || outputRecord["domainContext"].trim().length === 0)
  ) {
    issues.push({ cap: 2, message: "domainContext must be a non-empty string" });
  }

  if (
    "description" in outputRecord &&
    (typeof outputRecord["description"] !== "string" || outputRecord["description"].trim().length === 0)
  ) {
    issues.push({ cap: 2, message: "description must be a non-empty string" });
  }

  return issues;
}

function looksLikeIntentParserShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return INTENT_PARSER_KEYS.every((key) => key in record);
}

function isValidIntentCronValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^([\d*/,-]+)$/.test(part));
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function collectJsonShapeIssues(
  caseData: EvalCase,
  reference: string,
  output: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const referenceJson = JSON.parse(reference) as unknown;
  const outputJson = JSON.parse(output) as unknown;

  if (Array.isArray(referenceJson) !== Array.isArray(outputJson)) {
    issues.push({ cap: 2, message: "expected matching JSON root type" });
    return issues;
  }

  const referenceContainer = getPrimaryEntityContainer(referenceJson);
  const outputContainer = getPrimaryEntityContainer(outputJson);

  if (referenceContainer.kind === "entities-array" && outputContainer.kind !== "entities-array") {
    issues.push({ cap: 2, message: "missing expected JSON field(s): entities" });
    return issues;
  }

  if (referenceContainer.kind !== outputContainer.kind) {
    issues.push({ cap: 2, message: "expected matching entity container shape" });
    return issues;
  }

  if (referenceContainer.kind === "entities-array" && !outputContainer.hasEntitiesKey) {
    issues.push({ cap: 2, message: "missing expected JSON field(s): entities" });
    return issues;
  }

  const rubricText = Object.entries(caseData.rubric)
    .flatMap(([key, value]) => [key, value])
    .join(" ")
    .toLowerCase();
  const requiredFields = new Set<string>();
  const referenceSample = referenceContainer.sample;
  if (referenceSample && typeof referenceSample === "object" && referenceSample !== null) {
    if ("text" in referenceSample) requiredFields.add("text");
    if (rubricText.includes("'start'") || rubricText.includes(" start")) requiredFields.add("start");
    if ("type" in referenceSample || "entity_type" in referenceSample) requiredFields.add("type");
  }

  const outputSample = outputContainer.sample;
  if (requiredFields.size === 0 || !outputSample || typeof outputSample !== "object") return issues;

  const missingFields = [...requiredFields].filter((field) => {
    if (field === "type") {
      return !(
        "type" in (outputSample as Record<string, unknown>) ||
        "entity_type" in (outputSample as Record<string, unknown>)
      );
    }
    return !(field in (outputSample as Record<string, unknown>));
  });

  if (missingFields.length > 0) {
    const prefix = outputContainer.kind === "entities-array" ? "entities[]" : "[]";
    issues.push({
      cap: 2,
      message: `missing expected JSON field(s): ${missingFields.map((field) => `${prefix}.${field}`).join(", ")}`,
    });
  }

  return issues;
}

function getPrimaryEntityContainer(value: unknown): {
  kind: "array" | "entities-array" | "other";
  sample?: unknown;
  hasEntitiesKey?: boolean;
} {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      sample: value.find((item) => typeof item === "object" && item !== null) ?? value[0],
    };
  }
  if (typeof value === "object" && value !== null && "entities" in value) {
    const entities = (value as { entities?: unknown }).entities;
    if (Array.isArray(entities)) {
      return {
        kind: "entities-array",
        sample: entities.find((item) => typeof item === "object" && item !== null) ?? entities[0],
        hasEntitiesKey: true,
      };
    }
  }
  return { kind: "other" };
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
  temperature = 0,
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
    temperature,
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
