import OpenAI from "openai";
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
  "gpt-5": { input: 0.005, output: 0.015 },
  "gpt-5-mini": { input: 0.0015, output: 0.006 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5": 128_000,
  "gpt-5-mini": 128_000,
  "gpt-4.1": 128_000,
};

export class OpenAIProvider implements Provider {
  readonly id: ProviderId = "openai";
  private client: OpenAI;

  constructor(apiKey?: string) {
    const authConfig: AuthConfig = {};
    if (apiKey !== undefined) authConfig.openaiApiKey = apiKey;
    const key = resolveAuth("openai", authConfig);
    if (!key) {
      throw new Error("OpenAI API key not found. Set OPENAI_API_KEY or pass via CLI.");
    }
    this.client = new OpenAI({ apiKey: key });
  }

  async list(): Promise<ModelInfo[]> {
    return Object.entries(PRICING).map(([model, pricing]) => ({
      id: model,
      alias: model,
      provider: "openai" as ProviderId,
      contextWindow: CONTEXT_WINDOWS[model] ?? 128_000,
      inputCostPer1k: pricing.input,
      outputCostPer1k: pricing.output,
      supportsStructuredOutput: true,
    }));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const start = performance.now();

    const responseFormat = req.responseSchema
      ? {
          type: "json_schema" as const,
          json_schema: { name: "response", schema: zodToJsonSchema(req.responseSchema) },
        }
      : undefined;

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: req.model,
      messages: [
        { role: "system" as const, content: req.systemPrompt },
        { role: "user" as const, content: req.userPrompt },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: false,
    };
    if (req.stopSequences) params.stop = req.stopSequences;
    if (responseFormat) params.response_format = responseFormat;

    const resp = await this.client.chat.completions.create(params);

    const latencyMs = performance.now() - start;
    const choice = resp.choices[0];

    const pricing = PRICING[req.model] ?? { input: 0.005, output: 0.015 };
    const costUsd = computeCost(
      resp.usage?.prompt_tokens ?? 0,
      resp.usage?.completion_tokens ?? 0,
      pricing,
    );

    const finishReasonMap: Record<string, CompletionResponse["finishReason"]> = {
      stop: "stop",
      length: "length",
      tool_calls: "tool_use",
      content_filter: "other",
    };

    return {
      text: choice?.message?.content ?? "",
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      latencyMs,
      costUsd,
      finishReason: finishReasonMap[choice?.finish_reason ?? "stop"] ?? "other",
      raw: resp,
    };
  }
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType);
    }
    return {
      type: "object",
      properties,
      required: Object.keys(schema.shape),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray)
    return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  return {};
}
