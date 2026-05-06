import { z } from "zod";
import { parallelMap } from "../concurrency/index.js";
import type { CompletionRequest, Provider, TaskSpec } from "../types/index.js";
import {
  type CaseFile,
  CaseFileSchema,
  type CriticVerdict,
  CriticVerdictSchema,
} from "../types/index.js";

const VERTICAL_EVOLUTIONS = [
  "add_reasoning",
  "add_constraint",
  "add_edge_case",
  "add_distractor",
] as const;
const HORIZONTAL_EVOLUTIONS = [
  "change_domain",
  "change_input_format",
  "change_difficulty_axis",
] as const;
type Evolution = (typeof VERTICAL_EVOLUTIONS)[number] | (typeof HORIZONTAL_EVOLUTIONS)[number];

function pickEvolutions(diffAxes: ReadonlyArray<string>): Evolution[] {
  const evolutions: Evolution[] = [];
  if (diffAxes.length > 0) {
    evolutions.push(VERTICAL_EVOLUTIONS[Math.floor(Math.random() * VERTICAL_EVOLUTIONS.length)]!);
  }
  if (Math.random() > 0.5) {
    evolutions.push(
      HORIZONTAL_EVOLUTIONS[Math.floor(Math.random() * HORIZONTAL_EVOLUTIONS.length)]!,
    );
  }
  if (Math.random() > 0.7 && evolutions.length < 2) {
    evolutions.push(VERTICAL_EVOLUTIONS[Math.floor(Math.random() * VERTICAL_EVOLUTIONS.length)]!);
  }
  return evolutions;
}

const SEED_SYNTH_PROMPT = `You are an evaluation case synthesizer. Given a task specification, generate a single evaluation case.

The case should be straightforward and test a basic aspect of the task.
Focus on the specified success criterion: {criterion}

Output valid JSON:
{
  "id": "{id}",
  "input_content": "...",
  "reference_output": "...",
  "synthesizer_confidence": 0.0-1.0,
  "rubric": { "criterion_name": "behavioral_anchor" },
  "tags": ["tag1", "tag2"],
  "difficulty_tier": 1-5
}`;

const EVOLVED_SYNTH_PROMPT = `You are an evaluation case synthesizer. Given:
1. A task specification
2. A seed case to evolve from
3. Evolution instructions

Generate a harder/different evaluation case that retains the core task but adds the specified complexity.

Evolutions to apply: {evolutions}

Output valid JSON:
{
  "id": "{id}",
  "input_content": "...",
  "reference_output": "...",
  "synthesizer_confidence": 0.0-1.0,
  "rubric": { "criterion_name": "behavioral_anchor" },
  "tags": ["tag1", "tag2"],
  "difficulty_tier": 1-5
}`;

const CRITIC_PROMPT = `You are a case quality critic. Evaluate this evaluation case against the task spec.

Task intent: {intent}
Success criteria: {criteria}

Critic rubric - score each dimension:
- is_clear: Can any competent person understand what the case asks?
- is_unambiguous: Is there exactly one reasonable interpretation?
- is_aligned_with_intent: Does the case test something the task actually requires?
- is_trivially_solvable: Could a trivial program solve this without understanding?
- is_within_scope: Is the case within the task's stated scope?
- difficulty_tier: 1(easy)-5(hard)

Output valid JSON:
{
  "is_clear": bool, "is_unambiguous": bool, "is_aligned_with_intent": bool,
  "is_trivially_solvable": bool, "is_within_scope": bool,
  "difficulty_tier": 1-5, "reasoning": "..."
}`;

const SynthOutputSchema = z.object({
  id: z.string(),
  input_content: z.string().min(1),
  reference_output: z.string().min(1),
  synthesizer_confidence: z.number().min(0).max(1),
  rubric: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  difficulty_tier: z.number().int().min(1).max(5),
});

export interface SynthesisResult {
  cases: CaseFile[];
  accepted: number;
  rejected: number;
  filterStats: { schema: number; dedup: number; critic: number; trivial: number };
  criticRejections: Array<{ id: string; verdict: CriticVerdict }>;
}

export async function synthesizeDataset(
  spec: TaskSpec,
  intent: string,
  seedExamples: ReadonlyArray<string>,
  targetCount: number,
  provider: Provider,
  model: string,
  criticProvider: Provider,
  criticModel: string,
  concurrency = 4,
): Promise<SynthesisResult> {
  const seedCount = Math.min(Math.floor(targetCount * 0.4), spec.successCriteria.length);
  const evolvedCount = targetCount - seedCount;
  const allCases: CaseFile[] = [];
  const filterStats = { schema: 0, dedup: 0, critic: 0, trivial: 0 };
  const criticRejections: Array<{ id: string; verdict: CriticVerdict }> = [];

  // Seed cases - one per success criterion
  const seedTasks = spec.successCriteria.slice(0, seedCount).map((criterion, i) => {
    const id = String(i + 1).padStart(4, "0");
    return generateSeedCase(id, criterion, spec, seedExamples, provider, model);
  });

  const seedResults = await parallelMap(seedTasks, (t) => t, concurrency);
  for (const result of seedResults) {
    allCases.push(result);
  }

  // Evolved cases
  const evolvedTasks = Array.from({ length: evolvedCount }, (_, i) => {
    const id = String(seedCount + i + 1).padStart(4, "0");
    const evolutions = pickEvolutions(spec.difficultyAxes);
    const seedCase = allCases[Math.floor(Math.random() * allCases.length)] ?? allCases[0]!;
    return generateEvolvedCase(id, spec, seedCase, evolutions, seedExamples, provider, model);
  });

  const evolvedResults = await parallelMap(evolvedTasks, (t) => t, concurrency);
  for (const result of evolvedResults) {
    allCases.push(result);
  }

  // Gate 1: Schema validation
  const schemaValid: CaseFile[] = [];
  for (const c of allCases) {
    const result = CaseFileSchema.safeParse(c);
    if (result.success) {
      schemaValid.push(c);
    } else {
      filterStats.schema++;
    }
  }

  // Gate 2: Dedup (MinHash-like via token overlap)
  const deduped = dedupCases(schemaValid);
  filterStats.dedup = schemaValid.length - deduped.length;

  // Gate 3: Critic
  const criticResults = await parallelMap(
    deduped,
    (c) => runCritic(c, intent, spec.successCriteria, criticProvider, criticModel),
    concurrency,
  );

  const accepted: CaseFile[] = [];
  let trivialCount = 0;
  const maxTrivial = Math.max(3, Math.floor(deduped.length * 0.1));

  for (let i = 0; i < deduped.length; i++) {
    const caseFile = deduped[i]!;
    const verdict = criticResults[i];
    if (!verdict) {
      filterStats.critic++;
      criticRejections.push({
        id: caseFile.id,
        verdict: {
          is_clear: false,
          is_unambiguous: false,
          is_aligned_with_intent: false,
          is_trivially_solvable: true,
          is_within_scope: true,
          difficulty_tier: 1,
          reasoning: "Critic failed",
        },
      });
      continue;
    }

    const passesGates =
      verdict.is_clear &&
      verdict.is_unambiguous &&
      verdict.is_aligned_with_intent &&
      verdict.is_within_scope;

    if (!passesGates) {
      filterStats.critic++;
      criticRejections.push({ id: caseFile.id, verdict });
      continue;
    }

    if (verdict.is_trivially_solvable || verdict.difficulty_tier <= 1) {
      trivialCount++;
      if (trivialCount > maxTrivial) {
        filterStats.trivial++;
        continue;
      }
    }

    accepted.push(caseFile);
  }

  return {
    cases: accepted,
    accepted: accepted.length,
    rejected: allCases.length - accepted.length,
    filterStats,
    criticRejections,
  };
}

async function generateSeedCase(
  id: string,
  criterion: string,
  spec: TaskSpec,
  seedExamples: ReadonlyArray<string>,
  provider: Provider,
  model: string,
): Promise<CaseFile> {
  const systemPrompt = SEED_SYNTH_PROMPT.replace("{criterion}", criterion);
  const userPrompt = buildSynthUserPrompt(spec, seedExamples, id);

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    maxTokens: 2048,
    responseSchema: SynthOutputSchema,
  };

  const resp = await provider.complete(request);
  const parsed = parseSynthOutput(resp.text, id);
  return {
    id: parsed.id,
    generated_at: new Date().toISOString(),
    difficulty_tier: parsed.difficulty_tier,
    evolutions: [],
    tags: parsed.tags,
    input: { content: parsed.input_content },
    reference: {
      output: parsed.reference_output,
      synthesizer_confidence: parsed.synthesizer_confidence,
    },
    rubric: parsed.rubric,
  };
}

async function generateEvolvedCase(
  id: string,
  spec: TaskSpec,
  seedCase: CaseFile,
  evolutions: Evolution[],
  seedExamples: ReadonlyArray<string>,
  provider: Provider,
  model: string,
): Promise<CaseFile> {
  const systemPrompt = EVOLVED_SYNTH_PROMPT.replace("{evolutions}", evolutions.join(", "));
  const userPrompt = buildEvolvedUserPrompt(spec, seedCase, seedExamples, id);

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt,
    userPrompt,
    temperature: 0.5,
    maxTokens: 2048,
    responseSchema: SynthOutputSchema,
  };

  const resp = await provider.complete(request);
  const parsed = parseSynthOutput(resp.text, id);
  return {
    id: parsed.id,
    generated_at: new Date().toISOString(),
    difficulty_tier: parsed.difficulty_tier,
    evolutions: [...evolutions],
    tags: parsed.tags,
    input: { content: parsed.input_content },
    reference: {
      output: parsed.reference_output,
      synthesizer_confidence: parsed.synthesizer_confidence,
    },
    rubric: parsed.rubric,
  };
}

function buildSynthUserPrompt(
  spec: TaskSpec,
  seedExamples: ReadonlyArray<string>,
  id: string,
): string {
  const parts: string[] = [
    "## Task Specification",
    `Summary: ${spec.taskSummary}`,
    `Success Criteria: ${spec.successCriteria.join("; ")}`,
    `Failure Modes: ${spec.failureModes.join("; ")}`,
    `Difficulty Axes: ${spec.difficultyAxes.join("; ")}`,
    `Out of Scope: ${spec.outOfScope.join("; ")}`,
    "",
    `Generate case with id: ${id}`,
  ];
  if (seedExamples.length > 0) {
    parts.push("", "## Seed examples from user (anchor to these):");
    seedExamples.forEach((ex, i) => parts.push(`Example ${i + 1}: ${ex}`));
  }
  return parts.join("\n");
}

function buildEvolvedUserPrompt(
  spec: TaskSpec,
  seedCase: CaseFile,
  seedExamples: ReadonlyArray<string>,
  id: string,
): string {
  const parts: string[] = [
    "## Task Specification",
    `Summary: ${spec.taskSummary}`,
    `Success Criteria: ${spec.successCriteria.join("; ")}`,
    "",
    "## Seed case to evolve from",
    `Input: ${seedCase.input.content.slice(0, 500)}`,
    `Reference: ${seedCase.reference.output.slice(0, 500)}`,
    "",
    `Generate evolved case with id: ${id}`,
  ];
  if (seedExamples.length > 0) {
    parts.push("", "## User seed examples (anchor to these):");
    seedExamples.forEach((ex, i) => parts.push(`Example ${i + 1}: ${ex}`));
  }
  return parts.join("\n");
}

function parseSynthOutput(text: string, fallbackId: string): z.infer<typeof SynthOutputSchema> {
  try {
    const parsed = JSON.parse(text);
    return SynthOutputSchema.parse({ ...parsed, id: parsed.id || fallbackId });
  } catch {
    return {
      id: fallbackId,
      input_content: "PARSE_ERROR",
      reference_output: "",
      synthesizer_confidence: 0,
      rubric: {},
      tags: [],
      difficulty_tier: 1,
    };
  }
}

async function runCritic(
  caseFile: CaseFile,
  intent: string,
  criteria: ReadonlyArray<string>,
  criticProvider: Provider,
  criticModel: string,
): Promise<CriticVerdict | null> {
  const userPrompt = [
    `Intent: ${intent}`,
    `Criteria: ${criteria.join("; ")}`,
    "",
    "## Case to evaluate",
    `Input: ${caseFile.input.content.slice(0, 1000)}`,
    `Reference output: ${caseFile.reference.output.slice(0, 500)}`,
    `Rubric: ${JSON.stringify(caseFile.rubric)}`,
  ].join("\n");

  const request: CompletionRequest = {
    model: criticModel,
    provider: criticProvider.id,
    systemPrompt: CRITIC_PROMPT,
    userPrompt,
    temperature: 0,
    maxTokens: 1024,
    responseSchema: CriticVerdictSchema,
  };

  try {
    const resp = await criticProvider.complete(request);
    if (resp.finishReason === "error") return null;
    const parsed = JSON.parse(resp.text);
    return CriticVerdictSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function dedupCases(cases: CaseFile[]): CaseFile[] {
  const seen = new Map<string, CaseFile>();
  for (const c of cases) {
    const fp = minHashFingerprint(c.input.content);
    let isDupe = false;
    for (const [existingFp] of seen) {
      if (jaccardSim(fp, existingFp) > 0.92) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) {
      seen.set(fp, c);
    }
  }
  return Array.from(seen.values());
}

function minHashFingerprint(text: string): string {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    shingles.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return Array.from(shingles).sort().join("|");
}

function jaccardSim(a: string, b: string): number {
  const setA = new Set(a.split("|"));
  const setB = new Set(b.split("|"));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
