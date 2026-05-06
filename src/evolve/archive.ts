import type { EvolutionStep, FrontierPoint } from "../types/index.js";

export interface ParetoArchive {
  frontier: FrontierPoint[];
  dominated: FrontierPoint[];
  history: EvolutionStep[];
}

export function createArchive(): ParetoArchive {
  return { frontier: [], dominated: [], history: [] };
}

export function paretoUpdate(archive: ParetoArchive, candidate: FrontierPoint): ParetoArchive {
  const newFrontier: FrontierPoint[] = [];
  let isDominated = false;

  for (const existing of archive.frontier) {
    const candidateDominatesExisting =
      candidate.meanScore >= existing.meanScore &&
      candidate.totalCostUsd <= existing.totalCostUsd &&
      candidate.p95LatencyMs <= existing.p95LatencyMs;

    const existingDominatesCandidate =
      existing.meanScore >= candidate.meanScore &&
      existing.totalCostUsd <= candidate.totalCostUsd &&
      existing.p95LatencyMs <= candidate.p95LatencyMs;

    if (candidateDominatesExisting && !existingDominatesCandidate) {
      // Candidate dominates existing; existing moves to dominated
      continue; // Don't add existing to new frontier
    }
    if (existingDominatesCandidate && !candidateDominatesExisting) {
      // Existing dominates candidate; candidate is dominated
      isDominated = true;
      newFrontier.push(existing);
      continue;
    }
    // Neither dominates; both on frontier
    newFrontier.push(existing);
  }

  if (!isDominated) {
    newFrontier.push(candidate);
  }

  const newDominated = [
    ...archive.dominated,
    ...archive.frontier.filter(
      (f) =>
        !newFrontier.some((nf) => nf.promptSha === f.promptSha && nf.modelAlias === f.modelAlias),
    ),
  ];

  if (isDominated) {
    newDominated.push(candidate);
  }

  return { frontier: newFrontier, dominated: newDominated, history: archive.history };
}

export function sampleFromFrontier(archive: ParetoArchive, epsilon = 0.2): FrontierPoint {
  if (archive.frontier.length === 0) {
    throw new Error("Cannot sample from empty frontier");
  }
  if (archive.dominated.length === 0 || Math.random() > epsilon) {
    // Sample from frontier, biased toward higher scores
    const totalScore = archive.frontier.reduce((sum, p) => sum + p.meanScore, 0);
    const weights = archive.frontier.map((p) => p.meanScore / totalScore);
    return weightedSample(archive.frontier, weights);
  }
  // Epsilon-greedy: occasionally sample dominated to escape local minima
  return archive.dominated[Math.floor(Math.random() * archive.dominated.length)]!;
}

export function findKneePoint(frontier: FrontierPoint[]): number {
  if (frontier.length <= 1) return 0;

  const sorted = [...frontier].sort((a, b) => a.totalCostUsd - b.totalCostUsd);

  // Find the point with best quality-per-dollar ratio within latency constraint
  let bestKnee = 0;
  let bestRatio = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    const qualityPerDollar = point.meanScore / Math.max(point.totalCostUsd, 0.001);
    if (qualityPerDollar > bestRatio) {
      bestRatio = qualityPerDollar;
      bestKnee = i;
    }
  }

  const kneePoint = sorted[bestKnee]!;
  return frontier.findIndex(
    (p) => p.promptSha === kneePoint.promptSha && p.modelAlias === kneePoint.modelAlias,
  );
}

export function addEvolutionStep(archive: ParetoArchive, step: EvolutionStep): ParetoArchive {
  return {
    ...archive,
    history: [...archive.history, step],
  };
}

function weightedSample(items: FrontierPoint[], weights: number[]): FrontierPoint {
  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    cumulative += weights[i]!;
    if (rand <= cumulative) return items[i]!;
  }
  return items[items.length - 1]!;
}
