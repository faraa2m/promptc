# Example: `verbose` — `vocab_simplification` demo

This prompt is stuffed with verbose phrases that the `vocab_simplification`
pass rewrites to shorter, semantically-equivalent forms from its curated map
(`packages/passes/src/vocab_table.json`).

## Run

```bash
promptc optimize --target=cost --in examples/verbose/prompt.md
```

## Expected reduction

| metric | before | after | delta |
|---|---|---|---|
| tokens (whitespace proxy) | 101 | 85 | **-16 (-15.8%)** |
| bytes | 599 | 537 | **-62** |

## What fires

- `vocab_simplification` applied — rewrites `in order to` -> `to`,
  `due to the fact that` -> `because`, `prior to` -> `before`,
  `take into account` -> `consider`, `in the event that` -> `if`,
  `make use of` -> `use`, `with regard to` -> `about`.
- `whitespace_redundancy_strip` applied — collapses blank-line runs that the
  vocab rewrite leaves behind plus normalizes trailing whitespace.

Other passes do not fire (no instructions, no redundant examples, no
collapsible format).

## Isolate the pass

```bash
promptc optimize --target=cost \
  --passes=vocab_simplification \
  --in examples/verbose/prompt.md
```

This skips the rest of the pipeline so you can see the vocab rewrite alone.

## Inspect the dry-run

```bash
promptc explain --in examples/verbose/prompt.md --pass=vocab_simplification
```

The dry-run prints each replacement the pass would make, along with the
SHA-256 of the vocab table it loaded (for reproducibility).
