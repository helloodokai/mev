import { z } from "zod";

const ProviderIdSchema = z.enum(["anthropic", "openai", "ollama-cloud", "ollama-local"]);

const ModelEntrySchema = z.object({
  alias: z.string().min(1),
  provider: ProviderIdSchema,
  model: z.string().min(1),
});

const JudgeSynthCriticSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
});

export const MevConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    intent: z.string().min(1),
    seed_examples: z.array(z.string()).default([]),
    starter_prompt_path: z.string().min(1).optional(),
  }),
  constraints: z.object({
    max_latency_p95_ms: z.number().int().positive().default(5000),
    must_be_local: z.boolean().default(false),
    forbid_data_leakage: z.boolean().default(false),
  }),
  budget: z.object({
    max_usd: z.number().positive().default(5.0),
    max_minutes: z.number().positive().default(15),
    generations: z.number().int().positive().default(8),
    cases: z.number().int().positive().default(40),
  }),
  optimization: z
    .object({
      // Train/test split: fraction of cases held out for final evaluation
      holdout_fraction: z.number().min(0).max(0.5).default(0.3),
      // Beam search width: how many top prompts to keep per generation
      beam_width: z.number().int().min(1).max(10).default(3),
      // Self-consistency: number of judge samples to aggregate (1 = no SC)
      judge_samples: z.number().int().min(1).max(7).default(1),
      // Crossover: probability of applying crossover vs mutation
      crossover_rate: z.number().min(0).max(1).default(0.3),
      // Few-shot: max number of bootstrapped examples to attach
      max_examples: z.number().int().min(0).max(10).default(3),
      // On plateau: generate harder cases instead of stopping
      escalate_on_plateau: z.boolean().default(true),
      // Best-of-N inference for final lock-in evaluation
      lockin_best_of_n: z.number().int().min(1).max(7).default(1),
    })
    .default({}),
  models: z.array(ModelEntrySchema).min(1),
  judge: JudgeSynthCriticSchema,
  synthesizer: JudgeSynthCriticSchema,
  critic: JudgeSynthCriticSchema,
});

export type MevConfig = z.infer<typeof MevConfigSchema>;

export const CaseFileSchema = z.object({
  id: z.string().min(1),
  generated_at: z.string(),
  difficulty_tier: z.number().int().min(1).max(5),
  evolutions: z.array(z.string()),
  tags: z.array(z.string()),
  input: z.object({ content: z.string().min(1) }),
  reference: z.object({
    output: z.string().min(1),
    synthesizer_confidence: z.number().min(0).max(1),
  }),
  rubric: z.record(z.string(), z.string()),
  // true = held out for final evaluation only (not used during evolution)
  holdout: z.boolean().optional(),
});

export type CaseFile = z.infer<typeof CaseFileSchema>;

export const TaskSpecSchema = z.object({
  task_summary: z.string().min(1),
  inputs: z.array(z.object({ name: z.string(), description: z.string(), example: z.string() })),
  outputs: z.array(z.object({ name: z.string(), description: z.string(), example: z.string() })),
  success_criteria: z.array(z.string()).min(1).max(7),
  failure_modes: z.array(z.string()).min(1).max(7),
  difficulty_axes: z.array(z.string()).min(1).max(5),
  out_of_scope: z.array(z.string()),
});

export type TaskSpecFile = z.infer<typeof TaskSpecSchema>;
