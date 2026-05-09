import path from "node:path";
import { loadAllCases, loadConfig } from "../config/loader.js";
import { judgeAbsolute } from "../judge/index.js";
import { createProvider } from "../provider/index.js";
import type { EvalCase, FewShotExample } from "../types/index.js";
import { brandPromptSha } from "../types/index.js";

export interface RegressOptions {
  configPath: string;
  threshold?: number;
}

export async function regress(
  opts: RegressOptions,
): Promise<{ passed: boolean; regressed: string[] }> {
  const config = await loadConfig(opts.configPath);
  const projectDir = path.dirname(path.resolve(opts.configPath));

  const { promptText: cleanPrompt, examples } = await loadLockedArtifact(projectDir);

  // Load cases
  const caseFiles = await loadAllCases(`${projectDir}/cases`);
  const evalCases: EvalCase[] = caseFiles.map((c) => ({
    id: c.id,
    generatedAt: c.generated_at,
    difficultyTier: c.difficulty_tier,
    evolutions: c.evolutions,
    tags: c.tags,
    input: c.input,
    reference: {
      output: c.reference.output,
      synthesizerConfidence: c.reference.synthesizer_confidence,
    },
    rubric: c.rubric,
  }));

  // Use the first configured model
  const lockedModel = config.models[0];
  if (!lockedModel) throw new Error("No models configured");
  const provider = createProvider(lockedModel.provider);

  console.log(
    `Running regress: ${evalCases.length} cases against ${lockedModel.alias} (${lockedModel.model})`,
  );

  const results = await judgeAbsolute({
    provider,
    model: config.judge.model,
    cases: evalCases,
    models: [
      (() => {
        const lockedPrompt = {
          alias: lockedModel.alias,
          promptSha: brandPromptSha("regress"),
          promptText: cleanPrompt,
        };
        return examples && examples.length > 0
          ? { ...lockedPrompt, examples }
          : lockedPrompt;
      })(),
    ],
    caseSetSha: "regress",
    completionProvider: provider,
    completionModel: lockedModel.model,
  });

  const threshold = opts.threshold ?? 1.0;
  const regressed: string[] = [];

  for (const result of results) {
    for (const score of result.scores) {
      if (score.score < threshold) {
        regressed.push(`${result.caseId}::${score.criterion} (score: ${score.score})`);
      }
    }
  }

  if (regressed.length > 0) {
    console.error(`Regressions found (${regressed.length}):`);
    for (const r of regressed) {
      console.error(`  - ${r}`);
    }
    return { passed: false, regressed };
  }

  console.log("All cases passed regression.");
  return { passed: true, regressed: [] };
}

export async function loadLockedArtifact(
  projectDir: string,
): Promise<{ promptText: string; examples?: FewShotExample[] }> {
  const lockedPrompt = await Bun.file(path.join(projectDir, "prompts", "locked.md")).text();
  const lines = lockedPrompt.split("\n");
  let inProvenance = true;
  const promptLines: string[] = [];
  for (const line of lines) {
    if (inProvenance && (line.startsWith("# ") || line === "#" || line.trim() === "")) continue;
    inProvenance = false;
    promptLines.push(line);
  }

  let examples: FewShotExample[] | undefined;
  const examplesFile = Bun.file(path.join(projectDir, "prompts", "locked.examples.json"));
  if (await examplesFile.exists()) {
    const parsed = (await examplesFile.json()) as unknown;
    if (!Array.isArray(parsed)) throw new Error("locked.examples.json must contain an array");
    examples = parsed.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.input !== "string" ||
        typeof item.output !== "string" ||
        ("caseId" in item && item.caseId !== undefined && typeof item.caseId !== "string")
      ) {
        throw new Error("locked.examples.json contains an invalid few-shot example");
      }
      return item as FewShotExample;
    });
  }

  const artifact: { promptText: string; examples?: FewShotExample[] } = {
    promptText: promptLines.join("\n").trim(),
  };
  if (examples && examples.length > 0) artifact.examples = examples;
  return artifact;
}
