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
  latestRunDir,
  loadCheckpoint,
  restoreCases,
  snapshotCases,
  snapshotSpec,
  writeBaselineResult,
  writeCheckpoint,
  writeEvolutionStep,
  writeParetoResult,
  writeRunMeta,
  writeSweepResult,
} from "./run-dir.js";
import { synthesizeDataset } from "./synthesize.js";

export interface OptimizeOptions {
  configPath: string;
  yes?: boolean;
  resume?: boolean;
  verbose?: boolean;
  budgetUsd?: number;
  budgetMinutes?: number;
  noSecondJudge?: boolean;
}

export async function optimize(opts: OptimizeOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);
  const projectDir = path.dirname(opts.configPath);

  if (opts.budgetUsd !== undefined) config.budget.max_usd = opts.budgetUsd;
  if (opts.budgetMinutes !== undefined) config.budget.max_minutes = opts.budgetMinutes;

  const startTime = Date.now();
  const escalationQueue = createEscalationQueue();
  let totalCost = 0;

  // Providers
  const synthProvider = wrapWithLevelUp(createProvider(config.synthesizer.provider));
  const judgeProvider = createProvider(config.judge.provider);
  const criticProvider = createProvider(config.critic.provider);

  const modelProviders = config.models.map((m) => ({
    alias: m.alias,
    provider: wrapWithLevelUp(createProvider(m.provider)),
    model: m.model,
  }));
  const mp0 = modelProviders[0];
  if (!mp0) throw new Error("No models configured");

  // Resolve run directory
  const resumeCtx = opts.resume ? await tryResume(projectDir) : null;
  const runDir = resumeCtx?.runDir ?? (await createRunDir(projectDir)).runDir;
  const runId = resumeCtx?.runId ?? path.basename(runDir);

  if (!resumeCtx) {
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
  }

  const checkpointPhase = resumeCtx?.phase ?? null;
  if (checkpointPhase) {
    console.log(`[RESUME] Resuming run ${runId} from phase: ${checkpointPhase}`);
  }

  // --- State variables ---
  let spec: Awaited<ReturnType<typeof compileIntent>>["spec"];
  let evalCases: EvalCase[];
  let starterPrompt: string;
  let caseSetSha: string;
  let cases: CaseFile[];
  let evolutionArchive = (await import("../evolve/archive.js")).createArchive();

  // Phase A: Compile intent (skip if resuming after baseline)
  const skipA = checkpointPhase !== null && checkpointPhase !== "baseline";
  if (!skipA) {
    console.log("[A] Compiling intent into a task spec...");
    const compiled = await compileIntent(
      config.project.intent,
      config.project.seed_examples,
      synthProvider,
      config.synthesizer.model,
    );
    spec = compiled.spec;
    await snapshotSpec(compiled.specFile, runDir);
    console.log(`[A] ✓ Task spec compiled: ${spec.taskSummary}`);
  } else {
    const loaded = await import("../config/loader.js").then((m) =>
      m.loadSpec(path.join(runDir, "spec.json")),
    );
    spec = loaded as unknown as typeof spec;
  }

  // Phase B: Synthesize dataset (skip if resuming after baseline)
  const skipB = checkpointPhase !== null && checkpointPhase !== "baseline";
  if (!skipB) {
    console.log("[B] Synthesizing candidate cases...");
    if (!spec) throw new Error("Spec not loaded");
    const synthResult = await synthesizeDataset(
      spec,
      config.project.intent,
      config.project.seed_examples,
      config.budget.cases,
      synthProvider,
      config.synthesizer.model,
      criticProvider,
      config.critic.model,
      4, // concurrency
      config.optimization.holdout_fraction,
    );
    cases = synthResult.cases;
    caseSetSha = brandCaseSetSha(computeCaseSetSha(cases));
    await snapshotCases(cases, runDir);
    console.log(
      `[B] ✓ ${synthResult.accepted} / ${synthResult.accepted + synthResult.rejected} accepted (${Math.round((synthResult.accepted / (synthResult.accepted + synthResult.rejected)) * 100)}%). Filters: ${synthResult.filterStats.schema} schema, ${synthResult.filterStats.dedup} dedup, ${synthResult.filterStats.critic} critic, ${synthResult.filterStats.trivial} trivial.`,
    );
    console.log(
      `[B] ✓ Train/test split: ${synthResult.trainCount} train + ${synthResult.holdoutCount} holdout (generalization eval).`,
    );
    const criticEvent = checkCriticRejectionRate(
      synthResult.accepted,
      synthResult.rejected,
      synthResult.criticRejections.map((r) => r.verdict.reasoning),
    );
    if (criticEvent) escalationQueue.add(criticEvent);
    evalCases = cases.map((c) => ({
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
      holdout: c.holdout ?? false,
    }));
  } else {
    cases = await restoreCases(runDir);
    caseSetSha = brandCaseSetSha(computeCaseSetSha(cases));
    evalCases = cases.map((c) => ({
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
      holdout: c.holdout ?? false,
    }));
  }

  starterPrompt = buildStarterPrompt(spec?.taskSummary, spec?.successCriteria);
  const starterSha = brandPromptSha(computePromptSha(starterPrompt));

  // Train/test split: cases marked holdout=true are NEVER used during evolution.
  // They are only evaluated at sweep/lock-in for true generalization measurement.
  const trainCases = evalCases.filter((c) => !c.holdout);
  const holdoutCases = evalCases.filter((c) => c.holdout);
  const usableTrainCases = trainCases.length > 0 ? trainCases : evalCases;
  console.log(
    `[Split] train=${usableTrainCases.length} | holdout=${holdoutCases.length} (held out for generalization)`,
  );

  // Phase C: Baseline (run on TRAIN cases for evolution baseline; HOLDOUT separately for generalization)
  let baselineScore = 0;
  let baselineHoldoutScore = 0;
  const skipC = checkpointPhase === "evolution" || checkpointPhase === "sweep";
  if (!skipC) {
    console.log("[C] Running baseline on TRAIN cases...");
    const baselineJudgeResults = await judgeAbsolute({
      provider: judgeProvider,
      model: config.judge.model,
      cases: usableTrainCases,
      models: [{ alias: "starter", promptSha: starterSha, promptText: starterPrompt }],
      caseSetSha,
      completionProvider: mp0.provider,
      completionModel: mp0.model,
      judgeSamples: config.optimization.judge_samples,
    });
    baselineScore =
      baselineJudgeResults.reduce((sum, r) => sum + r.meanScore, 0) /
      Math.max(baselineJudgeResults.length, 1);
    for (const result of baselineJudgeResults) {
      await writeBaselineResult(runDir, {
        caseId: result.caseId,
        modelAlias: result.modelAlias,
        promptSha: result.promptSha,
        meanScore: result.meanScore,
        scores: result.scores,
        split: "train",
      });
      const raw = result.raw as { execution?: { costUsd: number | null } };
      totalCost += raw?.execution?.costUsd ?? 0;
    }

    // Also evaluate baseline on holdout for fair comparison later
    if (holdoutCases.length > 0) {
      const baselineHoldoutResults = await judgeAbsolute({
        provider: judgeProvider,
        model: config.judge.model,
        cases: holdoutCases,
        models: [{ alias: "starter", promptSha: starterSha, promptText: starterPrompt }],
        caseSetSha,
        completionProvider: mp0.provider,
        completionModel: mp0.model,
        judgeSamples: config.optimization.judge_samples,
      });
      baselineHoldoutScore =
        baselineHoldoutResults.reduce((sum, r) => sum + r.meanScore, 0) /
        Math.max(baselineHoldoutResults.length, 1);
      for (const result of baselineHoldoutResults) {
        await writeBaselineResult(runDir, {
          caseId: result.caseId,
          modelAlias: result.modelAlias,
          promptSha: result.promptSha,
          meanScore: result.meanScore,
          scores: result.scores,
          split: "holdout",
        });
        const raw = result.raw as { execution?: { costUsd: number | null } };
        totalCost += raw?.execution?.costUsd ?? 0;
      }
    }

    const calibrationEvent = checkCalibrationDrift(baselineJudgeResults);
    if (calibrationEvent) escalationQueue.add(calibrationEvent);
    console.log(
      `[C] ✓ Baseline complete (train: ${baselineScore.toFixed(2)}${holdoutCases.length > 0 ? `, holdout: ${baselineHoldoutScore.toFixed(2)}` : ""})`,
    );
    await writeCheckpoint(runDir, {
      phase: "baseline",
      startedAt: new Date().toISOString(),
      config: { generationsLeft: config.budget.generations, nextGeneration: 1 },
      frontier: [],
    });
  }

  // Phase D: Evolution (TRAIN cases only — holdout is reserved for sweep/lock-in)
  const skipD = checkpointPhase === "sweep";
  if (!skipD) {
    console.log(
      `[D] Evolving system prompt (beam=${config.optimization.beam_width}, crossover=${config.optimization.crossover_rate}, judge_samples=${config.optimization.judge_samples})...`,
    );
    const cp = checkpointPhase === "evolution" ? await loadCheckpoint(runDir) : null;
    const generationsToRun = cp ? cp.config.generationsLeft : config.budget.generations;

    evolutionArchive = await evolvePrompt({
      provider: synthProvider,
      model: config.synthesizer.model,
      judgeProvider,
      judgeModel: config.judge.model,
      completionProvider: mp0.provider,
      completionModel: mp0.model,
      generations: generationsToRun,
      cases: usableTrainCases,
      starterPrompt,
      taskSpec: {
        taskSummary: spec?.taskSummary,
        inputs: spec?.inputs,
        outputs: spec?.outputs,
        successCriteria: spec?.successCriteria,
        failureModes: spec?.failureModes,
        difficultyAxes: spec?.difficultyAxes,
        outOfScope: spec?.outOfScope,
      },
      maxCostUsd: config.budget.max_usd * 0.6,
      beamWidth: config.optimization.beam_width,
      judgeSamples: config.optimization.judge_samples,
      crossoverRate: config.optimization.crossover_rate,
      maxExamples: config.optimization.max_examples,
    });
    totalCost += evolutionArchive.history.reduce((s, st) => s + st.costUsd, 0);

    for (const step of evolutionArchive.history) {
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
    console.log(`[D] ✓ Evolution complete: ${evolutionArchive.history.length} generations`);
    await writeCheckpoint(runDir, {
      phase: "evolution",
      startedAt: new Date().toISOString(),
      config: { generationsLeft: 0, nextGeneration: config.budget.generations + 1 },
      frontier: evolutionArchive.frontier,
    });
  } else {
    const cp = await loadCheckpoint(runDir);
    const { createArchive, paretoUpdate } = await import("../evolve/archive.js");
    const archive = createArchive();
    for (const p of cp?.frontier ?? []) {
      Object.assign(archive, paretoUpdate(archive, p));
    }
    for (const step of archive.history) {
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
    evolutionArchive = archive;
  }

  // Phase E: Sweep — evaluate top prompts on HOLDOUT for true generalization
  console.log("[E] Running model × prompt sweep on holdout cases...");
  // Take top-K from frontier by train score; evaluate each on holdout
  const allCandidates = [...evolutionArchive.frontier, ...evolutionArchive.dominated]
    .sort((a, b) => b.meanScore - a.meanScore);
  // Dedupe by promptSha (frontier and dominated may overlap conceptually after updates)
  const seenShas = new Set<string>();
  const topPrompts: FrontierPoint[] = [];
  for (const p of allCandidates) {
    if (!seenShas.has(p.promptSha)) {
      seenShas.add(p.promptSha);
      topPrompts.push(p);
    }
    if (topPrompts.length >= 5) break;
  }
  const sweepResults: FrontierPoint[] = [];
  const sweepCases = holdoutCases.length > 0 ? holdoutCases : usableTrainCases;
  const splitLabel = holdoutCases.length > 0 ? "holdout" : "train (no holdout available)";
  console.log(`[E] Evaluating ${topPrompts.length} candidates on ${sweepCases.length} ${splitLabel} cases...`);

  for (const prompt of topPrompts) {
    for (const mp of modelProviders) {
      try {
        const sweepStart = performance.now();
        // Evaluate on holdout (primary signal)
        const holdoutResult = await judgeAbsolute({
          provider: judgeProvider,
          model: config.judge.model,
          cases: sweepCases,
          models: [{ alias: mp.alias, promptSha: prompt.promptSha, promptText: prompt.promptText }],
          caseSetSha,
          completionProvider: mp.provider,
          completionModel: mp.model,
          judgeSamples: config.optimization.judge_samples,
          bestOfN: config.optimization.lockin_best_of_n,
        });

        const holdoutScore =
          holdoutResult.reduce((sum, r) => sum + r.meanScore, 0) /
          Math.max(holdoutResult.length, 1);

        // Compute score variance across cases as a robustness signal
        const scoreList = holdoutResult.map((r) => r.meanScore);
        const meanForVar = scoreList.reduce((a, b) => a + b, 0) / Math.max(scoreList.length, 1);
        const scoreVariance =
          scoreList.length > 1
            ? scoreList.reduce((s, x) => s + (x - meanForVar) ** 2, 0) / scoreList.length
            : 0;

        const totalLatency = Math.round(performance.now() - sweepStart);
        const totalCostVal = holdoutResult.reduce((sum, r) => {
          const raw = r.raw as { execution?: { costUsd: number | null } };
          return sum + (raw?.execution?.costUsd ?? 0);
        }, 0);
        totalCost += totalCostVal;

        // Use train score (from evolution) as primary if no holdout, else holdout
        const primaryScore = holdoutCases.length > 0 ? holdoutScore : prompt.meanScore;

        const sweepPoint: FrontierPoint = {
          promptSha: prompt.promptSha,
          promptText: prompt.promptText,
          modelAlias: mp.alias,
          meanScore: primaryScore,
          scoreVariance,
          totalCostUsd: totalCostVal,
          p95LatencyMs: totalLatency,
          generation: prompt.generation,
        };
        if (holdoutCases.length > 0) sweepPoint.holdoutScore = holdoutScore;
        sweepResults.push(sweepPoint);

        await writeSweepResult(runDir, {
          promptSha: prompt.promptSha,
          modelAlias: mp.alias,
          trainScore: prompt.meanScore,
          holdoutScore: holdoutCases.length > 0 ? holdoutScore : null,
          scoreVariance,
          meanScore: primaryScore,
          totalCostUsd: totalCostVal,
          p95LatencyMs: totalLatency,
        });
      } catch (err) {
        console.warn(`[E] Sweep failure for ${mp.alias}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Phase F: Compute Pareto frontier
  console.log("[F] Computing Pareto frontier...");
  const frontier = computeParetoFrontier(sweepResults);
  const kneeIndex = findKnee(frontier);

  await writeParetoResult(runDir, { frontier, kneeIndex, runId, caseSetSha });
  await writeCheckpoint(runDir, {
    phase: "sweep",
    startedAt: new Date().toISOString(),
    config: { generationsLeft: 0, nextGeneration: config.budget.generations + 1 },
    frontier,
  });

  // Phase G: Lock in
  escalationQueue.add({
    kind: "lockin_preflight",
    priority: 1.0,
    details: "Final Pareto frontier review.",
    defaultAction: "Select knee point.",
    timestamp: new Date().toISOString(),
  });

  const escalations = escalationQueue.drain();
  const { escalationResolutions, selectedFrontierIndex } = await showReviewPane(
    escalations,
    frontier,
    kneeIndex,
    opts.yes ?? false,
  );

  const selectedPoint = frontier[selectedFrontierIndex];
  if (!selectedPoint) throw new Error("No frontier point selected");
  const totalRunCost = totalCost;
  // Use holdout improvement as the headline number — this is true generalization
  const headlineBaseline = holdoutCases.length > 0 ? baselineHoldoutScore : baselineScore;
  const headlineFinal = selectedPoint.holdoutScore ?? selectedPoint.meanScore;
  const improvement =
    headlineBaseline > 0
      ? ((headlineFinal - headlineBaseline) / headlineBaseline) * 100
      : 0;
  if (holdoutCases.length > 0) {
    console.log(
      `[Result] Holdout improvement: ${baselineHoldoutScore.toFixed(2)} → ${headlineFinal.toFixed(2)} (${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)}%)`,
    );
  } else {
    console.log(
      `[Result] Train improvement: ${baselineScore.toFixed(2)} → ${headlineFinal.toFixed(2)} (${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)}%)`,
    );
  }
  const summaryArgs: Parameters<typeof generateSummary>[0] = {
    runId,
    frontier,
    kneeIndex,
    totalCost: totalRunCost,
    escalations: escalations.filter((e) => e.kind !== "lockin_preflight"),
    generationsUsed: evolutionArchive.history.length,
    casesCount: cases.length,
    bestScore: Math.max(...frontier.map((p) => p.meanScore)),
    openWeightImprovement: improvement,
    baselineScore,
    trainCases: usableTrainCases.length,
    holdoutCases: holdoutCases.length,
  };
  if (holdoutCases.length > 0) summaryArgs.baselineHoldoutScore = baselineHoldoutScore;
  const summary = generateSummary(summaryArgs);

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

  const reportArgs: Parameters<typeof generateHtmlReport>[0] = {
    frontier,
    evolutionSteps: evolutionArchive.history,
    escalations: escalations.filter((e) => e.kind !== "lockin_preflight"),
    runId,
    kneeIndex,
    baselineScore,
    trainCases: usableTrainCases.length,
    holdoutCases: holdoutCases.length,
  };
  if (holdoutCases.length > 0) reportArgs.baselineHoldoutScore = baselineHoldoutScore;
  const reportHtml = generateHtmlReport(reportArgs);
  await Bun.write(path.join(runDir, "report.html"), reportHtml);

  await writeCheckpoint(runDir, {
    phase: "locked",
    startedAt: new Date().toISOString(),
    config: { generationsLeft: 0, nextGeneration: config.budget.generations + 1 },
    frontier,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`✓ Locked in. Total time: ${elapsed}s`);
  console.log("  → prompts/locked.md");
  console.log("  → mev.toml");
  console.log("  → cases/");
  console.log(`  → runs/${runId}/`);
}

// ---------------------------------------------------------------------------
// Resume helper
// ---------------------------------------------------------------------------

async function tryResume(
  projectDir: string,
): Promise<{ runDir: string; runId: string; phase: string } | null> {
  const dir = await latestRunDir(projectDir);
  if (!dir) return null;
  const cp = await loadCheckpoint(dir);
  if (!cp || cp.phase === "locked") return null;
  return { runDir: dir, runId: path.basename(dir), phase: cp.phase };
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
    const point = frontier[i];
    if (!point) continue;
    const ratio = point.meanScore / Math.max(point.totalCostUsd, 0.001);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = i;
    }
  }
  return bestIndex;
}
