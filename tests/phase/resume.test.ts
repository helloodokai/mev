import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  writeCheckpoint,
  loadCheckpoint,
  latestRunDir,
  createRunDir,
  restoreCases,
} from "../../src/phase/run-dir.js";
import { saveCase } from "../../src/config/loader.js";
import type { CaseFile, FrontierPoint } from "../../src/types/core.js";
import { brandPromptSha } from "../../src/types/core.js";

function makeTmpBase(): string {
  return path.join(os.tmpdir(), `mev-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function setup(tmpBase: string) {
  mkdirSync(tmpBase, { recursive: true });
}

function teardown(tmpBase: string) {
  try { rmSync(tmpBase, { recursive: true }); } catch { /* no-op */ }
}

describe("Checkpoint / Resume", () => {
  it("round-trips a checkpoint", async () => {
    const tmpBase = makeTmpBase();
    setup(tmpBase);
    const { runDir } = await createRunDir(tmpBase);
    const frontier: FrontierPoint[] = [
      {
        promptSha: brandPromptSha("abc123"),
        promptText: "test prompt",
        modelAlias: "test",
        meanScore: 3.5,
        totalCostUsd: 0.01,
        p95LatencyMs: 500,
        generation: 2,
      },
    ];
    await writeCheckpoint(runDir, {
      phase: "evolution",
      startedAt: new Date().toISOString(),
      config: { generationsLeft: 3, nextGeneration: 4 },
      frontier,
    });
    const cp = await loadCheckpoint(runDir);
    expect(cp).not.toBeNull();
    expect(cp!.phase).toBe("evolution");
    expect(cp!.config.generationsLeft).toBe(3);
    expect(cp!.frontier.length).toBe(1);
    expect(cp!.frontier[0]!.meanScore).toBe(3.5);
    teardown(tmpBase);
  });

  it("finds latest run directory", async () => {
    const tmpBase = makeTmpBase();
    setup(tmpBase);
    const { runDir: a } = await createRunDir(tmpBase);
    await new Promise((r) => setTimeout(r, 15));
    const { runDir: b } = await createRunDir(tmpBase);
    const latest = await latestRunDir(tmpBase);
    expect(latest).toBe(b);
    teardown(tmpBase);
  });

  it("returns null checkpoint for missing file", async () => {
    const tmpBase = makeTmpBase();
    setup(tmpBase);
    const { runDir } = await createRunDir(tmpBase);
    const cp = await loadCheckpoint(runDir);
    expect(cp).toBeNull();
    teardown(tmpBase);
  });

  it("restores cases written by snapshotCases", async () => {
    const tmpBase = makeTmpBase();
    setup(tmpBase);
    const { runDir } = await createRunDir(tmpBase);
    const c: CaseFile = {
      id: "0001",
      generated_at: new Date().toISOString(),
      difficulty_tier: 2,
      evolutions: [],
      tags: ["a"],
      input: { content: "hello" },
      reference: { output: "world", synthesizer_confidence: 0.9 },
      rubric: { quality: "good" },
    };
    await saveCase(c, path.join(runDir, "cases"));
    const restored = await restoreCases(runDir);
    expect(restored.length).toBe(1);
    expect(restored[0]!.id).toBe("0001");
    expect(restored[0]!.input.content).toBe("hello");
    teardown(tmpBase);
  });

  it("reads locked vs unlocked checkpoint correctly", async () => {
    const tmpBase = makeTmpBase();
    setup(tmpBase);
    const { runDir: oldDir } = await createRunDir(tmpBase);
    await new Promise((r) => setTimeout(r, 15));
    const { runDir: newDir } = await createRunDir(tmpBase);

    await writeCheckpoint(oldDir, {
      phase: "locked",
      startedAt: new Date().toISOString(),
      config: { generationsLeft: 0, nextGeneration: 1 },
      frontier: [],
    });
    await writeCheckpoint(newDir, {
      phase: "evolution",
      startedAt: new Date().toISOString(),
      config: { generationsLeft: 2, nextGeneration: 3 },
      frontier: [],
    });

    const latest = await latestRunDir(tmpBase);
    const cp = await loadCheckpoint(latest!);
    expect(cp!.phase).toBe("evolution");
    teardown(tmpBase);
  });
});
