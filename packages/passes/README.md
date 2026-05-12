# `@promptc/passes`

The optimization-pass library for the [promptc](https://github.com/faraa2m/promptc)
compiler. Each pass is deterministic, LM-free, and operates on the typed
`PromptIR` defined in [`@promptc/ir`](https://www.npmjs.com/package/@promptc/ir).

## Install

```bash
bun add @promptc/passes
# or
npm install @promptc/passes
```

## Passes

| name | what it does |
|---|---|
| `dead_instruction_elimination` | Drop instructions not referenced by output schema, examples, or peers. |
| `example_pruning_by_mutual_info` | Drop few-shot examples redundant by token overlap with retained peers. |
| `format_collapse` | Collapse verbose markdown/XML formatting where whitespace-insensitive. |
| `whitespace_redundancy_strip` | Trim trailing whitespace, collapse blank-line runs, strip filler openers. |
| `vocab_simplification` | Rewrite verbose phrases to short equivalents from a curated map. |

Per-pass preconditions, postconditions, behavior-preservation arguments,
and determinism proof sketches live in
[`docs/PASSES.md`](https://github.com/faraa2m/promptc/blob/main/docs/PASSES.md)
and [`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md) §4.

## Quick API

```ts
import {
  deadInstructionElimination,
  examplePruningByMutualInfo,
  formatCollapse,
  whitespaceRedundancyStrip,
  vocabSimplification,
  type Pass,
  type PassResult,
} from "@promptc/passes";
import { buildPromptIR } from "@promptc/ir";

const ir = buildPromptIR({ sourceFormat: "markdown" });

// Run a single pass:
const result: PassResult = whitespaceRedundancyStrip(ir, { target: "cost" });
if (result.applied) {
  console.log("dropped tokens (approx):", result.droppedTokens);
  // result.ir is the post-pass IR
}
```

Each pass has the shape:

```ts
type Pass = (ir: PromptIR, opts: PassOptions) => PassResult;

type PassResult = {
  applied: boolean;
  ir: PromptIR;
  droppedTokens?: number;
  debug?: Record<string, unknown>;
  reason?: string;            // if applied === false
};
```

Passes can also be imported individually for tree-shaking:

```ts
import { whitespaceRedundancyStrip } from "@promptc/passes/whitespace_redundancy";
```

## Determinism

Every pass is a pure function of its IR + options. No I/O, no clock, no
RNG, no LM calls. Same IR + same options + same compiler version produces
the same post-pass IR, bit-for-bit.

## Links

- Main repo: [`promptc`](https://github.com/faraa2m/promptc)
- Design contract: [`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md)
- Per-pass docs: [`docs/PASSES.md`](https://github.com/faraa2m/promptc/blob/main/docs/PASSES.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
