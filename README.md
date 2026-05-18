# promptc

> A deterministic, LM-free compiler for prompts modelled as an AST/IR.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![npm @promptc/cli](https://img.shields.io/npm/v/@promptc/cli.svg?label=@promptc/cli)](https://www.npmjs.com/package/@promptc/cli)
[![CI](https://github.com/faraa2m/promptc/actions/workflows/ci.yml/badge.svg)](https://github.com/faraa2m/promptc/actions/workflows/ci.yml)

`promptc` parses a prompt into a typed intermediate representation, runs a
fixed-order pipeline of optimization passes — each with stated preconditions,
postconditions, a determinism proof sketch, and a behavior-preservation
argument — and emits the optimized prompt back into the chosen surface format.

The compile path **never calls a language model**. Same input bytes + same
compiler version = same output bytes. Behavior preservation is empirically
validated via the [routerlab](https://github.com/faraa2m/routerlab) eval
harness on crisp tasks (classification, extractive QA) using paired
statistical-equivalence tests.

## Quick demo

Save this to `prompt.md`:

```markdown
# Task

Summarize the input passage in one sentence. In order to keep the summary tight, due to the fact that brevity matters, prior to writing, take into account the main topic.
```

Run:

```bash
promptc optimize --target=cost --in prompt.md
```

Output (stdout):

```markdown
## Task

Summarize the input passage in one sentence. To keep the summary tight, because brevity matters, before writing, consider the main topic.
```

Summary (stderr):

```
pass whitespace_redundancy_strip  applied -2 tok
pass vocab_simplification         applied -4 tok
tokens: 32 -> 23  (-9, -28.1%)
bytes:  179 -> 147
```

Five more runnable prompts in [`examples/`](./examples/), one per pass.

## Install

```bash
# Global:
bun add -g @promptc/cli

# Per-project dev dependency:
bun add -D @promptc/cli

# Or run without installing:
bunx @promptc/cli --help
```

The CLI has no runtime dependencies beyond Bun >=1.1 and the `@promptc/*`
workspace packages.

## Documentation

- [**Quickstart**](./docs/QUICKSTART.md) — 5-minute tutorial, install through
  first optimized prompt.
- [**Adoption**](./docs/ADOPTION.md) — CI, build-step, and team rollout
  patterns for prompt repositories.
- [**Benchmarks**](./docs/BENCHMARKS.md) — before/after examples with token
  savings and behavior-preservation checks.
- [**Passes**](./docs/PASSES.md) — per-pass deep dive: preconditions,
  postconditions, behavior-preservation argument, when to disable.
- [**IR**](./docs/IR.md) — the typed `PromptIR` for library consumers.
- [**Comparisons**](./docs/COMPARISONS.md) — placement vs SAMMO, DSPy,
  LLMLingua, ctxray; the 2x2 of deterministic-vs-stochastic and
  LM-free-vs-LM-in-the-loop.
- [**Design**](./DESIGN.md) — the full design contract: IR types, pass
  framework, eval methodology, non-goals.
- [**Examples**](./examples/) — five runnable prompts, one per pass.

## Optimization passes (default pipeline)

1. **`dead_instruction_elimination`** — drop instructions not referenced by
   the output schema, retained examples, or other retained instructions.
2. **`example_pruning_by_mutual_info`** — cluster few-shot examples by
   pairwise Jaccard input-side similarity; keep one representative per
   cluster.
3. **`format_collapse`** — collapse verbose markdown/XML formatting where
   provably whitespace-insensitive.
4. **`whitespace_redundancy_strip`** — trim trailing whitespace, collapse
   blank-line runs, strip filler openers. Fence-aware.
5. **`vocab_simplification`** — rewrite verbose phrases to short
   equivalents from a curated, versioned map.

Each pass declares preconditions. If unmet, the pass is skipped and logged
in `metadata.passLog`. **No pass ever runs an LLM.**

```bash
# List passes:
promptc passes

# Dry-run a single pass:
promptc explain --in prompt.md --pass=vocab_simplification

# Run a specific subset, in order:
promptc optimize --target=cost \
  --passes=dead_instruction_elimination,whitespace_redundancy_strip \
  --in prompt.md
```

## Why deterministic

Prompt optimization that calls an LM at compile time has three structural
problems in production systems: it pays the run-time price at compile time,
turns compile latency into minutes, and breaks reproducibility (same input
compiles to different output). `promptc` preserves the engineering posture
every other compiler enjoys: same source bytes + same compiler version =
same artifact. The IR, the passes, the eval methodology — everything is in
service of that property.

## What `promptc` is **not**

- **Not a prompt-compression library.** LLMLingua / LongLLMLingua /
  LLMLingua-2 own that niche; their best regime is long contexts and their
  mechanism is learned scoring. `promptc` never frames itself as
  compression — cost reduction is a byproduct of structural simplification.
- **Not a prompt-search system.** SAMMO / EvoPrompt / AutoPrompt / APO /
  APE / OPRO own search. `promptc` has no search loop, no candidate
  evaluation, no iterative refinement.
- **Not an LM-in-the-loop optimizer.** DSPy / MIPRO / OpenAI Prompt
  Optimizer / MLflow Prompt Optimization / PRewrite / TextGrad own that
  posture. `promptc`'s compile path is provably LM-free.
- **Not a soft-prompt or weight-tuning framework.** AutoCompressors and
  continuous-prefix-tuning methods operate on model internals. `promptc`
  never touches weights, embeddings, or continuous vectors.
- **Not a prompt-versioning ops platform.** Agenta / LangSmith / Promptfoo
  / Helicone do prompt versioning + observability. `promptc` is a
  transformation library that composes underneath those platforms.
- **Not a multi-call agent orchestration framework.** LangGraph / LangChain
  agents / CrewAI / AutoGen / SAMMO operate at the program-graph layer.
  `promptc` operates over one prompt at a time.

See [`docs/COMPARISONS.md`](./docs/COMPARISONS.md) for the 2x2 placement.

## Status

Early / pre-release. The IR, parsers, passes, and CLI are functional and
tested but should be considered v0.x. Expect breaking changes until v0.1.0.
Packages are published under the `@promptc/*` npm scope; this repo's docs and
examples describe how to adopt those published packages without requiring a
source checkout.

## Reproducing benchmarks

```bash
bun install
bun test                  # unit + integration tests
bun run eval:regression   # paired-bootstrap behavior-preservation harness
```

## Citation

```bibtex
@misc{promptc-2026,
  author       = {Faraazuddin Mohammed},
  title        = {{promptc}: A Compiler for Cost-Aware Prompt Optimization},
  year         = {2026},
  howpublished = {\url{https://github.com/faraa2m/promptc}}
}
```

## License

[Apache-2.0](./LICENSE)
