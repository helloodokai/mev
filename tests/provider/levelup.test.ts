import { describe, expect, it } from "bun:test";
import { LevelUpWrapper, wrapWithLevelUp } from "../../src/provider/levelup.js";
import type { CompletionRequest, CompletionResponse, Provider } from "../../src/types/core.js";

describe("LevelUpWrapper", () => {
  it("applies level-up for ollama providers", async () => {
    let capturedSystemPrompt = "";
    const mockProvider: Provider = {
      id: "ollama-local",
      async list() {
        return [];
      },
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        capturedSystemPrompt = req.systemPrompt;
        return {
          text: "response",
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 100,
          costUsd: 0,
          finishReason: "stop",
          raw: null,
        };
      },
    };

    const wrapper = new LevelUpWrapper(mockProvider);
    await wrapper.complete({
      model: "test",
      provider: "ollama-local",
      systemPrompt: "You are a reviewer.",
      userPrompt: "Review this code.",
      temperature: 0.5,
      maxTokens: 100,
    });

    expect(capturedSystemPrompt).toContain("You are a reviewer.");
    expect(capturedSystemPrompt).toContain("skilled assistant");
  });

  it("passes through for non-ollama providers unchanged", async () => {
    const mockProvider: Provider = {
      id: "anthropic",
      async list() {
        return [];
      },
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        expect(req.systemPrompt).toBe("You are a reviewer.");
        return {
          text: "response",
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 100,
          costUsd: 0.01,
          finishReason: "stop",
          raw: null,
        };
      },
    };

    const wrapper = new LevelUpWrapper(mockProvider);
    const result = await wrapper.complete({
      model: "test",
      provider: "anthropic",
      systemPrompt: "You are a reviewer.",
      userPrompt: "Review this code.",
      temperature: 0.5,
      maxTokens: 100,
    });
    expect(result.text).toBe("response");
  });
});

describe("wrapWithLevelUp", () => {
  it("creates a LevelUpWrapper", () => {
    const mockProvider: Provider = {
      id: "ollama-local",
      async list() {
        return [];
      },
      async complete() {
        throw new Error("not called");
      },
    };
    const wrapper = wrapWithLevelUp(mockProvider);
    expect(wrapper).toBeInstanceOf(LevelUpWrapper);
  });
});
