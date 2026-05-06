import { computePromptSha } from "../config/loader.js";
import { judgeAbsolute } from "../judge/index.js";
import type {
  CompletionRequest,
  EvalCase,
  EvolutionStep,
  FrontierPoint,
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
  sampleFromFrontier,
} from "./archive.js";

const REFLECTOR_SYSTEM_PROMPT = `You are a prompt optimization reflector. Given a system prompt and a set of failure cases, analyze WHY the prompt failed and propose specific edits.

Your output must be structured JSON:
{
  "critique": "natural-language analysis of what went wrong",
  "proposed_edit_description": "specific description of what to add/change/remove from the prompt",
  "rationale": "why this edit is expected to improve performance on the failing cases"
}

Be specific. Don't say "make it better" — say "add an instruction to never comment on formatting, because cases 4 and 11 showed the model flagging whitespace issues."`;

const EDITOR_SYSTEM_PROMPT = `You are a prompt editor. Given the current prompt and a reflection proposing changes, produce a revised system prompt.

Rules:
- Preserve the prompt's overall structure and intent
- Make ONLY the changes proposed in the reflection
- Do not remove working instructions
- Be concise — every line should earn its place

Output valid JSON:
{
  "prompt": "the complete revised system prompt",
  "changes_made": ["change1", "change2", ...],
  "expected_improvement": "what this should fix"
}`;

export interface EvolutionConfig {
  provider: Provider; // synthesis / editing model
  model: string;
  judgeProvider: Provider; // judge model
  judgeModel: string;
  completionProvider: Provider; // model that executes prompts
  completionModel: string;
  generations: number;
  cases: EvalCase[];
  starterPrompt: string;
  taskSpec: TaskSpec;
  maxCostUsd: number;
  concurrency?: number;
}

export async function evolvePrompt(
  config: EvolutionConfig,
  onGeneration?: (step: EvolutionStep) => void,
): Promise<ParetoArchive> {
  let archive = createArchive();
  const starterSha = computePromptSha(config.starterPrompt);
  const starterPoint: FrontierPoint = {
    promptSha: brandPromptSha(starterSha),
    promptText: config.starterPrompt,
    modelAlias: config.model,
    meanScore: 0,
    totalCostUsd: 0,
    p95LatencyMs: 0,
    generation: 0,
  };

  archive = paretoUpdate(archive, starterPoint);

  let totalCost = 0;
  let generationsWithoutImprovement = 0;
  let previousBestScore = 0;

  for (let gen = 1; gen <= config.generations; gen++) {
    if (totalCost >= config.maxCostUsd) {
      break;
    }

    const parent = sampleFromFrontier(archive, 0.2);

    // Use cases with the lowest per-case scores as "failures" for reflection.
    // Since we now score children, we can find genuinely hard cases.
    const failures = config.cases.slice(0, 3);

    // Step 1: Reflect
    const reflection = await reflect(
      parent.promptText,
      failures,
      config.taskSpec,
      config.provider,
      config.model,
    );

    // Step 2: Edit
    const edited = await editPrompt(parent.promptText, reflection, config.provider, config.model);

    // Step 3: Score child against the full case set
    const childSha = computePromptSha(edited.prompt);
    const childResult = await judgeAbsolute({
      provider: config.judgeProvider,
      model: config.judgeModel,
      cases: config.cases,
      models: [{ alias: "child", promptSha: brandPromptSha(childSha), promptText: edited.prompt }],
      caseSetSha: "",
      concurrency: config.concurrency ?? 4,
      completionProvider: config.completionProvider,
      completionModel: config.completionModel,
    });

    const meanScore =
      childResult.reduce((sum, r) => sum + r.meanScore, 0) / Math.max(childResult.length, 1);

    const childPoint: FrontierPoint = {
      promptSha: brandPromptSha(childSha),
      promptText: edited.prompt,
      modelAlias: config.model,
      meanScore,
      totalCostUsd: totalCost,
      p95LatencyMs: 0,
      generation: gen,
    };

    archive = paretoUpdate(archive, childPoint);

    totalCost += reflection.costUsd + edited.costUsd;
    
    const step: EvolutionStep = {
      generation: gen,
      parentId: parent.promptSha,
      childId: brandPromptSha(childSha),
      reflection: reflection.result.critique,
      childPrompt: edited.prompt,
      scores: childResult.flatMap((r) => r.scores as JudgeScore[]),
      meanScore,
      costUsd: totalCost,
      timestamp: new Date().toISOString(),
    };

    archive = addEvolutionStep(archive, step);

    if (onGeneration) {
      onGeneration(step);
    }

    // Check for plateau
    if (step.meanScore <= previousBestScore) {
      generationsWithoutImprovement++;
    } else {
      generationsWithoutImprovement = 0;
      previousBestScore = step.meanScore;
    }
  }

  return archive;
}

async function reflect(
  parentPrompt: string,
  failures: EvalCase[],
  taskSpec: TaskSpec,
  provider: Provider,
  model: string,
): Promise<{ result: EvolutionReflection; costUsd: number }> {
  const failureText = failures
    .map(
      (f, i) =>
        `Failure ${i + 1}:\nInput: ${f.input.content.slice(0, 500)}\nRubric: ${JSON.stringify(f.rubric)}`,
    )
    .join("\n\n");

  const userPrompt = `## Current Prompt
${parentPrompt}

## Task Spec
${taskSpec.taskSummary}

## Failing Cases
${failureText}

Analyze the failures and propose edits.`;

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
    const parsed = EvolutionReflectionSchema.parse(JSON.parse(resp.text));
    return { result: parsed, costUsd: resp.costUsd ?? 0 };
  } catch {
    return {
      result: {
        critique: "Reflection parse error",
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

Produce the revised prompt.`;

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
    const parsed = EditedPromptSchema.parse(JSON.parse(resp.text));
    return { ...parsed, costUsd: resp.costUsd ?? 0 };
  } catch {
    return {
      prompt: parentPrompt, // Fallback to parent
      changes_made: ["Fallback: edit parse error, keeping parent"],
      expected_improvement: "None (parse error)",
      costUsd: resp.costUsd ?? 0,
    };
  }
}

export { createArchive, paretoUpdate, sampleFromFrontier, findKneePoint } from "./archive.js";
export type { ParetoArchive } from "./archive.js";
