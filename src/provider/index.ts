export { AnthropicProvider } from "./anthropic.js";
export { OpenAIProvider } from "./openai.js";
export { OllamaLocalProvider } from "./ollama-local.js";
export { OllamaCloudProvider } from "./ollama-cloud.js";
export { resolveAuth, redactKey, sha256, computeCost } from "./utils.js";

import type { Provider, ProviderId } from "../types/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaCloudProvider } from "./ollama-cloud.js";
import { OllamaLocalProvider } from "./ollama-local.js";
import { OpenAIProvider } from "./openai.js";

export function createProvider(
  id: ProviderId,
  opts?: { apiKey?: string; host?: string },
): Provider {
  switch (id) {
    case "anthropic":
      return new AnthropicProvider(opts?.apiKey);
    case "openai":
      return new OpenAIProvider(opts?.apiKey);
    case "ollama-cloud":
      return new OllamaCloudProvider(opts?.apiKey);
    case "ollama-local":
      return new OllamaLocalProvider(opts?.host);
  }
}
