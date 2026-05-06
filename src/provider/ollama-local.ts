import { z } from "zod";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  Provider,
  ProviderId,
} from "../types/index.js";

interface OllamaModel {
  name: string;
  size: number;
  details: { family: string; parameter_size: string; quantization_level: string };
}

export class OllamaLocalProvider implements Provider {
  readonly id: ProviderId = "ollama-local";
  private host: string;

  constructor(host?: string) {
    this.host = host ?? process.env["OLLAMA_LOCAL_HOST"] ?? "http://localhost:11434";
  }

  async list(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(`${this.host}/api/tags`);
      if (!resp.ok) return [];
      const data = (await resp.json()) as { models: OllamaModel[] };
      return (data.models ?? []).map((m) => ({
        id: m.name,
        alias: m.name,
        provider: "ollama-local" as ProviderId,
        contextWindow: 128_000,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        supportsStructuredOutput: true,
      }));
    } catch {
      return [];
    }
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

    if (req.stopSequences && req.stopSequences.length > 0) {
      options["stop"] = req.stopSequences;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: performance.now() - start,
        costUsd: 0,
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

    return {
      text: data.response ?? "",
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      latencyMs,
      costUsd: 0,
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
