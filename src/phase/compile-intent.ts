import type { CompletionRequest, Provider, TaskSpec, TaskSpecFile } from "../types/index.js";
import { TaskSpecSchema } from "../types/index.js";

const SYSTEM_PROMPT = `You are a task specification compiler. Given a freeform intent paragraph and optional seed examples, produce a structured task specification that can be used to generate an evaluation dataset and optimize prompts.

Output valid JSON matching this exact schema:
{
  "task_summary": "one sentence",
  "inputs": [{"name": "...", "description": "...", "example": "..."}],
  "outputs": [{"name": "...", "description": "...", "example": "..."}],
  "success_criteria": ["bullet1", "bullet2", ...3-7 items],
  "failure_modes": ["bullet1", "bullet2", ...3-7 items],
  "difficulty_axes": ["axis1", "axis2", ...2-5 axes],
  "out_of_scope": ["item1", "item2"]
}`;

const FEW_SHOT_EXAMPLES = `
<intent-example-1>
I want an agent that reviews TypeScript pull requests. It should catch type-safety issues, suggest idiomatic refactors, and flag test gaps. It should not nitpick formatting.
</intent-example-1>

<spec-example-1>
{
  "task_summary": "Review TypeScript pull requests for type-safety, refactoring opportunities, and test coverage gaps while ignoring formatting concerns.",
  "inputs": [{"name": "diff", "description": "A git diff of changed TypeScript files", "example": "diff --git a/src/utils.ts\\n+const x: any = data;"}],
  "outputs": [{"name": "review", "description": "Structured review with issues found, refactoring suggestions, and test gaps", "example": "## Type Safety\\n- Line 42: Unsafe 'as any' cast..."}],
  "success_criteria": [
    "Identifies type-safety violations such as 'as any' casts, implicit any, and missing generics",
    "Suggests idiomatic TypeScript alternatives that preserve API compatibility",
    "Flags missing tests for changed logic paths",
    "Does not comment on formatting, whitespace, or style issues",
    "Prioritizes genuine bugs over style preferences",
    "Provides actionable suggestions rather than just identifying problems"
  ],
  "failure_modes": [
    "Flags formatting or style issues as if they were real problems",
    "Suggests breaking API changes without noting the breaking nature",
    "Misses obvious type-safety violations like 'as any' casts",
    "Provides vague advice like 'consider refactoring' without specifics",
    "Hallucinates issues that don't exist in the provided diff"
  ],
  "difficulty_axes": [
    "type_complexity: simple unions to complex generics with conditional types",
    "refactoring_depth: rename-level to architecture-level suggestions",
    "test_gap_subtlety: obvious missing tests to subtle edge cases"
  ],
  "out_of_scope": [
    "Runtime performance analysis",
    "Dependency vulnerability scanning",
    "Non-TypeScript files"
  ]
}
</spec-example-1>

<intent-example-2>
I want an agent that extracts structured data from medical referral letters into a JSON schema. It should handle abbreviations, missing fields, and never hallucinate data that isn't in the source.
</intent-example-2>

<spec-example-2>
{
  "task_summary": "Extract structured data from medical referral letters into a predefined JSON schema, handling abbreviations and missing fields without hallucination.",
  "inputs": [{"name": "letter_text", "description": "Raw text of a medical referral letter", "example": "Re: Mr J Smith, DOB 12/03/65..."}],
  "outputs": [{"name": "extracted_data", "description": "JSON matching the referral schema with optional null fields", "example": "{\\"patient_name\\": \\"John Smith\\", \\"dob\\": \\"1965-03-12\\"...}"}],
  "success_criteria": [
    "Extracts all present fields with correct values",
    "Marks absent fields as null rather than inventing values",
    "Expands common medical abbreviations correctly",
    "Handles varying date formats and normalizes them",
    "Preserves exact values for names and addresses without modification",
    "Produces valid JSON matching the target schema"
  ],
  "failure_modes": [
    "Hallucinates values for fields not present in the source text",
    "Fails to handle common medical abbreviations",
    "Changes patient names or addresses during extraction",
    "Outputs invalid JSON or wrong schema structure",
    "Reports high confidence on ambiguous extractions",
    "Merges separate fields incorrectly"
  ],
  "difficulty_axes": [
    "abbreviation_density: common abbreviations to rare or ambiguous ones",
    "missing_field_ratio: mostly complete to heavily incomplete letters",
    "format_variation: structured letters to freeform narrative"
  ],
  "out_of_scope": [
    "Clinical decision support",
    "Drug interaction checking",
    "ICD code assignment"
  ]
}
</spec-example-2>`;

export async function compileIntent(
  intent: string,
  seedExamples: ReadonlyArray<string>,
  provider: Provider,
  model: string,
): Promise<{ spec: TaskSpec; specFile: TaskSpecFile }> {
  const userParts: string[] = [FEW_SHOT_EXAMPLES, "", `Now compile this intent:`, "", intent];

  if (seedExamples.length > 0) {
    userParts.push("", "Seed examples from the user (anchor your synthesis to these):");
    seedExamples.forEach((ex, i) => {
      userParts.push(`\n<seed-example-${i + 1}>\n${ex}\n</seed-example-${i + 1}>`);
    });
  }

  const request: CompletionRequest = {
    model,
    provider: provider.id,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userParts.join("\n"),
    temperature: 0,
    maxTokens: 4096,
    responseSchema: TaskSpecSchema,
  };

  const response = await provider.complete(request);

  if (response.finishReason === "error" || !response.text) {
    throw new Error(`Intent compilation failed: ${response.text || "no output"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error(`Intent compilation produced invalid JSON: ${response.text.slice(0, 200)}`);
  }

  const spec = TaskSpecSchema.parse(parsed);
  return {
    spec: {
      taskSummary: spec.task_summary,
      inputs: spec.inputs,
      outputs: spec.outputs,
      successCriteria: spec.success_criteria,
      failureModes: spec.failure_modes,
      difficultyAxes: spec.difficulty_axes,
      outOfScope: spec.out_of_scope,
    },
    specFile: spec,
  };
}
