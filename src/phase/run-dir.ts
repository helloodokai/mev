import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCase, saveCase, saveSpec } from "../config/loader.js";
import type { TaskSpecFile } from "../types/config.js";
import type { CaseFile, FrontierPoint, RunId } from "../types/index.js";
import { brandRunId } from "../types/index.js";

export interface Checkpoint {
  phase: "baseline" | "evolution" | "sweep" | "pareto" | "locked";
  startedAt: string;
  config: {
    generationsLeft: number;
    nextGeneration: number;
  };
  frontier: FrontierPoint[];
}

export async function createRunDir(baseDir: string): Promise<{ runId: RunId; runDir: string }> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = brandRunId(timestamp);
  const runDir = path.join(baseDir, "runs", timestamp);

  await mkdir(path.join(runDir, "cases"), { recursive: true });

  return { runId, runDir };
}

async function lockFile(runDir: string, fn: () => Promise<void>, maxWaitMs = 30000): Promise<void> {
  const lockPath = path.join(runDir, ".lock");
  const started = Date.now();
  while (await Bun.file(lockPath).exists()) {
    if (Date.now() - started > maxWaitMs) throw new Error("Lock timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await writeFile(lockPath, "");
    await fn();
  } finally {
    try {
      await Bun.file(lockPath).delete();
    } catch {
      /* no-op */
    }
  }
}

export async function writeCheckpoint(runDir: string, checkpoint: Checkpoint): Promise<void> {
  await lockFile(runDir, async () => {
    await writeFile(path.join(runDir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2));
  });
}

export async function loadCheckpoint(runDir: string): Promise<Checkpoint | null> {
  try {
    const text = await readFile(path.join(runDir, "checkpoint.json"), "utf-8");
    return JSON.parse(text) as Checkpoint;
  } catch {
    return null;
  }
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
  await lockFile(runDir, async () => {
    await writeFile(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  });
}

export async function writeJsonl(
  runDir: string,
  filename: string,
  record: Record<string, unknown>,
): Promise<void> {
  await lockFile(runDir, async () => {
    const filePath = path.join(runDir, filename);
    const line = `${JSON.stringify(record)}\n`;
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (exists) {
      const content = await file.text();
      await writeFile(filePath, content + line);
    } else {
      await writeFile(filePath, line);
    }
  });
}

export async function writeParetoResult(
  runDir: string,
  result: Record<string, unknown>,
): Promise<void> {
  await lockFile(runDir, async () => {
    await writeFile(path.join(runDir, "pareto.json"), JSON.stringify(result, null, 2));
  });
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

export async function restoreCases(runDir: string): Promise<CaseFile[]> {
  const casesDir = path.join(runDir, "cases");
  const files = await readdir(casesDir);
  const cases: CaseFile[] = [];
  for (const f of files.filter((name) => name.endsWith(".toml"))) {
    cases.push(await loadCase(path.join(casesDir, f)));
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function snapshotSpec(spec: TaskSpecFile, runDir: string): Promise<void> {
  await saveSpec(spec, path.join(runDir, "spec.json"));
}

export async function latestRunDir(projectDir: string): Promise<string | null> {
  const runsDir = path.join(projectDir, "runs");
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    const first = dirs[0];
    return first ? path.join(runsDir, first) : null;
  } catch {
    return null;
  }
}
