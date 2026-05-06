import { CaseFileSchema } from "../types/config.js";
import type { EvalCase } from "../types/index.js";

export function createCaseFromFailure(
  caseId: string,
  input: string,
  referenceOutput: string,
  rubric: Record<string, string>,
  tags: string[],
): EvalCase {
  return {
    id: caseId,
    generatedAt: new Date().toISOString(),
    difficultyTier: 3,
    evolutions: ["promoted_from_failure"],
    tags,
    input: { content: input },
    reference: {
      output: referenceOutput,
      synthesizerConfidence: 0.6,
    },
    rubric,
  };
}

export function caseToCaseFile(caseData: EvalCase) {
  return CaseFileSchema.parse({
    id: caseData.id,
    generated_at: caseData.generatedAt,
    difficulty_tier: caseData.difficultyTier,
    evolutions: caseData.evolutions,
    tags: caseData.tags,
    input: caseData.input,
    reference: caseData.reference,
    rubric: caseData.rubric,
  });
}
