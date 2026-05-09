import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockIn } from "../../src/lockin/index.js";
import type { CaseFile, MevConfig } from "../../src/types/index.js";
import { brandPromptSha } from "../../src/types/index.js";

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `mev-lockin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeConfig(): MevConfig {
  return {
    project: { name: "test", intent: "test", seed_examples: [] },
    constraints: { max_latency_p95_ms: 5000, must_be_local: true, forbid_data_leakage: false },
    budget: { max_usd: 1, max_minutes: 1, generations: 1, cases: 1 },
    optimization: {
      holdout_fraction: 0.3,
      beam_width: 3,
      judge_samples: 1,
      crossover_rate: 0.3,
      max_examples: 3,
      escalate_on_plateau: true,
      lockin_best_of_n: 1,
    },
    models: [{ alias: "test", provider: "ollama-local", model: "qwen2.5:7b" }],
    judge: { provider: "ollama-local", model: "gemma4:e4b" },
    synthesizer: { provider: "ollama-local", model: "gemma4:e4b" },
    critic: { provider: "ollama-local", model: "gemma4:e4b" },
  };
}

function makeCase(): CaseFile {
  return {
    id: "0001",
    generated_at: new Date().toISOString(),
    difficulty_tier: 2,
    evolutions: [],
    tags: [],
    input: { content: "hello" },
    reference: { output: "world", synthesizer_confidence: 0.9 },
    rubric: { quality: "good" },
  };
}

describe("lockIn", () => {
  it("writes locked few-shot examples beside locked.md", async () => {
    const tmpDir = makeTmpDir();
    mkdirSync(path.join(tmpDir, "runs", "run-1"), { recursive: true });

    try {
      const result = await lockIn({
        projectDir: tmpDir,
        selectedPoint: {
          promptSha: brandPromptSha("sha1"),
          promptText: "prompt",
          modelAlias: "test",
          meanScore: 4.5,
          totalCostUsd: 0,
          p95LatencyMs: 10,
          generation: 1,
          examples: [{ input: "in", output: "out", caseId: "0001" }],
        },
        config: makeConfig(),
        cases: [makeCase()],
        runId: "run-1" as never,
        summary: "summary",
        escalationResolutions: new Map(),
        totalCost: 0,
        bestScore: 4.5,
      });

      expect(result.examplesPath).toBe(path.join(tmpDir, "prompts", "locked.examples.json"));
      const written = JSON.parse(
        readFileSync(path.join(tmpDir, "prompts", "locked.examples.json"), "utf8"),
      ) as Array<{ input: string; output: string; caseId?: string }>;
      expect(written).toEqual([{ input: "in", output: "out", caseId: "0001" }]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
