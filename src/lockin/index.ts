import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaseFile, FrontierPoint, MevConfig } from "../types/index.js";

export interface LockInResult {
  promptPath: string;
  configPath: string;
  casesDir: string;
  summaryPath: string;
}

export async function lockIn(opts: {
  projectDir: string;
  selectedPoint: FrontierPoint;
  config: MevConfig;
  cases: CaseFile[];
  runId: string;
  summary: string;
  escalationResolutions: Map<string, string>;
  totalCost: number;
  bestScore: number;
}): Promise<LockInResult> {
  const { projectDir, selectedPoint, config, cases, runId, summary } = opts;

  // Write locked prompt
  const promptsDir = path.join(projectDir, "prompts");
  await mkdir(promptsDir, { recursive: true });

  const provenanceLines = [
    "# mev locked prompt",
    `# Run: ${runId}`,
    `# Model: ${selectedPoint.modelAlias}`,
    `# Score: ${selectedPoint.meanScore.toFixed(2)}`,
  ];
  if (selectedPoint.holdoutScore !== undefined) {
    provenanceLines.push(`# Holdout score: ${selectedPoint.holdoutScore.toFixed(2)} (true generalization)`);
  }
  if (selectedPoint.scoreVariance !== undefined) {
    provenanceLines.push(`# Score variance: ${selectedPoint.scoreVariance.toFixed(3)} (lower = more consistent)`);
  }
  provenanceLines.push(
    `# Latency p95: ${selectedPoint.p95LatencyMs}ms`,
    `# Cost: $${selectedPoint.totalCostUsd.toFixed(4)}`,
    `# Prompt SHA: ${selectedPoint.promptSha}`,
    `# Generation: ${selectedPoint.generation}`,
    "#",
  );
  const provenanceHeader = provenanceLines.join("\n");

  const promptContent = `${provenanceHeader}\n${selectedPoint.promptText}\n`;
  const promptPath = path.join(promptsDir, "locked.md");
  await writeFile(promptPath, promptContent);

  // Write cases
  const casesDir = path.join(projectDir, "cases");
  await mkdir(casesDir, { recursive: true });
  for (const c of cases) {
    const casePath = path.join(casesDir, `${c.id.padStart(4, "0")}.toml`);
    const caseContent = serializeCase(c);
    await writeFile(casePath, caseContent);
  }

  // Update config to make locked model the default
  const updatedConfig = { ...config };
  const lockedModelIndex = updatedConfig.models.findIndex(
    (m) => m.alias === selectedPoint.modelAlias,
  );
  if (lockedModelIndex >= 0) {
    // Move locked model to first position (the default)
    const removed = updatedConfig.models.splice(lockedModelIndex, 1);
    const lockedModel = removed[0];
    if (lockedModel) updatedConfig.models.unshift(lockedModel);
  }

  const configPath = path.join(projectDir, "mev.toml");
  const { stringify } = await import("smol-toml");
  await writeFile(configPath, stringify(updatedConfig as unknown as Record<string, unknown>));

  // Write summary
  const runsDir = path.join(projectDir, "runs", runId);
  const summaryPath = path.join(runsDir, "SUMMARY.md");
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, summary);

  return { promptPath, configPath, casesDir, summaryPath };
}

function serializeCase(c: CaseFile): string {
  // Escape triple quotes in TOML multiline strings
  const escapeTripleQuotes = (s: string) => s.replace(/"""/g, '"\"\"');

  const lines = [
    `id = "${c.id}"`,
    `generated_at = "${c.generated_at}"`,
    `difficulty_tier = ${c.difficulty_tier}`,
    `evolutions = [${c.evolutions.map((e) => `"${e}"`).join(", ")}]`,
    `tags = [${c.tags.map((t) => `"${t}"`).join(", ")}]`,
    `holdout = ${c.holdout ? "true" : "false"}`,
    "",
    "[input]",
    `content = """${escapeTripleQuotes(c.input.content)}"""`,
    "",
    "[reference]",
    `output = """${escapeTripleQuotes(c.reference.output)}"""`,
    `synthesizer_confidence = ${c.reference.synthesizer_confidence}`,
    "",
    "[rubric]",
  ];
  for (const [k, v] of Object.entries(c.rubric)) {
    lines.push(`${k} = "${escapeTripleQuotes(v)}"`);
  }
  return lines.join("\n");
}
