import type { EscalationEvent, EvolutionStep, FrontierPoint } from "../types/index.js";

export function generateHtmlReport(data: {
  frontier: FrontierPoint[];
  evolutionSteps: EvolutionStep[];
  escalations: EscalationEvent[];
  runId: string;
  kneeIndex: number;
  baselineScore?: number;
  baselineHoldoutScore?: number;
  trainCases?: number;
  holdoutCases?: number;
}): string {
  const {
    frontier,
    evolutionSteps,
    escalations,
    runId,
    kneeIndex,
    baselineScore,
    baselineHoldoutScore,
    trainCases,
    holdoutCases,
  } = data;

  const hasHoldout = frontier.some((p) => p.holdoutScore !== undefined);

  const frontierRows = frontier
    .map((p, i) => {
      const isKnee = i === kneeIndex;
      const operator = evolutionSteps.find((s) => s.childId === p.promptSha)?.operator ?? "—";
      return `        <tr class="${isKnee ? "knee" : ""}">
          <td>${p.promptSha.slice(0, 8)}</td>
          <td>${p.modelAlias}</td>
          <td>${p.meanScore.toFixed(2)}</td>
          <td>${p.holdoutScore !== undefined ? p.holdoutScore.toFixed(2) : "—"}</td>
          <td>${p.scoreVariance !== undefined ? p.scoreVariance.toFixed(3) : "—"}</td>
          <td>$${p.totalCostUsd.toFixed(4)}</td>
          <td>${p.p95LatencyMs.toFixed(0)}ms</td>
          <td>g${p.generation}</td>
          <td>${operator}</td>
          <td>${isKnee ? "★ knee" : ""}</td>
        </tr>`;
    })
    .join("\n");

  const evolutionTimeline = evolutionSteps
    .map((s) => {
      const op = s.operator ?? "mutate";
      const opIcon = op === "crossover" ? "⨯" : op === "example_swap" ? "ex" : "→";
      const parents = s.parents && s.parents.length > 1 ? s.parents.map((p) => p.slice(0, 8)).join(" + ") : (s.parentId?.slice(0, 8) ?? "root");
      return `<tr><td>g${s.generation}</td><td>${opIcon} ${op}</td><td>${parents}</td><td>${s.childId.slice(0, 8)}</td><td>${s.meanScore.toFixed(2)}</td><td>$${s.costUsd.toFixed(4)}</td><td>${escapeHtml(s.reflection.slice(0, 200))}…</td></tr>`;
    })
    .join("\n");

  const escalationRows = escalations
    .map(
      (e) => `        <tr>
          <td>${e.kind}</td>
          <td>${e.priority.toFixed(2)}</td>
          <td>${escapeHtml(e.details)}</td>
          <td>${escapeHtml(e.defaultAction)}</td>
        </tr>`,
    )
    .join("\n");

  const headlineHtml = renderHeadline({
    baselineScore,
    baselineHoldoutScore,
    frontier,
    kneeIndex,
    hasHoldout,
    trainCases,
    holdoutCases,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>mev report — ${runId}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.5; }
  h1 { color: #111; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
  h2 { color: #333; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 0.82rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f6f6f6; font-weight: 600; }
  .knee { background: #fff7d6; font-weight: bold; }
  .scatter { width: 100%; height: 400px; }
  pre { background: #f8f8f8; padding: 1rem; overflow-x: auto; border-radius: 4px; font-size: 0.78rem; }
  .escalation { margin: 0.5rem 0; padding: 0.5rem; border-left: 3px solid #cc0; background: #fff8e8; }
  .headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; }
  .metric .label { font-size: 0.7rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; }
  .metric .value { font-size: 1.6rem; font-weight: 600; color: #111; font-family: ui-monospace, monospace; }
  .metric .delta { font-size: 0.85rem; color: #16a34a; font-weight: 500; }
  .metric .delta.neg { color: #dc2626; }
  code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
  .legend { color: #666; font-size: 0.85rem; margin: 0.5rem 0; }
</style>
</head>
<body>
<h1>mev optimization report</h1>
<p>Run: <code>${runId}</code></p>

${headlineHtml}

<h2>Pareto Frontier${hasHoldout ? " (selected on holdout score)" : ""}</h2>
<p class="legend">★ = lock-in winner. Holdout score = generalization on cases never seen during evolution. Variance = inter-case score consistency (lower = more reliable).</p>
<table>
  <tr><th>Prompt</th><th>Model</th><th>Train</th><th>Holdout</th><th>Var</th><th>Cost</th><th>p95</th><th>Gen</th><th>Op</th><th></th></tr>
${frontierRows}
</table>

<h2>Score vs Cost</h2>
<svg class="scatter" viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg">
  <line x1="60" y1="360" x2="60" y2="20" stroke="#666" stroke-width="1"/>
  <line x1="60" y1="360" x2="780" y2="360" stroke="#666" stroke-width="1"/>
  <text x="30" y="200" transform="rotate(-90,30,200)" fill="#666" font-size="12">Score</text>
  <text x="420" y="395" fill="#666" font-size="12">Cost ($)</text>
${generateScatterPoints(frontier, kneeIndex)}
</svg>

<h2>Evolution Timeline</h2>
<p class="legend">⨯ = crossover, → = mutation, ex = example swap.</p>
${
  evolutionSteps.length === 0
    ? "<p>No evolution steps recorded.</p>"
    : `<table>
  <tr><th>Gen</th><th>Op</th><th>Parents</th><th>Child</th><th>Score</th><th>Cost</th><th>Reflection</th></tr>
${evolutionTimeline}
</table>`
}

<h2>Escalations</h2>
${
  escalations.length === 0
    ? "<p>No escalations during this run.</p>"
    : `<table>
  <tr><th>Kind</th><th>Priority</th><th>Details</th><th>Default</th></tr>
${escalationRows}
</table>`
}

<h2>Provenance</h2>
<p>mev v0.3.0 — train/test split + beam search + self-consistency + crossover</p>
</body>
</html>`;
}

function renderHeadline(d: {
  baselineScore: number | undefined;
  baselineHoldoutScore: number | undefined;
  frontier: FrontierPoint[];
  kneeIndex: number;
  hasHoldout: boolean;
  trainCases: number | undefined;
  holdoutCases: number | undefined;
}): string {
  const knee = d.frontier[d.kneeIndex];
  if (!knee) return "";
  const finalScore = d.hasHoldout && knee.holdoutScore !== undefined ? knee.holdoutScore : knee.meanScore;
  const baseline = d.hasHoldout && d.baselineHoldoutScore !== undefined ? d.baselineHoldoutScore : d.baselineScore;
  const delta = baseline !== undefined ? finalScore - baseline : null;
  const deltaPct = baseline !== undefined && baseline > 0 ? (delta! / baseline) * 100 : null;
  const deltaClass = delta !== null && delta < 0 ? "delta neg" : "delta";
  const deltaStr =
    deltaPct !== null
      ? `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% (${delta! >= 0 ? "+" : ""}${delta!.toFixed(2)})`
      : "—";

  return `<div class="headline">
  <div class="metric">
    <div class="label">${d.hasHoldout ? "Holdout score" : "Score"}</div>
    <div class="value">${finalScore.toFixed(2)}</div>
    <div class="${deltaClass}">${deltaStr}</div>
  </div>
  <div class="metric">
    <div class="label">Baseline</div>
    <div class="value">${baseline !== undefined ? baseline.toFixed(2) : "—"}</div>
  </div>
  <div class="metric">
    <div class="label">Variance</div>
    <div class="value">${knee.scoreVariance !== undefined ? knee.scoreVariance.toFixed(3) : "—"}</div>
  </div>
  <div class="metric">
    <div class="label">Train / Holdout</div>
    <div class="value">${d.trainCases ?? "—"} / ${d.holdoutCases ?? 0}</div>
  </div>
  <div class="metric">
    <div class="label">Cost</div>
    <div class="value">$${knee.totalCostUsd.toFixed(4)}</div>
  </div>
  <div class="metric">
    <div class="label">p95 latency</div>
    <div class="value">${knee.p95LatencyMs}ms</div>
  </div>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateScatterPoints(frontier: FrontierPoint[], kneeIndex: number): string {
  if (frontier.length === 0) return "";

  const maxCost = Math.max(...frontier.map((p) => p.totalCostUsd), 0.0001);
  const maxScore = Math.max(...frontier.map((p) => p.meanScore), 1);

  return frontier
    .map((p, i) => {
      const x = 60 + (p.totalCostUsd / maxCost) * 700;
      const y = 360 - (p.meanScore / maxScore) * 340;
      const isKnee = i === kneeIndex;
      const fill = isKnee ? "#ffcc00" : "#4a90d9";
      const r = isKnee ? 6 : 4;
      return `  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" />`;
    })
    .join("\n");
}

export function generateSummary(data: {
  runId: string;
  frontier: FrontierPoint[];
  kneeIndex: number;
  totalCost: number;
  escalations: EscalationEvent[];
  generationsUsed: number;
  casesCount: number;
  bestScore: number;
  openWeightImprovement: number;
  baselineScore?: number;
  baselineHoldoutScore?: number;
  trainCases?: number;
  holdoutCases?: number;
}): string {
  const {
    runId,
    frontier,
    kneeIndex,
    totalCost,
    escalations,
    generationsUsed,
    casesCount,
    bestScore,
    openWeightImprovement,
    baselineScore,
    baselineHoldoutScore,
    trainCases,
    holdoutCases,
  } = data;
  const knee = frontier[kneeIndex];
  const hasHoldout = (holdoutCases ?? 0) > 0;

  const escalationSummary =
    escalations.length > 0
      ? `${escalations.length} escalation(s) fired: ${escalations.map((e) => e.kind).join(", ")}.`
      : "No escalations fired.";

  const improvementSection =
    baselineScore !== undefined
      ? `**Baseline → Final** (${hasHoldout ? "holdout" : "train"}): ${(hasHoldout ? baselineHoldoutScore ?? baselineScore : baselineScore).toFixed(2)} → ${(hasHoldout ? knee?.holdoutScore ?? knee?.meanScore : knee?.meanScore)?.toFixed(2) ?? "—"} (${openWeightImprovement >= 0 ? "+" : ""}${openWeightImprovement.toFixed(1)}%)`
      : `**Best score**: ${bestScore.toFixed(2)}`;

  const splitLine = hasHoldout
    ? `**Cases**: ${trainCases} train + ${holdoutCases} holdout (generalization)`
    : `**Cases**: ${casesCount}`;

  if (!knee) {
    return `# mev run summary

**Run**: ${runId}
**Pareto frontier**: ${frontier.length} point(s)
${splitLine} | **Generations**: ${generationsUsed} | **Total cost**: $${totalCost.toFixed(4)}
${improvementSection}

${escalationSummary}

Lock in with \`mev optimize\` or re-run with \`mev regress\` to verify stability.`;
  }

  const holdoutLine =
    knee.holdoutScore !== undefined
      ? `\n**Holdout score**: ${knee.holdoutScore.toFixed(2)} (true generalization)`
      : "";
  const varianceLine =
    knee.scoreVariance !== undefined
      ? `\n**Score variance**: ${knee.scoreVariance.toFixed(3)} (lower = more consistent)`
      : "";

  return `# mev run summary

**Run**: ${runId}
**Pareto frontier**: ${frontier.length} point(s)
**Winner**: prompt \`${knee.promptSha.slice(0, 8)}\` + ${knee.modelAlias} (score: ${knee.meanScore.toFixed(2)}, cost: $${knee.totalCostUsd.toFixed(4)})${holdoutLine}${varianceLine}
${splitLine} | **Generations**: ${generationsUsed} | **Total cost**: $${totalCost.toFixed(4)}
${improvementSection}

${escalationSummary}

Lock in with \`mev optimize\` or re-run with \`mev regress\` to verify stability.`;
}