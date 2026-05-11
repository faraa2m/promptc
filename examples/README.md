# Examples

Five runnable example prompts, one per optimization pass. Each example has
its own `README.md` with the expected reduction and the exact command to run.

| directory | demonstrates | tokens (before -> after) | bytes (before -> after) |
|---|---|---|---|
| [`verbose/`](./verbose/) | `vocab_simplification` | 101 -> 85 (-15.8%) | 599 -> 537 |
| [`redundant-instructions/`](./redundant-instructions/) | `dead_instruction_elimination` | 152 -> 131 (-13.8%) | 966 -> 822 |
| [`duplicate-examples/`](./duplicate-examples/) | `example_pruning_by_mutual_info` | 123 -> 85 (-30.9%) | 734 -> 528 |
| [`yaml-output-schema/`](./yaml-output-schema/) | `format_collapse` | 60 -> 65 (+8.3%) | 474 -> 434 (-8.4%) |
| [`whitespace-heavy/`](./whitespace-heavy/) | `whitespace_redundancy_strip` | 42 -> 42 (0%) | 278 -> 232 (-16.5%) |

## Run any example

```bash
# From the repo root.
promptc optimize --target=cost --in examples/verbose/prompt.md
```

The CLI writes the optimized prompt to stdout and the per-pass summary to
stderr.

## About the numbers

`tokens` is a whitespace-tokenized proxy printed by the CLI. It is a coarse
estimate, not a billable count. The authoritative cost evidence comes from
the `llm-tokens-atlas` empirical token counts (DESIGN.md §6.6). Where the
two metrics disagree — most visibly in the `yaml-output-schema` example —
trust the bytes column. Every commercial BPE tokenizer charges on bytes
(via subword pieces); whitespace tokens are a coarse approximation of word
count.

The reductions vary by pass and by input. The numbers above are for the
exact bytes in each `prompt.md` and are reproducible to the byte under any
v0.x release.
