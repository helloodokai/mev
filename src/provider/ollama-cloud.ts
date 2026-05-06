import { z } from "zod";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  Provider,
  ProviderId,
} from "../types/index.js";
import { type AuthConfig, resolveAuth } from "./utils.js";

const CLOUD_PRICING: Record<string, { input: number; output: number }> = {
  "qwen3-coder:480b-cloud": { input: 0.0015, output: 0.006 },
  "deepseek-v3.1:671b-cloud": { input: 0.001, output: 0.004 },
  "gpt-oss:120b-cloud": { input: 0.0008, output: 0.003 },
};

export class OllamaCloudProvider implements Provider {
  readonly id: ProviderId = "ollama-cloud";
  private host: string;
  private apiKey: string;

  constructor(apiKey?: string) {
    const authConfig: AuthConfig = {};
    if (apiKey !== undefined) authConfig.ollamaCloudApiKey = apiKey;
    const key = resolveAuth("ollama-cloud", authConfig);
    if (!key) {
      throw new Error("Ollama Cloud API key not found. Set OLLAMA_CLOUD_API_KEY or pass via CLI.");
    }
    this.apiKey = key;
    this.host = "https://ollama.com";
  }

  async list(): Promise<ModelInfo[]> {
    return Object.entries(CLOUD_PRICING).map(([model, pricing]) => ({
      id: model,
      alias: model,
      provider: "ollama-cloud" as ProviderId,
      contextWindow: 128_000,
      inputCostPer1k: pricing.input,
      outputCostPer1k: pricing.output,
      supportsStructuredOutput: true,
    }));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const start = performance.now();

    const options: Record<string, unknown> = {
      temperature: req.temperature,
      num_predict: req.maxTokens,
    };

    if (req.minP !== undefined) {
      options["min_p"] = req.minP;
    }

    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.userPrompt,
      system: req.systemPrompt,
      stream: false,
      options,
    };

    if (req.responseSchema && req.responseSchema instanceof z.ZodObject) {
      body["format"] = zodToJsonSchema(req.responseSchema);
    }

    const resp = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: performance.now() - start,
        costUsd: null,
        finishReason: "error",
        raw: { error: errText, status: resp.status },
      };
    }

    const data = (await resp.json()) as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    const latencyMs = performance.now() - start;
    const pricing = CLOUD_PRICING[req.model] ?? { input: 0, output: 0 };
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000;

    return {
      text: data.response ?? "",
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd: pricing.input > 0 ? costUsd : null,
      finishReason: data.done_reason === "length" ? "length" : "stop",
      raw: data,
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
