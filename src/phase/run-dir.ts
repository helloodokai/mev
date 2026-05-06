import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveCase, saveSpec } from "../config/loader.js";
import type { TaskSpecFile } from "../types/config.js";
import type { CaseFile, RunId } from "../types/index.js";
import { brandRunId } from "../types/index.js";

export async function createRunDir(baseDir: string): Promise<{ runId: RunId; runDir: string }> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = brandRunId(timestamp);
  const runDir = path.join(baseDir, "runs", timestamp);

  await mkdir(path.join(runDir, "cases"), { recursive: true });

  return { runId, runDir };
}

export async function writeRunMeta(
  runDir: string,
  meta: {
    id: string;
    startedAt: string;
    mevVersion: string;
    budget: { maxUsd: number; maxMinutes: number; generations: number; casesTarget: number };
  },
): Promise<void> {
  await writeFile(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
}

export async function writeJsonl(
  runDir: string,
  filename: string,
  record: Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(runDir, filename);
  const line = JSON.stringify(record) + "\n";
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (exists) {
    const content = await file.text();
    await writeFile(filePath, content + line);
  } else {
    await writeFile(filePath, line);
  }
}

export async function writeParetoResult(
  runDir: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeFile(path.join(runDir, "pareto.json"), JSON.stringify(result, null, 2));
}

export async function writeEvolutionStep(
  runDir: string,
  step: Record<string, unknown>,
): Promise<void> {
  await writeJsonl(runDir, "evolution.ndjson", step);
}

export async function writeBaselineResult(
  runDir: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeJsonl(runDir, "baseline.jsonl", result);
}

export async function writeSweepResult(
  runDir: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeJsonl(runDir, "sweep.jsonl", result);
}

export async function snapshotCases(cases: CaseFile[], runDir: string): Promise<void> {
  for (const c of cases) {
    await saveCase(c, path.join(runDir, "cases"));
  }
}

export async function snapshotSpec(spec: TaskSpecFile, runDir: string): Promise<void> {
  await saveSpec(spec, path.join(runDir, "spec.json"));
}
