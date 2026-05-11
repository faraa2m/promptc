# Example: `yaml-output-schema` — `format_collapse` demo

This prompt declares the per-prompt context as inline XML elements
(`<repo>...</repo>`, `<language>...</language>`, ...). The `format_collapse`
pass recognises that, when the target surface format is markdown or plain,
those single-attribute single-text-child XML elements collapse losslessly to
`tag: value` lines — strictly fewer bytes, structurally equivalent under
re-parse.

Three rewrites the pass can perform (DESIGN.md §4.3):

- **R1.** Markdown bullets in `instructions` / `constraints` -> comma-separated
  inline list (bytes saved, but the markdown codegen always re-renders
  instruction nodes as bullets, so the visible reduction here is muted —
  the savings reappear when emitting to plain).
- **R2.** Single-tag XML elements on their own line -> `tag: text` labelled
  lines. This is what this example demonstrates.
- **R3.** YAML flat-scalar `OutputSchema` -> plain `key=type` form. (Not
  reachable through the current Markdown / XML parsers; the parsers do not
  yet populate the typed `OutputSchema` field. The pass is unit-tested
  against synthetic IRs.)

The example is named for R3 — the original target — but in v0.0.1 the
visible demo here is R2.

## Run

```bash
promptc optimize --target=cost --in examples/yaml-output-schema/prompt.md
```

## Expected reduction

| metric | before | after | delta |
|---|---|---|---|
| tokens (whitespace proxy) | 60 | 65 | +5 |
| bytes | 474 | 434 | **-40** |

`format_collapse` reduces *bytes* (which is what every commercial BPE
tokenizer ultimately bills on). The whitespace-token proxy printed by the
CLI counts space-separated words, and `<repo>promptc</repo>` is one
whitespace-token while `repo: promptc` is two. The bytes-saved figure is
the honest signal; the whitespace-token figure is a coarse estimate.

## What fires

- `format_collapse` applied — rewrites every `<tag>text</tag>` line in
  `Context` into `tag: text`. Equivalence is checked structurally: the
  before/after re-parse to the same `{tag, text}` pairs.
- `whitespace_redundancy_strip` applied — trims the blank-line runs.

## Isolate the pass

```bash
promptc optimize --target=cost \
  --passes=format_collapse \
  --in examples/yaml-output-schema/prompt.md
```

## When the pass skips

If `--to=xml` is requested, R2 always skips: the user wants XML, so the pass
respects that. R1 skips when bullet items contain commas (would corrupt the
inline-list separator). R3 skips when the schema has nested objects or
arrays. See `promptc explain` for the per-skip reason.
