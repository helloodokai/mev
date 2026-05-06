import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  Provider,
  ProviderId,
} from "../types/index.js";
import { type AuthConfig, computeCost, resolveAuth } from "./utils.js";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5": { input: 0.001, output: 0.005 },
  "claude-opus-4": { input: 0.015, output: 0.075 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4": 200_000,
};

export class AnthropicProvider implements Provider {
  readonly id: ProviderId = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    const authConfig: AuthConfig = {};
    if (apiKey !== undefined) authConfig.anthropicApiKey = apiKey;
    const key = resolveAuth("anthropic", authConfig);
    if (!key) {
      throw new Error("Anthropic API key not found. Set ANTHROPIC_API_KEY or pass via CLI.");
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async list(): Promise<ModelInfo[]> {
    return Object.entries(PRICING).map(([model, pricing]) => ({
      id: model,
      alias: model,
      provider: "anthropic" as ProviderId,
      contextWindow: CONTEXT_WINDOWS[model] ?? 200_000,
      inputCostPer1k: pricing.input,
      outputCostPer1k: pricing.output,
      supportsStructuredOutput: true,
    }));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const start = performance.now();

    const toolSchema = req.responseSchema
      ? {
          name: "structured_output",
          description: "Respond with structured output",
          input_schema: zodToJsonSchema(req.responseSchema) as Anthropic.Tool.InputSchema,
        }
      : undefined;

    const params: Anthropic.MessageCreateParams = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.systemPrompt,
      messages: [{ role: "user" as const, content: req.userPrompt }],
      temperature: req.temperature,
      stream: false,
    };

    if (req.stopSequences) {
      params.stop_sequences = req.stopSequences;
    }
    if (toolSchema) {
      params.tools = [toolSchema];
      params.tool_choice = { type: "tool" as const, name: "structured_output" };
    }

    const resp = await this.client.messages.create(params);
    const latencyMs = performance.now() - start;

    let text: string;
    let finishReason: CompletionResponse["finishReason"] = "stop";

    if (toolSchema && resp.content[0]?.type === "tool_use") {
      const toolUse = resp.content[0] as Anthropic.ToolUseBlock;
      text = JSON.stringify(toolUse.input);
      finishReason = "tool_use";
    } else {
      text = resp.content
        .filter(
          (block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === "text",
        )
        .map((block: Anthropic.TextBlock) => block.text)
        .join("\n");
      finishReason =
        resp.stop_reason === "end_turn"
          ? "stop"
          : resp.stop_reason === "max_tokens"
            ? "length"
            : "other";
    }

    const pricing = PRICING[req.model] ?? { input: 0.003, output: 0.015 };
    const costUsd = computeCost(resp.usage.input_tokens, resp.usage.output_tokens, pricing);

    return {
      text,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      latencyMs,
      costUsd,
      finishReason,
      raw: resp,
    };
  }
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return zodToJsonSchemaImpl(schema);
}

function zodToJsonSchemaImpl(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToJsonSchemaImpl(value as z.ZodType);
    }
    return {
      type: "object" as const,
      properties,
      required: Object.keys(schema.shape),
    };
  }
  if (schema instanceof z.ZodString) return { type: "string" as const };
  if (schema instanceof z.ZodNumber) return { type: "number" as const };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" as const };
  if (schema instanceof z.ZodArray)
    return { type: "array" as const, items: zodToJsonSchemaImpl(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string" as const, enum: schema.options };
  return {};
}
