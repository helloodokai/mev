import { describe, expect, it } from "bun:test";
import { judgeAbsolute } from "../../src/judge/index.js";
import type { CompletionResponse, EvalCase, Provider } from "../../src/types/index.js";
import { brandPromptSha } from "../../src/types/index.js";

function makeProvider(
  completeImpl: (req: {
    systemPrompt: string;
    userPrompt: string;
  }) => Promise<CompletionResponse>,
): Provider {
  return {
    id: "ollama-local",
    list: async () => [],
    complete: async (req) => completeImpl(req),
  };
}

function makeEvalCase(id: string, input: string): EvalCase {
  return {
    id,
    generatedAt: new Date().toISOString(),
    difficultyTier: 2,
    evolutions: [],
    tags: [],
    input: { content: input },
    reference: { output: "ref", synthesizerConfidence: 0.9 },
    rubric: { quality: "behavioral anchor" },
  };
}

describe("judgeAbsolute with execution", () => {
  it("executes prompts before judging", async () => {
    const executionCalls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const judgeCalls: Array<{ systemPrompt: string; userPrompt: string }> = [];

    const completionProvider = makeProvider(async (req) => {
      executionCalls.push(req);
      return {
        text: `OUTPUT:${req.userPrompt}`,
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
        costUsd: 0,
        finishReason: "stop",
        raw: {},
      };
    });

    const judgeProvider = makeProvider(async (req) => {
      judgeCalls.push(req);
      return {
        text: JSON.stringify({
          scores: [{ criterion: "quality", score: 4, confidence: 0.9, justification: "ok" }],
          overall_assessment: "good",
        }),
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
        costUsd: 0,
        finishReason: "stop",
        raw: {},
      };
    });

    const cases = [makeEvalCase("c1", "test input")];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(executionCalls.length).toBe(1);
    expect(executionCalls[0]?.systemPrompt).toBe("system prompt");
    expect(executionCalls[0]?.userPrompt).toBe("test input");

    expect(judgeCalls.length).toBe(1);
    expect(judgeCalls[0]?.userPrompt).toContain("OUTPUT:test input");

    expect(results.length).toBe(1);
    expect(results[0]?.meanScore).toBe(4);
    expect(results[0]?.scores[0]?.justification).toBe("ok");
  });

  it("returns score 0 when execution fails", async () => {
    const completionProvider = makeProvider(async () => ({
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "error",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 0, confidence: 0, justification: "no output" }],
        overall_assessment: "bad",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [makeEvalCase("c1", "test input")];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.scores[0]?.score).toBe(0);
  });

  it("caps scores when deterministic validators catch invalid JSON", async () => {
    const completionProvider = makeProvider(async () => ({
      text: "not-json",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 5, confidence: 1, justification: "perfect" }],
        overall_assessment: "great",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [
      {
        ...makeEvalCase("c1", "test input"),
        reference: { output: '{"entities": []}', synthesizerConfidence: 0.9 },
      },
    ];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.meanScore).toBe(1);
    expect(results[0]?.scores[0]?.justification).toContain("auto-validator");
  });

  it("caps scores when JSON output misses required schema fields", async () => {
    const completionProvider = makeProvider(async () => ({
      text: '{"entities": [{"text": "Acme"}]}',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 5, confidence: 1, justification: "perfect" }],
        overall_assessment: "great",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [
      {
        ...makeEvalCase("c1", "test input"),
        reference: {
          output: '{"entities": [{"text": "Acme", "type": "ORG", "start": 0}]}',
          synthesizerConfidence: 0.9,
        },
      },
    ];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.meanScore).toBe(2);
    expect(results[0]?.scores[0]?.justification).toContain("missing expected JSON field");
  });

  it("does not cap scores for missing reference-only alias fields", async () => {
    const completionProvider = makeProvider(async () => ({
      text: '[{"text": "Acme", "type": "ORG", "start": 0}]',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 4, confidence: 1, justification: "good" }],
        overall_assessment: "good",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [
      {
        ...makeEvalCase("c1", "test input"),
        reference: {
          output: '[{"entity": "Acme", "text": "Acme", "type": "ORG", "start": 0, "end": 4}]',
          synthesizerConfidence: 0.9,
        },
      },
    ];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.meanScore).toBe(4);
    expect(results[0]?.scores[0]?.justification).not.toContain("auto-validator");
  });

  it("caps scores when intent parser output violates exact contract", async () => {
    const completionProvider = makeProvider(async () => ({
      text: '{"intentType":"sometimes","scheduleCron":"every monday","requiredCapabilities":["email","slack"],"clarifyingQuestions":[],"domainContext":"reporting","description":"hello","extra":true}',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 5, confidence: 1, justification: "perfect" }],
        overall_assessment: "great",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [
      {
        ...makeEvalCase("c1", "Analyze this request and extract the structured intent."),
        reference: {
          output:
            '{"intentType":"recurring","scheduleCron":"0 9 * * 1-5","requiredCapabilities":["email"],"clarifyingQuestions":[],"domainContext":"reporting","description":"Every weekday at 9am email me a report."}',
          synthesizerConfidence: 0.9,
        },
      },
    ];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.meanScore).toBe(1);
    expect(results[0]?.scores[0]?.justification).toContain("intentType must be one-time or recurring");
    expect(results[0]?.scores[0]?.justification).toContain("valid 5-field cron");
  });

  it("caps scores for quoted single-sentence action responses", async () => {
    const completionProvider = makeProvider(async () => ({
      text: '"Running build_app to inspect the diagnostic."',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const judgeProvider = makeProvider(async () => ({
      text: JSON.stringify({
        scores: [{ criterion: "quality", score: 5, confidence: 1, justification: "perfect" }],
        overall_assessment: "great",
      }),
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      costUsd: null,
      finishReason: "stop",
      raw: {},
    }));

    const cases = [
      {
        ...makeEvalCase(
          "c1",
          "Scenario: Bundle failed. Constraint: For this evaluation, do not call tools. Reply with only the single next sentence you'd say before using tools.",
        ),
        reference: {
          output: "Running build_app to inspect the diagnostic.",
          synthesizerConfidence: 0.9,
        },
      },
    ];
    const results = await judgeAbsolute({
      provider: judgeProvider,
      model: "judge-model",
      cases,
      models: [{ alias: "m1", promptSha: brandPromptSha("sha"), promptText: "system prompt" }],
      caseSetSha: "cs1",
      completionProvider,
      completionModel: "completion-model",
    });

    expect(results[0]?.meanScore).toBe(3);
    expect(results[0]?.scores[0]?.justification).toContain("wrapped in quotes");
  });
});
