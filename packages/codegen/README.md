# `@promptc/codegen`

The back end of the [promptc](https://github.com/faraa2m/promptc) compiler
— emits a surface-format string (markdown / XML / plain) from a typed
`PromptIR` defined in [`@promptc/ir`](https://www.npmjs.com/package/@promptc/ir).

Pairs with [`@promptc/parser`](https://www.npmjs.com/package/@promptc/parser)
to complete the IR round-trip:

```
source  ──parse──▶  PromptIR  ──passes──▶  PromptIR'  ──codegen──▶  source'
```

## Install

```bash
bun add @promptc/codegen
# or
npm install @promptc/codegen
```

## Quick API

```ts
import { codegen, toMarkdown, toXml, toPlain } from "@promptc/codegen";
import type { PromptIR } from "@promptc/ir";

declare const ir: PromptIR;

// Format-routed:
const md = codegen(ir, { to: "markdown" });
const xml = codegen(ir, { to: "xml" });
const plain = codegen(ir, { to: "plain" });

// Direct:
const md2 = toMarkdown(ir);
const xml2 = toXml(ir, { trailingNewline: false });
const plain2 = toPlain(ir);
```

All entry points are pure functions of the IR argument: same IR + same
options + same compiler version produces the same output bytes,
bit-for-bit.

## What's in here

- **`codegen`** — top-level entry that dispatches by `opts.to`.
- **`toMarkdown`** — markdown emitter (`# Headings`, fenced blocks,
  bulleted instructions).
- **`toXml`** — XML emitter (`<task>`, `<context>`, `<example>`, etc.).
- **`toPlain`** — minimal plain-text emitter.

## Round-trip property

For any IR produced by `@promptc/parser`, `parse(codegen(ir, { to: fmt }), { format: fmt })`
yields an IR semantically equivalent to `ir` (modulo whitespace
normalization documented in
[`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md) §5).

## Links

- Main repo: [`promptc`](https://github.com/faraa2m/promptc)
- Design contract: [`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md)
- IR reference: [`docs/IR.md`](https://github.com/faraa2m/promptc/blob/main/docs/IR.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
