# `@promptc/ir`

The typed prompt intermediate representation (IR) and core utilities for
[promptc](https://github.com/faraa2m/promptc) — a deterministic, LM-free
compiler for prompts.

This package defines the IR that the rest of the `@promptc/*` toolchain
operates on:

- `@promptc/parser` produces a `PromptIR` from markdown / XML / plain input.
- `@promptc/passes` runs optimization passes against a `PromptIR`.
- `@promptc/codegen` emits a surface-format string from a `PromptIR`.
- `@promptc/cli` wires them together as the `promptc` command.

If you want to write your own passes, custom parsers, or alternative
codegen for the promptc pipeline, this is the package you import.

## Install

```bash
bun add @promptc/ir
# or
npm install @promptc/ir
```

## Quick API

```ts
import {
  buildPromptIR,
  addSection,
  addInstruction,
  validateIR,
  serializeIR,
  deserializeIR,
  type PromptIR,
} from "@promptc/ir";

// Build an IR from scratch.
let ir = buildPromptIR({ sourceFormat: "markdown" });
ir = addSection(ir, { kind: "task", title: "Task" });
ir = addInstruction(ir, { sectionId: /* ... */, kind: "directive", text: "Summarize." });

// Validate it.
const outcome = validateIR(ir);
if (!outcome.valid) throw new Error(outcome.errors[0]?.message);

// Snapshot / restore.
const json = serializeIR(ir);
const round = deserializeIR(json);
```

## What's in here

- **Types** — `PromptIR`, `Section`, `Instruction`, `Example`, `Slot`,
  `OutputSchema`, `Pass`, `PassResult`, etc. (canonical definitions for the
  whole compiler).
- **Builders** — pure, deterministic constructors (`buildPromptIR`,
  `addSection`, `addInstruction`, ...) used by the parser and by tests.
- **Serialize** — JSON snapshot + restore with `IRValidationError`.
- **Validate** — `validateIR(ir)` runs invariant checks (no orphan nodes,
  no duplicate ids, etc.).

## Determinism

Every entry point is a pure function of its inputs — no I/O, no clock, no
RNG. Same inputs in produces same outputs out, bit-for-bit. This is the
foundation of the promptc compile-path determinism guarantee.

## Links

- Main repo: [`promptc`](https://github.com/faraa2m/promptc)
- Design contract: [`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md)
- IR reference docs: [`docs/IR.md`](https://github.com/faraa2m/promptc/blob/main/docs/IR.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
