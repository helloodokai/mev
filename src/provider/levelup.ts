import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  Provider,
  ProviderId,
} from "../types/index.js";

interface LevelUpConfig {
  systemPromptScaffold: string;
  formatConstraints: string;
  inContextExamples: ReadonlyArray<{ input: string; output: string }>;
  samplingOverrides: {
    temperature: number;
    minP: number;
  };
}

const DEFAULT_SCAFFOLD = `You are a skilled assistant. Follow these rules strictly:
- Respond only with the requested output format
- Be precise and thorough
- If uncertain, say so explicitly rather than guessing
- Do not add commentary outside the requested format`;

export class LevelUpWrapper implements Provider {
  readonly id: ProviderId;
  private inner: Provider;
  private isOllama: boolean;

  constructor(inner: Provider) {
    this.inner = inner;
    this.id = inner.id;
    this.isOllama = inner.id === "ollama-cloud" || inner.id === "ollama-local";
  }

  async list(): Promise<ModelInfo[]> {
    return this.inner.list();
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isOllama) {
      return this.inner.complete(req);
    }

    const config = this.buildLevelUpConfig(req);
    const enhancedRequest = this.applyLevelUp(req, config);
    return this.inner.complete(enhancedRequest);
  }

  private buildLevelUpConfig(req: CompletionRequest): LevelUpConfig {
    const hasSchema = req.responseSchema !== undefined;
    const isCodeOrStructured =
      hasSchema ||
      req.systemPrompt.toLowerCase().includes("json") ||
      req.systemPrompt.toLowerCase().includes("code");

    const temperature = isCodeOrStructured ? 0.0 : 0.2;
    const minP = 0.05;

    const formatConstraints = hasSchema
      ? "You MUST respond with valid JSON matching the specified schema. Do not include any text outside the JSON structure."
      : "";

    const inContextExamples: Array<{ input: string; output: string }> = [];

    return {
      systemPromptScaffold: DEFAULT_SCAFFOLD,
      formatConstraints,
      inContextExamples,
      samplingOverrides: { temperature, minP },
    };
  }

  private applyLevelUp(req: CompletionRequest, config: LevelUpConfig): CompletionRequest {
    const systemParts: string[] = [config.systemPromptScaffold];

    if (req.systemPrompt) {
      systemParts.push("", req.systemPrompt);
    }

    if (config.formatConstraints) {
      systemParts.push("", config.formatConstraints);
    }

    let userPrompt = req.userPrompt;
    if (config.inContextExamples.length > 0) {
      const exampleParts = config.inContextExamples.map(
        (ex, i) => `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}`,
      );
      userPrompt = `${exampleParts.join("\n\n")}\n\n${userPrompt}`;
    }

    return {
      ...req,
      systemPrompt: systemParts.join("\n"),
      userPrompt,
      temperature: config.samplingOverrides.temperature,
      minP: config.samplingOverrides.minP,
    };
  }
}

export function wrapWithLevelUp(provider: Provider): LevelUpWrapper {
  return new LevelUpWrapper(provider);
}
