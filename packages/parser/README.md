# `@promptc/parser`

The front end of the [promptc](https://github.com/faraa2m/promptc)
compiler — turns markdown, XML, or plain-text prompts into a typed
`PromptIR` (defined in [`@promptc/ir`](https://www.npmjs.com/package/@promptc/ir)).

Every entry point is a pure function of the input string: same bytes in
produces the same IR out. No I/O, no RNG. This is the basis for the
compile path's overall determinism guarantee.

## Install

```bash
bun add @promptc/parser
# or
npm install @promptc/parser
```

## Quick API

```ts
import { parse, parseAuto, parseMarkdown, parseXml, parsePlain } from "@promptc/parser";

// Format-routed:
const ir1 = parse(source, { format: "markdown" });
const ir2 = parse(source, { format: "auto" });

// Direct:
const ir3 = parseMarkdown(source);
const ir4 = parseXml(source);   // throws ParseError on malformed input
const ir5 = parsePlain(source);
```

`parse(source, { format: "auto" })` runs the lightweight format detector
(no LM, no heuristics that depend on locale or environment) and dispatches
to the right per-format parser.

## What's in here

- **`parseMarkdown`** — heading-and-list driven layout, fenced code, simple
  example/output-schema markers.
- **`parseXml`** — `<task>`, `<context>`, `<example>`, etc. tag layout.
  Throws `ParseError` on malformed input.
- **`parsePlain`** — minimal plain-text fallback (one big task section).
- **`parseAuto`** — format detector + dispatch.
- **Errors** — `ParseError` with byte/line/column location info.

## Errors

Malformed XML or invalid plain-text shapes throw `ParseError`, which
carries a `location` field (`{ line, column, byteOffset }`) suitable for
piping into editor diagnostics.

## Links

- Main repo: [`promptc`](https://github.com/faraa2m/promptc)
- Design contract: [`DESIGN.md`](https://github.com/faraa2m/promptc/blob/main/DESIGN.md)
- IR reference: [`docs/IR.md`](https://github.com/faraa2m/promptc/blob/main/docs/IR.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
