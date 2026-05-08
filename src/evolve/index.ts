import { computePromptSha } from "../config/loader.js";
import { judgeAbsolute } from "../judge/index.js";
import type {
  CompletionRequest,
  EvalCase,
  EvolutionStep,
  FewShotExample,
  FrontierPoint,
  JudgeResult,
  JudgeScore,
  Provider,
  TaskSpec,
} from "../types/index.js";
import { EditedPromptSchema, EvolutionReflectionSchema } from "../types/index.js";
import { brandPromptSha } from "../types/index.js";
import type { EditedPrompt, EvolutionReflection } from "../types/index.js";
import {
  type ParetoArchive,
  addEvolutionStep,
  createArchive,
  paretoUpdate,
  topKDiverseBeam,
} from "./archive.js";

const REFLECTOR_SYSTEM_PROMPT = `You are a prompt optimization reflector. Given a system prompt and a set of failure cases (with judge scores per criterion), analyze WHY the prompt failed and propose specific edits.

Your output must be structured JSON:
{
  "critique": "natural-language analysis identifying which criteria scored worst and why",
  "proposed_edit_description": "specific description of what to add/change/remove from the prompt",
  "rationale": "why this edit is expected to improve performance on the failing cases"
}

Be specific. Don't say "make it better" — say "add an instruction to verify edge cases before processing, because cases 2 and 3 scored 2/5 on the 'handles empty input' criterion."`;

const EDITOR_SYSTEM_PROMPT = `You are a prompt editor. Given the current prompt and a reflection proposing changes, produce a revised system prompt.

Rules:
- Preserve the prompt's overall structure and intent
- Make ONLY the changes proposed in the reflection
- Do not remove working instructions
- Be concise — every line should earn its place
- The output must be a complete, standalone system prompt

Output valid JSON:
{
  "prompt": "the complete revised system prompt",
  "changes_made": ["change1", "change2", ...],
  "expected_improvement": "what this should fix"
}`;

const CROSSOVER_SYSTEM_PROMPT = `You are a prompt-crossover specialist. Given TWO parent prompts that each scored well on different cases, create a CHILD prompt that combines the strengths of both.

Your goal: identify the unique strengths of each parent and merge them coherently. Do NOT just concatenate — synthesize.

Output valid JSON:
{
  "prompt": "the merged system prompt",
  "changes_made": ["what was taken from parent A", "what was taken from parent B", "how they were combined"],
  "expected_improvement": "what this combination should achieve"
}`;

export interface EvolutionConfig {
  provider: Provider; // synthesis / editing model
  model: string;
  judgeProvider: Provider; // judge model
  judgeModel: string;
  completionProvider: Provider; // model that executes prompts
  completionModel: string;
  generations: number;
  cases: EvalCase[]; // train cases only (holdout=false)
  starterPrompt: string;
  taskSpec: TaskSpec;
  maxCostUsd: number;
  concurrency?: number;
  // New: best-in-class controls
  beamWidth?: number; // top-K beam (default 3)
  judgeSamples?: number; // self-consistency
  crossoverRate?: number; // 0..1
  maxExamples?: number; // few-shot bootstrap
}

export async function evolvePrompt(
  config: EvolutionConfig,
  onGeneration?: (step: EvolutionStep) => void,
): Promise<ParetoArchive> {
  let archive = createArchive();
  const beamWidth = Math.max(1, config.beamWidth ?? 3);
  const crossoverRate = Math.max(0, Math.min(1, config.crossoverRate ?? 0.3));
  const judgeSamples = Math.max(1, config.judgeSamples ?? 1);
  const maxExamples = Math.max(0, config.maxExamples ?? 0);

  // Score the starter prompt first so we have a real baseline in the archive
  const starterSha = computePromptSha(config.starterPrompt);
  const starterStartTime = performance.now();
  const starterResults = await judgeAbsolute({
    provider: config.judgeProvider,
    model: config.judgeModel,
    cases: config.cases,
    models: [
      {
        alias: config.model,
        promptSha: brandPromptSha(starterSha),
        promptText: config.starterPrompt,
      },
    ],
    caseSetSha: "",
    concurrency: config.concurrency ?? 2,
    completionProvider: config.completionProvider,
    completionModel: config.completionModel,
    judgeSamples,
  });
  const starterElapsed = performance.now() - starterStartTime;
  const starterScore =
    starterResults.reduce((sum, r) => sum + r.meanScore, 0) /
    Math.max(starterResults.length, 1);
  const starterPoint: FrontierPoint = {
    promptSha: brandPromptSha(starterSha),
    promptText: config.starterPrompt,
    modelAlias: config.model,
    meanScore: starterScore,
    totalCostUsd: 0,
    p95LatencyMs: Math.round(starterElapsed),
    generation: 0,
    examples: [],
  };
  archive = paretoUpdate(archive, starterPoint);

  let totalCost = 0;
  let generationsWithoutImprovement = 0;
  let bestEverScore = starterScore;
  // Track per-prompt judge results so we can find each prompt's worst cases for reflection
  const resultsByPromptSha = new Map<string, JudgeResult[]>();
  resultsByPromptSha.set(starterSha, starterResults);

  for (let gen = 1; gen <= config.generations; gen++) {
    if (totalCost >= config.maxCostUsd) {
      console.log(`[Evolution] Cost budget exceeded at gen ${gen}, stopping.`);
      break;
    }

    // Pick top-K diverse beam from archive
    const beam = topKDiverseBeam(archive, beamWidth);
    if (beam.length === 0) break;

    // For each beam member, generate one child (mutation or crossover)
    const childPromises: Array<Promise<EvolutionStep | null>> = [];
    for (let bi = 0; bi < beam.length; bi++) {
      const parent = beam[bi];
      if (!parent) continue;
      const useCrossover = beam.length >= 2 && Math.random() < crossoverRate;

      if (useCrossover) {
        // Pick a different parent from the beam for crossover
        const otherIdx = (bi + 1 + Math.floor(Math.random() * (beam.length - 1))) % beam.length;
        const otherParent = beam[otherIdx];
        if (otherParent && otherParent.promptSha !== parent.promptSha) {
          childPromises.push(
            crossoverChild(parent, otherParent, config, gen, resultsByPromptSha, judgeSamples),
          );
          continue;
        }
      }
      // Default: mutation
      childPromises.push(
        mutationChild(parent, config, gen, resultsByPromptSha, judgeSamples, maxExamples),
      );
    }

    const childResults = await Promise.all(childPromises);

    // Merge children into archive
    let bestChildScore = -Infinity;
    for (const step of childResults) {
      if (!step) continue;
      const childPoint: FrontierPoint = {
        promptSha: step.childId,
        promptText: step.childPrompt,
        modelAlias: config.model,
        meanScore: step.meanScore,
        totalCostUsd: step.costUsd,
        p95LatencyMs: 0,
        generation: gen,
        parents: step.parents ?? [],
      };
      archive = paretoUpdate(archive, childPoint);
      archive = addEvolutionStep(archive, step);
      totalCost += step.costUsd;
      bestChildScore = Math.max(bestChildScore, step.meanScore);
      if (onGeneration) onGeneration(step);
    }

    // Plateau check: did we improve over the best ever?
    if (bestChildScore <= bestEverScore + 0.01) {
      generationsWithoutImprovement++;
      if (generationsWithoutImprovement >= 3) {
        console.log(
          `[Evolution] Plateau detected after ${generationsWithoutImprovement} gens without improvement (best=${bestEverScore.toFixed(2)}). Stopping early.`,
        );
        break;
      }
    } else {
      generationsWithoutImprovement = 0;
      bestEverScore = bestChildScore;
    }
  }

  return archive;
}

/**
 * Apply a single mutation: reflect → edit → score.
 */
async function mutationChild(
  parent: FrontierPoint,
  config: EvolutionConfig,
  gen: number,
  resultsByPromptSha: Map<string, JudgeResult[]>,
  judgeSamples: number,
  maxExamples: number,
): Promise<EvolutionStep | null> {
  // Identify worst-performing cases for this parent (for reflection)
  const parentResults = resultsByPromptSha.get(parent.promptSha) ?? [];
  const failures = getWorstCases(config.cases, parentResults, 3);

  // Reflect
  const reflection = await reflect(
    parent.promptText,
    failures,
    parentResults,
    config.taskSpec,
    config.provider,
    config.model,
  );

  // Edit
  const edited = await editPrompt(parent.promptText, reflection, config.provider, config.model);

  // Optionally bootstrap few-shot examples from parent's strongest cases
  let examples: FewShotExample[] | undefined;
  if (maxExamples > 0 && parentResults.length > 0) {
    const sortedByScore = [...parentResults].sort((a, b) => b.meanScore - a.meanScore);
    const topResults = sortedByScore.slice(0, maxExamples);
    const bootstrapped: FewShotExample[] = [];
    for (const r of topResults) {
      const matchingCase = config.cases.find((c) => c.id === r.caseId);
      if (!matchingCase) continue;
      const raw = r.raw as { execution?: { text?: string } };
      const output = raw?.execution?.text;
      if (output && r.meanScore >= 4) {
        bootstrapped.push({
          input: matchingCase.input.content,
          output,
          caseId: matchingCase.id,
        });
      }
    }
    if (bootstrapped.length > 0) examples = bootstrapped;
  }

  // Score child
  const childSha = computePromptSha(edited.prompt);
  const childModel: {
    alias: string;
    promptSha: ReturnType<typeof brandPromptSha>;
    promptText: string;
    examples?: ReadonlyArray<FewShotExample>;
  } = {
    alias: config.model,
    promptSha: brandPromptSha(childSha),
    promptText: edited.prompt,
  };
  if (examples && examples.length > 0) childModel.examples = examples;

  const childResults = await judgeAbsolute({
    provider: config.judgeProvider,
    model: config.judgeModel,
    cases: config.cases,
    models: [childModel],
    caseSetSha: "",
    concurrency: config.concurrency ?? 2,
    completionProvider: config.completionProvider,
    completionModel: config.completionModel,
    judgeSamples,
  });
  resultsByPromptSha.set(childSha, childResults);

  const meanScore =
    childResults.reduce((sum, r) => sum + r.meanScore, 0) / Math.max(childResults.length, 1);

  const genCost =
    (reflection.costUsd ?? 0) +
    (edited.costUsd ?? 0) +
    childResults.reduce((sum, r) => {
      const raw = r.raw as { execution?: { costUsd: number | null } };
      return sum + (raw?.execution?.costUsd ?? 0);
    }, 0);

  return {
    generation: gen,
    parentId: parent.promptSha,
    childId: brandPromptSha(childSha),
    reflection: reflection.result.critique,
    childPrompt: edited.prompt,
    scores: childResults.flatMap((r) => r.scores as JudgeScore[]),
    meanScore,
    costUsd: genCost,
    timestamp: new Date().toISOString(),
    operator: "mutate",
    parents: [parent.promptSha],
  } satisfies EvolutionStep & { _latencyMs?: number; _examples?: FewShotExample[] };
}

/**
 * Apply crossover: combine instructions from two parents.
 */
async function crossoverChild(
  parentA: FrontierPoint,
  parentB: FrontierPoint,
  config: EvolutionConfig,
  gen: number,
  resultsByPromptSha: Map<string, JudgeResult[]>,
  judgeSamples: number,
): Promise<EvolutionStep | null> {
  // Use the editor with crossover system prompt
  const userPrompt = `## Parent A (score: ${parentA.meanScore.toFixed(2)})
${parentA.promptText}

## Parent B (score: ${parentB.meanScore.toFixed(2)})
${parentB.promptText}

## Task
${config.taskSpec.taskSummary}

Synthesize a child prompt combining the strengths of both parents.`;

  const request: CompletionRequest = {
    model: config.model,
    provider: config.provider.id,
    systemPrompt: CROSSOVER_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.4,
    maxTokens: 4096,
    responseSchema: EditedPromptSchema,
  };

  const resp = await config.provider.complete(request);
  let edited: EditedPrompt;
  try {
    edited = EditedPromptSchema.parse(JSON.parse(resp.text || "{}"));
  } catch {
    // Fall back to picking the higher-scoring parent
    edited = {
      prompt: parentA.meanScore >= parentB.meanScore ? parentA.promptText : parentB.promptText,
      changes_made: ["Crossover parse error; fell back to higher-scoring parent"],
      expected_improvement: "None (parse error)",
    };
  }

  const editCost = resp.costUsd ?? 0;
  const childSha = computePromptSha(edited.prompt);

  // Score child
  const childResults = await judgeAbsolute({
    provider: config.judgeProvider,
    model: config.judgeModel,
    cases: config.cases,
    models: [
      {
        alias: config.model,
        promptSha: brandPromptSha(childSha),
        promptText: edited.prompt,
      },
    ],
    caseSetSha: "",
    concurrency: config.concurrency ?? 2,
    completionProvider: config.completionProvider,
    completionModel: config.completionModel,
    judgeSamples,
  });
  resultsByPromptSha.set(childSha, childResults);

  const meanScore =
    childResults.reduce((sum, r) => sum + r.meanScore, 0) / Math.max(childResults.length, 1);

  const genCost =
    editCost +
    childResults.reduce((sum, r) => {
      const raw = r.raw as { execution?: { costUsd: number | null } };
      return sum + (raw?.execution?.costUsd ?? 0);
    }, 0);

  return {
    generation: gen,
    parentId: parentA.promptSha,
    childId: brandPromptSha(childSha),
    reflection: `Crossover of ${parentA.promptSha.slice(0, 8)} (${parentA.meanScore.toFixed(2)}) and ${parentB.promptSha.slice(0, 8)} (${parentB.meanScore.toFixed(2)}): ${edited.changes_made.join("; ")}`,
    childPrompt: edited.prompt,
    scores: childResults.flatMap((r) => r.scores as JudgeScore[]),
    meanScore,
    costUsd: genCost,
    timestamp: new Date().toISOString(),
    operator: "crossover",
    parents: [parentA.promptSha, parentB.promptSha],
  };
}

function getWorstCases(
  allCases: EvalCase[],
  results: JudgeResult[],
  count: number,
): EvalCase[] {
  if (results.length === 0) {
    return allCases.slice(0, count);
  }

  const caseScores = new Map<string, number>();
  for (const r of results) {
    const current = caseScores.get(r.caseId) ?? 0;
    caseScores.set(r.caseId, current + r.meanScore);
  }

  const sortedCases = [...allCases].sort((a, b) => {
    const scoreA = caseScores.get(a.id) ?? 999;
    const scoreB = caseScores.get(b.id) ?? 999;
    return scoreA - scoreB;
  });

  return sortedCases.slice(0, count);
}

async function reflect(
  parentPrompt: string,
  failures: EvalCase[],
  parentResults: JudgeResult[],
  taskSpec: TaskSpec,
  provider: Provider,
  model: string,
): Promise<{ result: EvolutionReflection; costUsd: number }> {
  // Annotate each failure with its actual judge score
  const failureText = failures
    .map((f, i) => {
      const r = parentResults.find((res) => res.caseId === f.id);
      const scoreSummary = r
        ? `(score ${r.meanScore.toFixed(2)}/5; weakest criteria: ${r.scores
            .filter((s) => s.score <= 3)
            .map((s) => `${s.criterion}=${s.score}`)
            .join(", ") || "none below 3"})`
        : "";
      return `Failure ${i + 1} ${scoreSummary}:\nInput: ${f.input.content.slice(0, 500)}\nRubric: ${JSON.stringify(f.rubric)}`;
    })
    .join("\n\n");

  const userPrompt = `## Current Prompt
${parentPrompt}

## Task Spec
${taskSpec.taskSummary}

Success criteria: ${taskSpec.successCriteria.join("; ")}
Failure modes: ${taskSpec.failureModes.join("; ")}

## Failing Cases
${failureText}

Analyze the failures and propose specific, actionable edits. Be precise about which criteria are weakest and why.`;

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: REFLECTOR_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.3,
    maxTokens: 2048,
    responseSchema: EvolutionReflectionSchema,
  };

  const resp = await provider.complete(request);
  try {
    const parsed = EvolutionReflectionSchema.parse(JSON.parse(resp.text || "{}"));
    return { result: parsed, costUsd: resp.costUsd ?? 0 };
  } catch {
    return {
      result: {
        critique: `Reflection parse error: ${resp.text?.slice(0, 200) || "empty"}`,
        proposed_edit_description: "No changes proposed",
        rationale: "Parse error occurred",
      },
      costUsd: resp.costUsd ?? 0,
    };
  }
}

async function editPrompt(
  parentPrompt: string,
  reflection: { result: EvolutionReflection; costUsd: number },
  provider: Provider,
  model: string,
): Promise<EditedPrompt & { costUsd: number }> {
  const userPrompt = `## Current Prompt
${parentPrompt}

## Reflection
Critique: ${reflection.result.critique}
Proposed edit: ${reflection.result.proposed_edit_description}
Rationale: ${reflection.result.rationale}

Produce the revised prompt. Keep it complete and standalone.`;

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: EDITOR_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    maxTokens: 4096,
    responseSchema: EditedPromptSchema,
  };

  const resp = await provider.complete(request);
  try {
    const parsed = EditedPromptSchema.parse(JSON.parse(resp.text || "{}"));
    return { ...parsed, costUsd: resp.costUsd ?? 0 };
  } catch {
    return {
      prompt: parentPrompt,
      changes_made: ["Fallback: edit parse error, keeping parent"],
      expected_improvement: "None (parse error)",
      costUsd: resp.costUsd ?? 0,
    };
  }
}

export {
  createArchive,
  paretoUpdate,
  topKDiverseBeam,
  findKneePoint,
  sampleFromFrontier,
} from "./archive.js";
export type { ParetoArchive } from "./archive.js";