import crypto from "node:crypto";
import type { ProviderId } from "../types/index.js";

export interface AuthConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaCloudApiKey?: string;
  ollamaLocalHost?: string;
}

export function resolveAuth(provider: ProviderId, config: AuthConfig): string | null {
  switch (provider) {
    case "anthropic":
      return config.anthropicApiKey ?? process.env["ANTHROPIC_API_KEY"] ?? null;
    case "openai":
      return config.openaiApiKey ?? process.env["OPENAI_API_KEY"] ?? null;
    case "ollama-cloud":
      return (
        config.ollamaCloudApiKey ??
        process.env["OLLAMA_CLOUD_API_KEY"] ??
        process.env["OLLAMA_API_KEY"] ??
        null
      );
    case "ollama-local":
      return null;
  }
}

export function redactKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computeCost(
  inputTokens: number,
  outputTokens: number,
  costPer1k: { input: number; output: number },
): number {
  return (inputTokens * costPer1k.input + outputTokens * costPer1k.output) / 1000;
}
