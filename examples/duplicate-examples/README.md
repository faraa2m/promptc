# Example: `duplicate-examples` — `example_pruning_by_mutual_info` demo

Four of the six few-shot examples in this prompt are minor reword variants of
the same "where is my order" support request. The
`example_pruning_by_mutual_info` pass clusters them by pairwise Jaccard
similarity on the input text, keeps the longest-output representative per
cluster, and drops the rest.

## Run

```bash
promptc optimize --target=cost --in examples/duplicate-examples/prompt.md
```

## Expected reduction

| metric | before | after | delta |
|---|---|---|---|
| tokens (whitespace proxy) | 123 | 85 | **-38 (-30.9%)** |
| bytes | 734 | 528 | **-206** |

## What fires

- `example_pruning_by_mutual_info` applied — clusters the four
  reword-variants (Jaccard >= 0.8 default threshold) and retains one
  representative. The two `sales_inquiry` examples stay because they are
  not redundant with each other or with the support cluster.
- `whitespace_redundancy_strip` applied — collapses the blank lines the
  removed examples leave behind.

## Tune the threshold

The default redundancy threshold is `0.8`. You can lower it programmatically
to prune more aggressively, or raise it to keep more variants. The CLI in
v0.0.1 does not expose this knob; pass it via the library API:

```ts
import { examplePruningByMutualInfo } from "@promptc/passes";
examplePruningByMutualInfo.run(ir, { exampleRedundancyThreshold: 0.6 });
```

## Isolate the pass

```bash
promptc optimize --target=cost \
  --passes=example_pruning_by_mutual_info \
  --in examples/duplicate-examples/prompt.md
```

## Dry-run

```bash
promptc explain --in examples/duplicate-examples/prompt.md \
  --pass=example_pruning_by_mutual_info
```

The `debug` block reports cluster count and which example ids would be
removed.
