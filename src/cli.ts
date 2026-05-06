import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { Cli, Command, Option } from "clipanion";
import { loadConfig, saveConfig } from "./config/loader.js";
import { diffRuns } from "./phase/diff.js";
import { type OptimizeOptions, optimize } from "./phase/optimize.js";
import { regress } from "./phase/regress.js";
import { createProvider } from "./provider/index.js";

class InitCommand extends Command {
  static override paths = [["init"]];

  override async execute() {
    const projectDir = process.cwd();

    const name = await clack.text({
      message: "Project name",
      placeholder: path.basename(projectDir),
    });
    if (typeof name !== "string") return;

    const intent = await clack.text({
      message: "What do you want your agent to do?",
      placeholder: "Describe in one paragraph what the agent should accomplish...",
    });
    if (typeof intent !== "string") return;

    const seedExamplesAnswer = await clack.text({
      message: "Optional: paste 0-3 seed examples (comma-separated, or leave blank)",
      placeholder: "",
    });
    const seedExamples =
      typeof seedExamplesAnswer === "string" && seedExamplesAnswer.trim()
        ? seedExamplesAnswer.split(",").map((s) => s.trim())
        : [];

    const mustBeLocal = await clack.confirm({
      message: "Must models run locally?",
      initialValue: false,
    });

    const config = {
      project: {
        name: typeof name === "string" ? name : path.basename(projectDir),
        intent: typeof intent === "string" ? intent : "",
        seed_examples: seedExamples,
      },
      constraints: {
        max_latency_p95_ms: 5000,
        must_be_local: typeof mustBeLocal === "boolean" ? mustBeLocal : false,
        forbid_data_leakage: false,
      },
      budget: {
        max_usd: 5.0,
        max_minutes: 15,
        generations: 8,
        cases: 40,
      },
      models: [
        { alias: "sonnet", provider: "anthropic" as const, model: "claude-sonnet-4-6" },
        { alias: "gpt5", provider: "openai" as const, model: "gpt-5" },
        {
          alias: "qwen3-coder",
          provider: "ollama-cloud" as const,
          model: "qwen3-coder:480b-cloud",
        },
        { alias: "gpt-oss-20b", provider: "ollama-local" as const, model: "gpt-oss:20b" },
      ],
      judge: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
      synthesizer: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
      critic: { provider: "anthropic" as const, model: "claude-haiku-4-5" },
    };

    await fs.mkdir(path.join(projectDir, "prompts"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "cases"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "runs"), { recursive: true });

    await saveConfig(config, path.join(projectDir, "mev.toml"));

    clack.outro(`Saved to mev.toml. Run \`mev optimize\` to start.`);
  }
}

class OptimizeCommand extends Command {
  static override paths = [["optimize"]];

  config = Option.String("--config", "mev.toml", { description: "Path to mev.toml" });
  yes = Option.Boolean("--yes", false, { description: "Accept all defaults (CI mode)" });
  resume = Option.Boolean("--resume", false, { description: "Resume latest interrupted run" });
  verbose = Option.Boolean("--verbose", false, { description: "Verbose output" });
  budgetUsd = Option.String("--budget-usd", { description: "Override budget max USD" });
  budgetMinutes = Option.String("--budget-min", { description: "Override budget max minutes" });
  noSecondJudge = Option.Boolean("--no-second-judge", false, {
    description: "Disable second judge",
  });
  escalateThreshold = Option.String("--escalate-threshold", "0.3", {
    description: "Min info-gain for escalation",
  });
  reviewCases = Option.Boolean("--review-cases", false, {
    description: "Review cases after Phase B",
  });

  override async execute() {
    const opts: OptimizeOptions = {
      configPath: this.config,
      yes: this.yes,
      resume: this.resume,
      verbose: this.verbose,
      noSecondJudge: this.noSecondJudge,
    };
    if (this.budgetUsd) opts.budgetUsd = Number.parseFloat(this.budgetUsd);
    if (this.budgetMinutes) opts.budgetMinutes = Number.parseInt(this.budgetMinutes, 10);
    await optimize(opts);
  }
}

class RegressCommand extends Command {
  static override paths = [["regress"]];

  config = Option.String("--config", "mev.toml", { description: "Path to mev.toml" });
  threshold = Option.String("--threshold", "1.0", { description: "Regression threshold (points)" });

  override async execute() {
    const result = await regress({
      configPath: this.config,
      threshold: Number.parseFloat(this.threshold),
    });
    process.exit(result.passed ? 0 : 1);
  }
}

class ModelsCommand extends Command {
  static override paths = [["models"]];

  override async execute() {
    try {
      const config = await loadConfig("mev.toml");
      for (const m of config.models) {
        const provider = createProvider(m.provider);
        try {
          const models = await provider.list();
          for (const info of models) {
            console.log(
              `${info.id.padEnd(30)} ${info.provider.padEnd(15)} ctx:${info.contextWindow}`,
            );
          }
        } catch {
          console.log(`${m.model.padEnd(30)} ${m.provider.padEnd(15)} (unavailable)`);
        }
      }
    } catch {
      console.error("No mev.toml found. Run `mev init` first.");
    }
  }
}

class DiffCommand extends Command {
  static override paths = [["diff"]];

  runA = Option.String("<runA>", { description: "First run ID" });
  runB = Option.String("<runB>", { description: "Second run ID" });
  config = Option.String("--config", "mev.toml", { description: "Path to mev.toml" });

  override async execute() {
    const result = await diffRuns(this.runA!, this.runB!, this.config ?? "mev.toml");
    console.log(result);
  }
}

class ReportCommand extends Command {
  static override paths = [["report"]];

  run = Option.String("<run>", { description: "Run ID to report on" });
  config = Option.String("--config", "mev.toml", { description: "Path to mev.toml" });

  override async execute() {
    const configPath = this.config ?? "mev.toml";
    const projectDir = path.dirname(configPath);
    const reportPath = path.join(projectDir, "runs", this.run!, "report.html");
    try {
      const content = await Bun.file(reportPath).text();
      console.log(content);
    } catch {
      console.error(`Report not found at ${reportPath}`);
    }
  }
}

const cli = new Cli({
  binaryName: "mev",
  binaryVersion: "0.1.0",
});

cli.register(InitCommand);
cli.register(OptimizeCommand);
cli.register(RegressCommand);
cli.register(ModelsCommand);
cli.register(DiffCommand);
cli.register(ReportCommand);

cli.runExit(process.argv.slice(2));
