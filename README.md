<p align="center">
  <img src="mev-logo.png" alt="mev logo" width="200">
</p>

<h1 align="center">Mev</h1>

Mev is an intent-driven prompt-optimization engine. You describe what you want an LLM agent to do in plain English; Mev compiles that into a task specification, synthesizes an evaluation dataset, evolves a system prompt across generations, and selects the best prompt–model pair — all while measuring real latency, cost, and score.

## How it works

1. **Compile intent** (`mev init` → `mev.toml`)  
   Write a paragraph describing the agent. Mev turns it into a structured task spec with success criteria, failure modes, and difficulty axes.

2. **Synthesize cases**  
   Automatically generates an evaluation dataset (test inputs + reference outputs + rubric) tuned to your spec. Cases pass through critic gating for quality.

3. **Run baseline + evolve**  
   Executes each prompt against the model, judges the **real output** (not the prompt text), and mutates the prompt using a reflector + editor loop. Each child is scored on the full case set. Evolves from actual failure cases and stops early on plateaus.

4. **Pareto sweep & lock-in**  
   Sweeps the best evolved prompts against all configured models. Computes a Pareto frontier across real score, cost, and latency metrics, then locks in the knee-point winner.

5. **Resume after interruption**  
   Every phase writes a `checkpoint.json`. Run with `--resume` to pick up where you left off.

## Quick start

### Requirements

- [Bun](https://bun.sh)
- Ollama running locally (or API keys for Anthropic / OpenAI / Ollama Cloud)

### Install dependencies

```bash
bun install
```

### Initialize a project

```bash
bun run src/cli.ts init
```

This creates `mev.toml`, plus `prompts/`, `cases/`, and `runs/` directories.

### Configure a local model

Edit `mev.toml` to use your local Ollama model:

```toml
[[models]]
alias = "gemma4"
provider = "ollama-local"
model = "gemma4:e4b"

[judge]
provider = "ollama-local"
model = "gemma4:e4b"

[synthesizer]
provider = "ollama-local"
model = "gemma4:e4b"

[critic]
provider = "ollama-local"
model = "gemma4:e4b"
```

### Run optimization

```bash
bun run src/cli.ts optimize --yes
```

### Resume a run

If the process is interrupted, resume the latest run:

```bash
bun run src/cli.ts optimize --yes --resume
```

### Regression test

Re-run the locked-in prompt against the saved case library:

```bash
bun run src/cli.ts regress --threshold 1.0
```

## CLI

| Command | Description |
|---------|-------------|
| `mev init` | Create a new project interactively |
| `mev optimize` | Run the full optimization pipeline |
| `mev optimize --resume` | Resume the latest interrupted run |
| `mev regress` | Regression test the locked prompt |
| `mev models` | List available models |
| `mev diff <runA> <runB>` | Compare two runs |
| `mev report <run>` | Print the HTML report for a run |

## Project output

After a successful run you will have:

```
mev.toml               # updated config with locked-in model
prompts/locked.md      # the winning system prompt
cases/                 # synthesized evaluation cases
runs/<timestamp>/      # artifacts:
  checkpoint.json      # resume state
  baseline.jsonl       # baseline scores
  evolution.ndjson     # generational history
  sweep.jsonl          # prompt × model sweep
  pareto.json          # Pareto frontier
  report.html          # human-readable report
  SUMMARY.md           # run summary
```

## Architecture

- `src/cli.ts` – CLI entrypoint (Clipanion)
- `src/phase/optimize.ts` – main pipeline with resume support
- `src/phase/synthesize.ts` – case generation with critic gating
- `src/judge/index.ts` – absolute and pairwise judging (executes prompts first)
- `src/evolve/index.ts` – prompt reflection + mutation with real scoring
- `src/evolve/archive.ts` – Pareto frontier tracking
- `src/phase/run-dir.ts` – checkpointing, file I/O with locking
- `src/provider/` – provider wrappers (Anthropic, OpenAI, Ollama local/cloud)

## Running tests

```bash
bun test
```

62 tests cover:
- Pareto archive logic
- Checkpoint round-trips and resume
- Real execution-before-judging
- Escalation triggers
- Provider utils

## License

MIT
