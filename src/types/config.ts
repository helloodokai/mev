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
