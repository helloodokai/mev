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
});
