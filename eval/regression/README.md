# promptc — regression eval harness

Behavior-preservation regression eval for `promptc`. Verifies that running
the default `promptc` pass pipeline on a prompt does **not** statistically
shift its downstream task quality, under a paired bootstrap equivalence
test (default tolerance ±0.02 absolute, alpha = 0.05, 1000 resamples).

This is the empirical claim DESIGN.md §6 backs: **statistical equivalence
within stated tolerance** on crisp eval task classes (extractive QA,
classification).

## Layout

```
eval/regression/
  runner.ts            — orchestrator: paired bootstrap, equivalence verdict,
                         persistence. Workspace-import-free; all heavy deps
                         are injected.
  corpus.ts            — 50-prompt deterministic corpus (QA + classification),
                         prompt templates mirroring routerlab tasks, scorer
                         (token-F1 for QA, exact-match for classification).
  optimize.ts          — production adapter: parse -> default passes -> codegen
                         using @promptc/parser, @promptc/passes, @promptc/codegen.
  _smoke_helpers.ts    — fixture runner + fixture optimizer (no network, no
                         workspace imports).
  paths.ts             — repo-relative path resolution. No literal home paths;
                         resolves siblings via import.meta.url + fileURLToPath.
  cli.ts               — full sweep CLI (`bun eval/regression/cli.ts run`).
  _smoke.ts            — tiny end-to-end sanity CLI (`bun eval/regression/_smoke.ts`).
  regression.test.ts   — unit tests: bootstrap correctness, equivalence
                         verdict, fixture smoke, persistence round-trip.
  results/             — sweep outputs (gitignored). Per-prompt outcome JSONs
                         and `summary.json` with the verdict.
```

## Usage

### Smoke (no network, no workspace imports)

```sh
bun eval/regression/_smoke.ts
```

Runs the fixture pipeline on a 12-prompt slice, declares equivalence at the
default delta (the fixture runner returns ground truth verbatim so deltas
are exactly 0).

### Full sweep (real optimizer, fixture model)

```sh
bun eval/regression/cli.ts run --runner=promptc-only --size=50 --seed=42
```

Real `promptc` optimizer + fixture model. Exit code 0 iff the overall
equivalence verdict is `equivalent=true`.

### CLI flags

```
--size=N            Corpus size. Default 50.
--seed=N            RNG seed. Default 42.
--delta=D           Equivalence tolerance. Default 0.02.
--alpha=A           Bootstrap alpha (=> (1-A) CI). Default 0.05.
--resamples=N       Bootstrap resamples. Default 1000.
--task=qa|classification    Restrict to one task class.
--results-dir=PATH  Where to write outcomes + summary. Default <repo>/eval/regression/results.
--runner=fixture|promptc-only|env    Run mode. Default promptc-only.
```

## Outputs

```
<results-dir>/
  outcomes/
    qa/<id>.json             — per-prompt outcome (baseline / optimized output,
                               scores, score delta, applied passes)
    classification/<id>.json
  summary.json               — aggregate verdict
```

`summary.json` (schema version 1) includes:

- `delta`, `alpha`, `resamples`, `seed`
- `byTask[]` — paired bootstrap + verdict per task class
- `overall` — paired bootstrap + verdict pooled across task classes

## Determinism

- Corpus selection is seeded via mulberry32. Same `(size, seed, taskClass)` -> same examples in the same order on any platform.
- Bootstrap uses the same mulberry32 family seeded from `--seed`. Same diffs + same seed -> identical CI bounds.
- The CLI never touches `Math.random` or the wall clock outside of timestamps in the audit log.
- Sibling-repo paths are resolved relative to `import.meta.url`; no home directories or organization URLs appear in committed source.

## Statistical contract

For each task class T and overall:

```
diffs_T = [ score(optimized_i) - score(baseline_i) for i in T ]
sample mean d̄_T
paired bootstrap on diffs_T -> 95% percentile CI [lo, hi]
equivalent_T = (lo >= -delta) AND (hi <= delta)
```

The overall verdict is the same test pooled across all task classes — this
is the headline number for DESIGN.md §6 and the paper's load-bearing claim.

## Tests

```sh
bun test eval/regression/regression.test.ts
```

Coverage:

1. Paired bootstrap correctness (empty, n=1, symmetric, spread-vs-tight, determinism).
2. Equivalence verdict logic (within / above / below tolerance, straddling).
3. Corpus determinism (seed reproducibility, task-class filter).
4. Default scorer behavior (classification exact-match, QA token-F1, abstain).
5. End-to-end smoke via the fixture runner (zero-diff baseline passes).
6. Persistence round-trip.
