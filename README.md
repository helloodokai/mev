<p align="center">
  <img src="mev-logo.png" alt="mev logo" width="200">
</p>

<h1 align="center">Mev</h1>

<p align="center"><strong>Get genuinely better prompts. Not just different ones.</strong></p>

Mev is an intent-driven prompt-optimization engine that goes beyond what most prompt-tuning tools do. You describe what you want an LLM agent to do in plain English; Mev compiles that into a task spec, synthesizes a stratified evaluation dataset, evolves prompts through a *beam search with crossover*, scores everything against a *held-out generalization set*, and locks in the prompt that wins on real metrics — score, cost, latency, and consistency.

## What makes Mev different

Most prompt optimizers do one of two things: a) hill-climb on a single prompt with a single judge, or b) ask GPT-4 to "improve this prompt" in a loop. Both overfit to whatever evaluation cases you have, give you noisy rankings, and stop improving fast.

Mev brings the rigor of modern ML evaluation to prompt engineering:

| Feature | Most tools | Mev |
|---|---|---|
| **Train/test split** | Same cases for evolution and final score | 70/30 stratified split — final score is on cases the optimizer *never saw* |
| **Search strategy** | Single-parent greedy | Beam search (top-K diverse) + crossover between parents |
| **Judge reliability** | One sample per case | Self-consistency (median of N) with variance-attenuated confidence |
| **Few-shot examples** | Hand-written or none | Bootstrapped from the prompt's strongest cases automatically |
| **Final inference** | One pass | Best-of-N for lock-in (configurable) |
| **Selection criterion** | Train score | Holdout score + score variance + cost + latency (true Pareto) |
| **Plateau handling** | Stop or keep flailing | Detects via score-band, terminates early to save budget |

Each of these is a known win in the literature (DSPy MIPROv2, OPRO, PromptBreeder, self-consistency). Mev is the first engine to put them all in one no-config pipeline.

## How it works

1. **Compile intent** (`mev init` → `mev.toml`)
   Write a paragraph describing the agent. Mev turns it into a structured task spec with success criteria, failure modes, and difficulty axes.

2. **Synthesize cases** with critic gating, then **stratified train/test split**
   Generates evaluation inputs + reference outputs + rubrics, gates them through a critic, dedupes them, then splits into a *train* set (used during evolution) and a *holdout* set (locked away until final scoring).

3. **Run baseline + evolve**
   Scores the starter prompt on train cases. Then runs beam search: each generation, the top-K most diverse high-scorers spawn children via reflector→editor mutation **or** a crossover that synthesizes a new prompt from two parents. Children inherit bootstrapped few-shot examples from their parent's strongest cases.

4. **Pareto sweep on holdout**
   The top candidates are re-scored on the held-out generalization set with self-consistency judging (median of N samples) and optional best-of-N inference. The winner is the prompt that scores best on cases it never trained against.

5. **Lock-in & report**
   Writes the winning prompt to `prompts/locked.md` with full provenance (train score, holdout score, variance, latency, cost). Generates a rich HTML report showing the Pareto frontier, the evolution timeline (with mutation/crossover labels), and any escalations.

6. **Resume after interruption**
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

Edit `mev.toml`:

```toml
[[models]]
alias = "qwen-coder"
provider = "ollama-local"
model = "qwen2.5-coder:32b-instruct-q4_K_M"

[judge]
provider = "ollama-local"
model = "gemma4:e4b"

[synthesizer]
provider = "ollama-local"
model = "gemma4:e4b"

[critic]
provider = "ollama-local"
model = "gemma4:e4b"

[optimization]
holdout_fraction = 0.3   # 30% of cases held out for generalization scoring
beam_width = 3            # top-3 diverse beam each generation
judge_samples = 3         # 3-sample self-consistency for judge (recommended for serious runs)
crossover_rate = 0.3      # 30% of children come from crossover, 70% from mutation
max_examples = 3          # bootstrap up to 3 few-shot examples from strong cases
lockin_best_of_n = 3      # at lock-in, run completion 3x and judge picks the best
```

### Run optimization

```bash
bun run src/cli.ts optimize --yes
```

Output during a run:

```
[A] ✓ Task spec compiled
[B] ✓ 12 / 16 accepted (75%). Filters: 1 schema, 2 dedup, 1 critic, 0 trivial.
[B] ✓ Train/test split: 9 train + 3 holdout (generalization eval).
[Split] train=9 | holdout=3 (held out for generalization)
[C] Running baseline on TRAIN cases...
[C] ✓ Baseline complete (train: 3.42, holdout: 3.50)
[D] Evolving system prompt (beam=3, crossover=0.3, judge_samples=3)...
[E] Evaluating 5 candidates on 3 holdout cases...
[F] Computing Pareto frontier...
[Result] Holdout improvement: 3.50 → 4.67 (+33.4%)
✓ Locked in. Total time: 1923s
```

### Resume a run

```bash
bun run src/cli.ts optimize --yes --resume
```

### Regression test

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

After a successful run:

```
mev.toml                    # updated config with locked-in model first
prompts/locked.md           # the winning system prompt + provenance header
cases/                      # synthesized evaluation cases (with holdout flag)
runs/<timestamp>/           # artifacts:
  checkpoint.json           # resume state
  spec.json                 # compiled task spec
  cases/                    # snapshot of cases used in this run
  baseline.jsonl            # baseline scores (split=train/holdout)
  evolution.ndjson          # generational history (operator: mutate/crossover)
  sweep.jsonl               # train + holdout scores per (prompt, model) pair
  pareto.json               # final Pareto frontier
  report.html               # rich human-readable report
  SUMMARY.md                # markdown summary with headline metrics
```

## Architecture

- `src/cli.ts` — CLI entrypoint (Clipanion)
- `src/phase/optimize.ts` — main pipeline with checkpoint/resume + train/test split
- `src/phase/synthesize.ts` — case generation, critic gating, stratified holdout split
- `src/phase/compile-intent.ts` — Phase A: intent → task spec
- `src/judge/index.ts` — absolute + pairwise judging with self-consistency and best-of-N
- `src/evolve/index.ts` — beam search evolution with mutation + crossover + few-shot bootstrap
- `src/evolve/archive.ts` — Pareto archive + diverse top-K beam selection (MMR)
- `src/escalation/index.ts` — calibration drift, plateau, variance, critic-rejection-rate
- `src/lockin/index.ts` — lock-in writer with full provenance
- `src/reporting/index.ts` — rich HTML reports
- `src/provider/` — provider wrappers (Anthropic, OpenAI, Ollama local/cloud) with timeouts

## Configuration knobs

The `[optimization]` section in `mev.toml` controls the search strategy. Sensible defaults are baked in; turn them up when you need more rigor:

| Knob | Default | When to increase |
|---|---|---|
| `holdout_fraction` | 0.3 | Larger case set → can afford bigger holdout |
| `beam_width` | 3 | Diverse exploration; slower |
| `judge_samples` | 1 | Set to 3+ for noisy judges or close-call decisions |
| `crossover_rate` | 0.3 | More if your beam looks like clones |
| `max_examples` | 3 | Long-context models can handle more |
| `lockin_best_of_n` | 1 | Set to 3-5 for production locked prompts |

## Running tests

```bash
bun test
```

69 tests cover:
- Pareto archive logic + diverse beam selection
- Train/test split helpers and dedup
- Checkpoint round-trips and resume
- Real execution-before-judging
- Escalation triggers (calibration, plateau, rejection rate)
- Provider utils
- Reporting + summary generation

## License

MIT
