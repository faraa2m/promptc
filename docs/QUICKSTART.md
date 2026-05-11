# Quickstart

A five-minute tour. By the end you will have installed the CLI, run the
optimizer on a verbose prompt, watched each pass fire or skip, and saved an
optimized version to disk.

## 1. Install

`promptc` ships as a Bun-first workspace. Install the CLI globally or per
project:

```bash
# Global (recommended for trying it out):
bun add -g @promptc/cli

# Per-project dev dependency:
bun add -D @promptc/cli

# Or run without installing:
bunx @promptc/cli --help
```

The CLI has no runtime dependencies beyond Bun >=1.1 and the `@promptc/*`
workspace packages.

## 2. Your first prompt

Save this to `prompt.md` (the task body is one long line so the vocab pass
sees each phrase intact — line wrapping in your editor is fine, just make
sure no literal newlines appear inside a sentence):

```markdown
# Role

You are a careful summarization model.

# Task

Summarize the input passage in one sentence. In order to keep the summary tight, due to the fact that brevity matters, prior to writing, take into account the main topic. In the event that the passage has multiple themes, make use of the most central one. With regard to length, stay under twenty words.

# Examples

Example 1
Input: A short article about climate policy.
Output: The article argues for stronger climate policy.

Example 2
Input: A long thread about AI safety research.
Output: The thread surveys current AI safety priorities.
```

## 3. Optimize

```bash
promptc optimize --target=cost --in prompt.md
```

The optimized prompt lands on stdout. The per-pass summary lands on stderr,
which keeps the two streams composable:

```
## Role

You are a careful summarization model.

## Task

Summarize the input passage in one sentence. To keep the summary tight, because brevity matters, before writing, consider the main topic. If the passage has multiple themes, use the most central one. About length, stay under twenty words.

## Examples

Example 1
Input: A short article about climate policy.
Output: The article argues for stronger climate policy.

Example 2
Input: A long thread about AI safety research.
Output: The thread surveys current AI safety priorities.
```

Stderr:

```
promptc optimize: markdown -> markdown  (target=cost)
  pass dead_instruction_elimination         skipped (precondition)  [ir.instructions is empty]
  pass example_pruning_by_mutual_info       skipped (no-op)  [no redundant examples above threshold]
  pass format_collapse                      skipped (precondition)  [no section or output_schema candidate for format collapse]
  pass whitespace_redundancy_strip          applied -8 tok
  pass vocab_simplification                 applied -7 tok
tokens: 101 -> 85  (-16, -15.8%)
bytes:  599 -> 537
```

Two passes fired. The other three correctly recognised that their
preconditions did not hold (no bulleted instruction list, no redundant
few-shot pairs, no schema-bearing or XML-tag bodies) and skipped without
touching the IR.

## 4. Watch each pass fire

The `examples/` directory ships five runnable prompts, one per pass. Cycle
through them to see each pass take its turn:

```bash
# vocab_simplification:
promptc optimize --target=cost --in examples/verbose/prompt.md

# dead_instruction_elimination:
promptc optimize --target=cost --in examples/redundant-instructions/prompt.md

# example_pruning_by_mutual_info:
promptc optimize --target=cost --in examples/duplicate-examples/prompt.md

# format_collapse:
promptc optimize --target=cost --in examples/yaml-output-schema/prompt.md

# whitespace_redundancy_strip:
promptc optimize --target=cost --in examples/whitespace-heavy/prompt.md
```

Each `examples/<name>/README.md` records the expected reduction and the
exact bytes saved.

## 5. Output formats

The CLI parses Markdown, XML, and plain text, and emits any of the three.
By default the output format equals the input format; override with
`--to=`:

```bash
# Markdown -> XML
promptc optimize --target=cost --in prompt.md --to=xml --out prompt.opt.xml

# Markdown -> plain
promptc optimize --target=cost --in prompt.md --to=plain --out prompt.opt.txt
```

Format is inferred from file extension when `--from`/`--to` are not given.
The same `PromptIR` round-trips through all three back-ends, so the same
prompt can be authored in markdown and shipped as XML — for example, to
hand to Anthropic-style XML-flavoured chat templates.

## 6. Inspect a pass before running it

`promptc explain` performs a dry run: it parses your prompt, evaluates a
single pass's preconditions, and (if the pass would run) reports what it
would change — without touching the IR or the file:

```bash
promptc explain --in prompt.md --pass=vocab_simplification
```

```
# Pass: vocab_simplification

Description: Rewrite verbose phrases to short equivalents from a curated map.

Preconditions: ok

Dry-run result:
  applied: true
  droppedTokens (approx): 7
  debug:
    matches: 6
    tableHash: "1f4a2b..."
```

`droppedTokens` and `debug.matches` are useful for benchmarking which
prompts in your codebase benefit most from any given pass.

## 7. Skip or restrict passes

To restrict the pipeline to a specific subset of passes (in order):

```bash
promptc optimize --target=cost \
  --passes=dead_instruction_elimination,whitespace_redundancy_strip \
  --in prompt.md
```

If a pass you explicitly requested cannot run for this prompt (precondition
fail), the CLI exits with code `3` and a clear diagnostic. This is
intentional: in scripts, the difference between "I asked for this pass and
it ran" and "I asked but it silently skipped" is load-bearing.

## 8. Programmatic use

The same compile pipeline is exposed as a library:

```ts
import { parseMarkdown } from "@promptc/parser";
import {
  deadInstructionElimination,
  examplePruningByMutualInfo,
  formatCollapse,
  whitespaceRedundancyStrip,
  vocabSimplification,
} from "@promptc/passes";
import { codegen } from "@promptc/codegen";

const source = await Bun.file("prompt.md").text();
let ir = parseMarkdown(source);

// Run the default pipeline order (DESIGN.md §4).
for (const pass of [
  deadInstructionElimination,
  examplePruningByMutualInfo,
  formatCollapse,
  whitespaceRedundancyStrip,
  vocabSimplification,
]) {
  const result = pass.run(ir);
  if (result.applied) ir = result.ir;
}

const optimized = codegen(ir, { to: "markdown" });
```

## Gotchas

- **The whitespace-token count is a proxy, not a billable count.** The
  authoritative provider-side counts come from
  [`llm-tokens-atlas`](https://github.com/faraa2m/llm-tokens-atlas). When
  the CLI's token figure disagrees with the bytes figure (most visible in
  `format_collapse`), trust the bytes column.
- **The `kind` of each instruction matters.** A bullet starting with
  "must" / "always" / "never" is classified `required` and is never
  dropped by `dead_instruction_elimination`. "Optionally" / "may" /
  "prefer" / "consider" -> `optional`. Anything mentioning format/json/
  yaml/xml/markdown -> `format`. tone/style/voice keywords -> `style`
  (preserved by default). Other bullets default to `required`.
- **Behavior preservation is an empirical claim, not a theorem.** Each
  pass declares a behavior-preservation argument in `DESIGN.md` §4 and is
  validated via the [routerlab](https://github.com/faraa2m/routerlab)
  harness on classification + extractive-QA tasks. Generative tasks (free-
  form summarization, story generation) are explicitly out of scope for
  the v0.x behavior-preservation claim.
- **The compile path never calls a model.** Every pass is a pure function
  of the IR. No clock, no RNG, no network at compile time. Same input
  bytes + same compiler version = same output bytes.

## Next

- [`PASSES.md`](./PASSES.md) — per-pass deep dive (preconditions,
  postconditions, behavior-preservation argument, when to disable).
- [`IR.md`](./IR.md) — the typed `PromptIR` for library consumers.
- [`COMPARISONS.md`](./COMPARISONS.md) — placement vs SAMMO, DSPy,
  LLMLingua, ctxray.
- [`../DESIGN.md`](../DESIGN.md) — the full design contract.
