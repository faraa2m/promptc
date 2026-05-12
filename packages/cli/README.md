# `@promptc/cli`

The `promptc` command — a deterministic, LM-free compiler for prompts.

`promptc` parses a prompt in Markdown, XML, or plain text, runs a fixed
sequence of optimization passes over the resulting IR, and emits the
optimized prompt back into the chosen surface format. The compile path
never calls a language model, never consults a learned model, and
produces bit-for-bit reproducible output for any fixed input.

Reader-facing docs:

- [Quickstart](../../docs/QUICKSTART.md) — 5-minute tutorial.
- [Passes](../../docs/PASSES.md) — per-pass preconditions, postconditions,
  behavior-preservation arguments.
- [IR](../../docs/IR.md) — the typed `PromptIR` for library consumers.
- [Comparisons](../../docs/COMPARISONS.md) — placement vs SAMMO, DSPy,
  LLMLingua, ctxray.
- [`DESIGN.md`](../../DESIGN.md) — the full design contract.
- [`examples/`](../../examples/) — five runnable prompts, one per pass.

## Install

> **Runtime**: `@promptc/cli` requires [Bun](https://bun.sh) (>= 1.1.0). The
> binary's shebang is `#!/usr/bin/env bun` and the implementation uses
> `Bun.file()` / `Bun.write()` for input/output. Node.js is not supported as
> the CLI runtime; the library packages (`@promptc/ir`, `@promptc/parser`,
> `@promptc/passes`, `@promptc/codegen`) are runtime-agnostic and work on
> both.

```bash
bun add -D @promptc/cli
```

Or run with `bunx` (no install):

```bash
bunx @promptc/cli optimize --target=cost --in prompt.md
```

## Subcommands

### `optimize` — run the full pass pipeline

```bash
promptc optimize --target=cost --in prompt.md --out prompt.opt.md
```

Flags:

| flag | values | default | meaning |
|---|---|---|---|
| `--target` | `cost`, `tokens`, `none` | `cost` | optimization profile |
| `--in <path>` | path to input file | stdin | input prompt source |
| `--out <path>` | path to output file | stdout | optimized prompt destination |
| `--from <fmt>` | `markdown`, `xml`, `plain` | inferred | source surface format |
| `--to <fmt>` | `markdown`, `xml`, `plain` | same as `--from` | target surface format |
| `--passes a,b,c` | comma-separated pass names | full pipeline | explicit pass order |
| `--max-mutations <n>` | integer | unlimited | hard cap on node mutations |

Examples:

```bash
# Optimize a markdown prompt, write back to markdown:
promptc optimize --target=cost --in prompt.md --out prompt.opt.md

# Optimize and convert from markdown to XML:
promptc optimize --target=cost --in prompt.md --to=xml --out prompt.opt.xml

# Streaming via stdin/stdout:
cat prompt.md | promptc optimize --target=cost --from=markdown > prompt.opt.md

# Run only specific passes, in this order:
promptc optimize --target=cost \
  --passes=dead_instruction_elimination,whitespace_redundancy_strip \
  --in prompt.md
```

A per-pass summary is printed to stderr so it does not interfere with the
optimized prompt on stdout:

```
promptc optimize: markdown -> markdown  (target=cost)
  pass dead_instruction_elimination         skipped (no-op)  [no dead instructions found]
  pass example_pruning_by_mutual_info       skipped (no-op)  [no redundant examples above threshold]
  pass format_collapse                      skipped (no-op)  [no candidate rewrite produced a strictly shorter equivalent]
  pass whitespace_redundancy_strip          applied -11 tok
  pass vocab_simplification                 skipped (no-op)  [no verbose phrases matched]
tokens: 141 -> 130  (-11, -7.8%)
bytes:  860 -> 829
```

### `parse` — print the IR for a prompt

```bash
promptc parse --in prompt.md
promptc parse --in prompt.md --pretty   # (default)
promptc parse --in prompt.md --no-pretty
```

Prints the typed `PromptIR` as JSON on stdout. Useful for diffing,
snapshotting, or piping into downstream tools.

### `passes` — list available passes

```bash
promptc passes
```

```
dead_instruction_elimination              Drop instructions not referenced by output schema, examples, or peers.
example_pruning_by_mutual_info            Drop few-shot examples redundant by token-overlap with retained peers.
format_collapse                           Collapse verbose markdown/XML formatting where whitespace-insensitive.
whitespace_redundancy_strip               Trim trailing whitespace, collapse blank-line runs, strip filler openers.
vocab_simplification                      Rewrite verbose phrases to short equivalents from a curated map.
```

### `explain` — dry-run a single pass

```bash
promptc explain --in prompt.md --pass=whitespace_redundancy_strip
```

Outputs the pass's description, precondition status, and a dry-run result
(no IR or file is modified). Useful for understanding *why* a pass did or
did not fire on a given prompt:

```
# Pass: whitespace_redundancy_strip

Description: Trim trailing whitespace, collapse blank-line runs, strip filler openers.

Preconditions: ok

Dry-run result:
  applied: true
  droppedTokens (approx): 11
  debug:
    sectionsChanged: 4
    instructionsChanged: 0
    bytesSaved: 11
```

### `version`

```bash
promptc version
```

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | input error (bad flags, missing file, unreadable bytes, bad subcommand) |
| 2 | IR validation error (parsed IR or post-pass IR violates an invariant) |
| 3 | explicitly-requested pass failed preconditions or is not implemented |

`stdout` carries the optimized prompt (or IR JSON for `parse`, or help text
otherwise). `stderr` carries summaries, diagnostics, and error messages.
This split makes the CLI safe to compose in shell pipelines.

## Determinism

Same input bytes + same pass selection + same compiler version produces the
same output bytes. The pipeline does not call any LM, does not consult any
trained model, does not read the clock or any RNG state, and only reads
input from the path or stdin the user supplied.
