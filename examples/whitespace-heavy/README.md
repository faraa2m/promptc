# Example: `whitespace-heavy` — `whitespace_redundancy_strip` demo

This prompt is the unmodified output of a "paste from Notion / Google Doc"
workflow — every line carries trailing spaces, and every section is padded
by triple blank lines. The `whitespace_redundancy_strip` pass:

1. Strips trailing whitespace on every line outside fenced code blocks.
2. Collapses runs of 3+ consecutive newlines to 2 (one blank line max).
3. Strips leading + trailing whitespace from each section body.

Fenced code blocks are left byte-for-byte untouched: tokenizers + parsers
rely on their exact whitespace.

## Run

```bash
promptc optimize --target=cost --in examples/whitespace-heavy/prompt.md
```

## Expected reduction

| metric | before | after | delta |
|---|---|---|---|
| tokens (whitespace proxy) | 42 | 42 | 0 |
| bytes | 278 | 232 | **-46 (-16.5%)** |

The whitespace-token count is unchanged because trailing spaces and blank
lines do not produce additional whitespace tokens under the CLI's
proxy. The byte reduction is real: every commercial BPE tokenizer charges
for the trailing-space bytes (multiple cl100k_base / o200k_base / claude
tokens per blank-line run).

## What fires

- `whitespace_redundancy_strip` applied — drops trailing whitespace and
  collapses blank-line runs in every section body and instruction text.

## Isolate the pass

```bash
promptc optimize --target=cost \
  --passes=whitespace_redundancy_strip \
  --in examples/whitespace-heavy/prompt.md
```

## Opt out

If a node should keep its whitespace verbatim (e.g. an inline ASCII diagram,
an indentation-sensitive code snippet outside a fenced block), the parser
can attach `attrs.preserve_whitespace = "true"` to the section. The pass
honours that attribute and skips the node.
