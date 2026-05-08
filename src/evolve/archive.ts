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
  const idx = Math.floor(Math.random() * archive.dominated.length);
  const pick = archive.dominated[idx];
  if (!pick) throw new Error("Unexpected empty dominated list");
  return pick;
}

export function findKneePoint(frontier: FrontierPoint[]): number {
  if (frontier.length <= 1) return 0;

  const sorted = [...frontier].sort((a, b) => a.totalCostUsd - b.totalCostUsd);

  // Find the point with best quality-per-dollar ratio within latency constraint
  let bestKnee = 0;
  let bestRatio = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i];
    if (!point) continue;
    const qualityPerDollar = point.meanScore / Math.max(point.totalCostUsd, 0.001);
    if (qualityPerDollar > bestRatio) {
      bestRatio = qualityPerDollar;
      bestKnee = i;
    }
  }

  const kneePoint = sorted[bestKnee];
  if (!kneePoint) return 0;
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

/**
 * Get top-K diverse beam from archive.
 *
 * Selects K points by descending score, but applies a diversity penalty so
 * we don't pick K nearly-identical prompts. Uses Maximal Marginal Relevance:
 * each pick maximizes (score - lambda * max_similarity_to_already_picked).
 */
export function topKDiverseBeam(
  archive: ParetoArchive,
  k: number,
  lambda = 0.4,
): FrontierPoint[] {
  const all = [...archive.frontier, ...archive.dominated];
  if (all.length === 0) return [];
  if (k <= 1) {
    const top = all.reduce<FrontierPoint | null>((best, cur) => {
      if (!best || cur.meanScore > best.meanScore) return cur;
      return best;
    }, null);
    return top ? [top] : [];
  }

  const picked: FrontierPoint[] = [];
  const remaining = [...all];

  // First pick: highest score
  remaining.sort((a, b) => b.meanScore - a.meanScore);
  const first = remaining.shift();
  if (!first) return [];
  picked.push(first);

  while (picked.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (!cand) continue;
      const maxSim = picked.reduce((maxS, p) => {
        const sim = textSimilarity(cand.promptText, p.promptText);
        return Math.max(maxS, sim);
      }, 0);
      const mmr = cand.meanScore - lambda * maxSim * 5; // sim is 0-1, score 0-5
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    if (next) picked.push(next);
  }
  return picked;
}

/**
 * Quick token-level Jaccard similarity (lowercased tokens).
 * Returns 0..1 — 0 = totally different, 1 = identical.
 */
function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function weightedSample(items: FrontierPoint[], weights: number[]): FrontierPoint {
  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i];
    const item = items[i];
    if (w == null || !item) continue;
    cumulative += w;
    if (rand <= cumulative) return item;
  }
  const fallback = items[items.length - 1];
  if (!fallback) throw new Error("Unexpected empty items list");
  return fallback;
}
