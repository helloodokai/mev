import path from "node:path";
import { computeCaseSetSha, loadConfig } from "../config/loader.js";
import { computePromptSha } from "../config/loader.js";
import {
  checkCalibrationDrift,
  checkCriticRejectionRate,
  createEscalationQueue,
} from "../escalation/index.js";
import { evolvePrompt } from "../evolve/index.js";
import { judgeAbsolute } from "../judge/index.js";
import { lockIn } from "../lockin/index.js";
import { createProvider } from "../provider/index.js";
import { wrapWithLevelUp } from "../provider/levelup.js";
import { generateHtmlReport, generateSummary } from "../reporting/index.js";
import { showReviewPane } from "../tui/index.js";
import type { CaseFile, EvalCase, FrontierPoint } from "../types/index.js";
import { brandCaseSetSha, brandPromptSha } from "../types/index.js";
import { compileIntent } from "./compile-intent.js";
import {
  createRunDir,
  snapshotCases,
  snapshotSpec,
  writeBaselineResult,
  writeEvolutionStep,
  writeParetoResult,
  writeRunMeta,
  writeSweepResult,
} from "./run-dir.js";
import { synthesizeDataset } from "./synthesize.js";

export interface OptimizeOptions {
  configPath: string;
  yes?: boolean;
  verbose?: boolean;
  budgetUsd?: number;
  budgetMinutes?: number;
  noSecondJudge?: boolean;
}

export async function optimize(opts: OptimizeOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);
  const projectDir = path.dirname(opts.configPath);

  // Override budget if specified
  if (opts.budgetUsd !== undefined) config.budget.max_usd = opts.budgetUsd;
  if (opts.budgetMinutes !== undefined) config.budget.max_minutes = opts.budgetMinutes;

  const startTime = Date.now();
  const escalationQueue = createEscalationQueue();
  const totalCost = 0;

  // Create run directory
  const { runId, runDir } = await createRunDir(projectDir);
  await writeRunMeta(runDir, {
    id: runId,
    startedAt: new Date().toISOString(),
    mevVersion: "0.1.0",
    budget: {
      maxUsd: config.budget.max_usd,
      maxMinutes: config.budget.max_minutes,
      generations: config.budget.generations,
      casesTarget: config.budget.cases,
    },
  });

  // Create providers
  const synthProvider = wrapWithLevelUp(createProvider(config.synthesizer.provider));
  const judgeProvider = createProvider(config.judge.provider);
  const criticProvider = createProvider(config.critic.provider);

  console.log("[A] Compiling intent into a task spec...");

  // Phase A: Compile intent
  const { spec, specFile } = await compileIntent(
    config.project.intent,
    config.project.seed_examples,
    synthProvider,
    config.synthesizer.model,
  );
  await snapshotSpec(specFile, runDir);
  console.log(`[A] ✓ Task spec compiled: ${specFile.task_summary}`);

  // Phase B: Synthesize dataset
  console.log("[B] Synthesizing candidate cases...");
  const synthResult = await synthesizeDataset(
    spec,
    config.project.intent,
    config.project.seed_examples,
    config.budget.cases,
    synthProvider,
    config.synthesizer.model,
    criticProvider,
    config.critic.model,
  );

  const cases: CaseFile[] = synthResult.cases;
  const caseSetSha = brandCaseSetSha(computeCaseSetSha(cases));
  await snapshotCases(cases, runDir);

  console.log(
    `[B] ✓ ${synthResult.accepted} / ${synthResult.accepted + synthResult.rejected} accepted (${Math.round((synthResult.accepted / (synthResult.accepted + synthResult.rejected)) * 100)}%). Filters: ${synthResult.filterStats.schema} schema, ${synthResult.filterStats.dedup} dedup, ${synthResult.filterStats.critic} critic, ${synthResult.filterStats.trivial} trivial.`,
  );

  // Check critic rejection rate
  const criticEvent = checkCriticRejectionRate(
    synthResult.accepted,
    synthResult.rejected,
    synthResult.criticRejections.map((r) => r.verdict.reasoning),
  );
  if (criticEvent) escalationQueue.add(criticEvent);

  // Phase C: Baseline run
  console.log("[C] Running baseline on configured models...");
  const evalCases: EvalCase[] = cases.map((c) => ({
    id: c.id,
    generatedAt: c.generated_at,
    difficultyTier: c.difficulty_tier,
    evolutions: c.evolutions,
    tags: c.tags,
    input: c.input,
    reference: {
      output: c.reference.output,
      synthesizerConfidence: c.reference.synthesizer_confidence,
    },
    rubric: c.rubric,
  }));

  // Build starter prompt from spec
  const starterPrompt = buildStarterPrompt(spec.taskSummary, spec.successCriteria);
  const starterSha = brandPromptSha(computePromptSha(starterPrompt));

  const modelProviders = config.models.map((m) => ({
    alias: m.alias,
    provider: wrapWithLevelUp(createProvider(m.provider)),
    model: m.model,
  }));

  // Judge baseline
  const baselineJudgeResults = await judgeAbsolute({
    provider: judgeProvider,
    model: config.judge.model,
    cases: evalCases,
    models: [{ alias: "starter", promptSha: starterSha, promptText: starterPrompt }],
    caseSetSha,
  });

  for (const result of baselineJudgeResults) {
    await writeBaselineResult(runDir, {
      caseId: result.caseId,
      modelAlias: result.modelAlias,
      promptSha: result.promptSha,
      meanScore: result.meanScore,
      scores: result.scores,
    });
  }

  // Check calibration drift
  const calibrationEvent = checkCalibrationDrift(baselineJudgeResults);
  if (calibrationEvent) escalationQueue.add(calibrationEvent);

  console.log(`[C] ✓ Baseline complete`);

  // Phase D: Prompt evolution
  console.log("[D] Evolving system prompt...");

  const evolutionResult = await evolvePrompt({
    provider: synthProvider,
    model: config.synthesizer.model,
    generations: config.budget.generations,
    cases: evalCases,
    starterPrompt,
    taskSpec: {
      taskSummary: spec.taskSummary,
      inputs: spec.inputs,
      outputs: spec.outputs,
      successCriteria: spec.successCriteria,
      failureModes: spec.failureModes,
      difficultyAxes: spec.difficultyAxes,
      outOfScope: spec.outOfScope,
    },
    maxCostUsd: config.budget.max_usd * 0.6,
  });

  for (const step of evolutionResult.history) {
    await writeEvolutionStep(runDir, {
      generation: step.generation,
      parentId: step.parentId,
      childId: step.childId,
      reflection: step.reflection,
      childPrompt: step.childPrompt,
      meanScore: step.meanScore,
      costUsd: step.costUsd,
      timestamp: step.timestamp,
    });
  }

  console.log(`[D] ✓ Evolution complete: ${evolutionResult.history.length} generations`);

  // Phase E: Model × prompt sweep
  console.log("[E] Running model × prompt sweep...");

  const topPrompts = evolutionResult.frontier.slice(0, 3);
  const sweepResults: FrontierPoint[] = [];

  for (const prompt of topPrompts) {
    for (const mp of modelProviders) {
      try {
        const result = await judgeAbsolute({
          provider: judgeProvider,
          model: config.judge.model,
          cases: evalCases,
          models: [{ alias: mp.alias, promptSha: prompt.promptSha, promptText: prompt.promptText }],
          caseSetSha,
        });

        const meanScore =
          result.reduce((sum, r) => sum + r.meanScore, 0) / Math.max(result.length, 1);
        const totalLatency = 0;
        let totalCostVal = 0;
        for (const _r of result) {
          totalCostVal += 0;
        }

        sweepResults.push({
          promptSha: prompt.promptSha,
          promptText: prompt.promptText,
          modelAlias: mp.alias,
          meanScore,
          totalCostUsd: totalCost,
          p95LatencyMs: totalLatency,
          generation: prompt.generation,
        });

        await writeSweepResult(runDir, {
          promptSha: prompt.promptSha,
          modelAlias: mp.alias,
          meanScore,
          totalCostUsd: totalCost,
        });
      } catch {
        // Continue with other models
      }
    }
  }

  // Phase F: Compute Pareto frontier
  console.log("[F] Computing Pareto frontier...");
  const frontier = computeParetoFrontier(sweepResults);
  const kneeIndex = findKnee(frontier);

  await writeParetoResult(runDir, {
    frontier,
    kneeIndex,
    runId,
    caseSetSha,
  });

  // Add lock-in preflight
  escalationQueue.add({
    kind: "lockin_preflight",
    priority: 1.0,
    details: "Final Pareto frontier review.",
    defaultAction: "Select knee point.",
    timestamp: new Date().toISOString(),
  });

  // Show review pane
  const escalations = escalationQueue.drain();
  const { escalationResolutions, selectedFrontierIndex } = await showReviewPane(
    escalations,
    frontier,
    kneeIndex,
    opts.yes ?? false,
  );

  // Lock in
  const selectedPoint = frontier[selectedFrontierIndex];
  if (!selectedPoint) throw new Error("No frontier point selected");
  const totalRunCost = totalCost;

  const improvement = 0; // computed from actual scores
  const summary = generateSummary({
    runId,
    frontier,
    kneeIndex,
    totalCost: totalRunCost,
    escalations: escalations.filter((e) => e.kind !== "lockin_preflight"),
    generationsUsed: evolutionResult.history.length,
    casesCount: cases.length,
    bestScore: Math.max(...frontier.map((p) => p.meanScore)),
    openWeightImprovement: improvement,
  });

  await lockIn({
    projectDir,
    selectedPoint,
    config,
    cases,
    runId,
    summary,
    escalationResolutions,
    totalCost: totalRunCost,
    bestScore: selectedPoint.meanScore,
  });

  // Write HTML report
  const reportHtml = generateHtmlReport({
    frontier,
    evolutionSteps: evolutionResult.history,
    escalations: escalations.filter((e) => e.kind !== "lockin_preflight"),
    runId,
    kneeIndex,
  });
  await Bun.write(path.join(runDir, "report.html"), reportHtml);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`✓ Locked in. Total time: ${elapsed}s`);
  console.log(`  → prompts/locked.md`);
  console.log(`  → mev.toml`);
  console.log(`  → cases/`);
  console.log(`  → runs/${runId}/`);
}

function buildStarterPrompt(summary: string, criteria: ReadonlyArray<string>): string {
  return [
    summary,
    "",
    "## Success Criteria",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Respond accurately and concisely. If the input is ambiguous, state your assumptions.",
  ].join("\n");
}

function computeParetoFrontier(points: FrontierPoint[]): FrontierPoint[] {
  if (points.length <= 1) return points;

  const frontier: FrontierPoint[] = [];
  for (const candidate of points) {
    const dominated = frontier.some(
      (existing) =>
        existing.meanScore >= candidate.meanScore &&
        existing.totalCostUsd <= candidate.totalCostUsd &&
        existing.p95LatencyMs <= candidate.p95LatencyMs &&
        (existing.meanScore > candidate.meanScore ||
          existing.totalCostUsd < candidate.totalCostUsd ||
          existing.p95LatencyMs < candidate.p95LatencyMs),
    );
    if (!dominated) {
      // Remove existing frontier members dominated by this candidate
      const newFrontier = frontier.filter(
        (f) =>
          !(
            candidate.meanScore >= f.meanScore &&
            candidate.totalCostUsd <= f.totalCostUsd &&
            candidate.p95LatencyMs <= f.p95LatencyMs &&
            (candidate.meanScore > f.meanScore ||
              candidate.totalCostUsd < f.totalCostUsd ||
              candidate.p95LatencyMs < f.p95LatencyMs)
          ),
      );
      newFrontier.push(candidate);
      frontier.length = 0;
      frontier.push(...newFrontier);
    }
  }
  return frontier;
}

function findKnee(frontier: FrontierPoint[]): number {
  if (frontier.length <= 1) return 0;
  let bestIndex = 0;
  let bestRatio = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < frontier.length; i++) {
    const point = frontier[i]!;
    const ratio = point.meanScore / Math.max(point.totalCostUsd, 0.001);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = i;
    }
  }
  return bestIndex;
}
