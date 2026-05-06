import { z } from "zod";

export const CriticVerdictSchema = z.object({
  is_clear: z.boolean(),
  is_unambiguous: z.boolean(),
  is_aligned_with_intent: z.boolean(),
  is_trivially_solvable: z.boolean(),
  is_within_scope: z.boolean(),
  difficulty_tier: z.number().int().min(1).max(5),
  reasoning: z.string(),
});

export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

export const JudgeOutputSchema = z.object({
  scores: z.array(
    z.object({
      criterion: z.string(),
      score: z.number().min(1).max(5),
      confidence: z.number().min(0).max(1),
      justification: z.string(),
    }),
  ),
  overall_assessment: z.string(),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export const PairwiseJudgeOutputSchema = z.object({
  winner: z.enum(["A", "B", "tie_uncertain"]),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  criterion_scores: z.array(
    z.object({
      criterion: z.string(),
      model_a_score: z.number().min(1).max(5),
      model_b_score: z.number().min(1).max(5),
    }),
  ),
});

export type PairwiseJudgeOutput = z.infer<typeof PairwiseJudgeOutputSchema>;

export const EvolutionReflectionSchema = z.object({
  critique: z.string().min(1),
  proposed_edit_description: z.string().min(1),
  rationale: z.string().min(1),
});

export type EvolutionReflection = z.infer<typeof EvolutionReflectionSchema>;

export const EditedPromptSchema = z.object({
  prompt: z.string().min(1),
  changes_made: z.array(z.string()),
  expected_improvement: z.string(),
});

export type EditedPrompt = z.infer<typeof EditedPromptSchema>;
