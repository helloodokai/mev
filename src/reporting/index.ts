import type { EscalationEvent, EvolutionStep, FrontierPoint } from "../types/index.js";

export function generateHtmlReport(data: {
  frontier: FrontierPoint[];
  evolutionSteps: EvolutionStep[];
  escalations: EscalationEvent[];
  runId: string;
  kneeIndex: number;
}): string {
  const { frontier, evolutionSteps, escalations, runId, kneeIndex } = data;

  const frontierRows = frontier
    .map((p, i) => {
      const isKnee = i === kneeIndex;
      return `        <tr class="${isKnee ? "knee" : ""}">
          <td>${p.promptSha.slice(0, 8)}</td>
          <td>${p.modelAlias}</td>
          <td>${p.meanScore.toFixed(2)}</td>
          <td>$${p.totalCostUsd.toFixed(2)}</td>
          <td>${p.p95LatencyMs.toFixed(0)}ms</td>
          <td>${isKnee ? "knee" : ""}</td>
        </tr>`;
    })
    .join("\n");

  const evolutionNodes = evolutionSteps
    .map(
      (s) =>
        `        { id: "${s.childId.slice(0, 8)}", parent: "${s.parentId?.slice(0, 8) ?? "root"}", score: ${s.meanScore.toFixed(2)}, reflection: ${JSON.stringify(s.reflection.slice(0, 200))} }`,
    )
    .join(",\n");

  const escalationRows = escalations
    .map(
      (e) => `        <tr>
          <td>${e.kind}</td>
          <td>${e.priority.toFixed(2)}</td>
          <td>${e.details}</td>
          <td>${e.defaultAction}</td>
        </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>mev report — ${runId}</title>
<style>
  body { font-family: monospace; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1, h2 { color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.85rem; }
  th { background: #f5f5f5; }
  .knee { background: #ffffcc; font-weight: bold; }
  .scatter { width: 100%; height: 400px; }
  pre { background: #f8f8f8; padding: 1rem; overflow-x: auto; }
  .escalation { margin: 0.5rem 0; padding: 0.5rem; border-left: 3px solid #cc0; background: #fff8e8; }
</style>
</head>
<body>
<h1>mev optimization report</h1>
<p>Run: <code>${runId}</code></p>

<h2>Pareto Frontier</h2>
<table>
  <tr><th>Prompt</th><th>Model</th><th>Score</th><th>Cost</th><th>p95 Latency</th><th>Note</th></tr>
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

<h2>Prompt Evolution</h2>
<pre id="evolution-data">${evolutionNodes}</pre>

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
<p>mev v0.1.0</p>
</body>
</html>`;
}

function generateScatterPoints(frontier: FrontierPoint[], kneeIndex: number): string {
  if (frontier.length === 0) return "";

  const maxCost = Math.max(...frontier.map((p) => p.totalCostUsd), 1);
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
  } = data;
  const knee = frontier[kneeIndex];

  const escalationSummary =
    escalations.length > 0
      ? `${escalations.length} escalation(s) fired: ${escalations.map((e) => e.kind).join(", ")}.`
      : "No escalations fired.";

  const improvementText =
    openWeightImprovement > 0
      ? ` Open-weight score improved by ${openWeightImprovement.toFixed(2)} points through prompt evolution.`
      : "";

  if (!knee) {
    return `# mev run summary

**Run**: ${runId}
**Pareto frontier**: ${frontier.length} point(s)
**Cases**: ${casesCount} | **Generations**: ${generationsUsed} | **Total cost**: $${totalCost.toFixed(2)}
**Best score**: ${bestScore.toFixed(2)}${improvementText}

${escalationSummary}

Lock in with \`mev optimize\` or re-run with \`mev regress\` to verify stability.`;
  }

  return `# mev run summary

**Run**: ${runId}
**Pareto frontier**: ${frontier.length} point(s)
**Knee point**: prompt ${knee.promptSha.slice(0, 8)} + ${knee.modelAlias} (score: ${knee.meanScore.toFixed(2)}, cost: $${knee.totalCostUsd.toFixed(2)})
**Cases**: ${casesCount} | **Generations**: ${generationsUsed} | **Total cost**: $${totalCost.toFixed(2)}
**Best score**: ${bestScore.toFixed(2)}${improvementText}

${escalationSummary}

Lock in with \`mev optimize\` or re-run with \`mev regress\` to verify stability.`;
}
