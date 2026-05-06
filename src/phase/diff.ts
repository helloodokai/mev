import path from "node:path";

export async function diffRuns(runA: string, runB: string, configPath: string): Promise<string> {
  const projectDir = path.dirname(configPath);

  // Load both run directories
  const runADir = path.join(projectDir, "runs", runA);
  const runBDir = path.join(projectDir, "runs", runB);

  const paretoA = await loadPareto(runADir);
  const paretoB = await loadPareto(runBDir);

  const lines: string[] = [`# Diff: ${runA} vs ${runB}`, "", "## Score Comparison"];

  const allModels = new Set([...Object.keys(paretoA), ...Object.keys(paretoB)]);
  for (const model of allModels) {
    const scoreA = paretoA[model]?.toFixed(2) ?? "N/A";
    const scoreB = paretoB[model]?.toFixed(2) ?? "N/A";
    const diff =
      paretoA[model] !== undefined && paretoB[model] !== undefined
        ? (paretoB[model] - paretoA[model]).toFixed(2)
        : "N/A";
    lines.push(`  ${model.padEnd(20)} ${scoreA.padStart(6)} → ${scoreB.padStart(6)}  (${diff})`);
  }

  return lines.join("\n");
}

async function loadPareto(runDir: string): Promise<Record<string, number>> {
  try {
    const file = Bun.file(path.join(runDir, "pareto.json"));
    const data = await file.json();
    const results: Record<string, number> = {};
    if (data && typeof data === "object" && "frontier" in data) {
      for (const point of (data as { frontier: Array<{ modelAlias: string; meanScore: number }> })
        .frontier) {
        results[point.modelAlias] = point.meanScore;
      }
    }
    return results;
  } catch {
    return {};
  }
}
