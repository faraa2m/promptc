# promptc Adoption Guide

`promptc` is best adopted as a deterministic build tool for prompt files. It
does not call a language model during compilation, so teams can run it in local
development and CI without API keys or variable output.

## Package Surface

The repo is organized as published npm workspace packages:

- `@promptc/cli` — `promptc` command.
- `@promptc/ir` — typed prompt intermediate representation.
- `@promptc/parser` — markdown-to-IR parser.
- `@promptc/passes` — optimization passes.
- `@promptc/codegen` — IR-to-surface-format emission.

The root package remains private because it is a monorepo wrapper. Consumers
should install the scoped workspace packages directly from npm.

## Build-Step Optimization

Store source prompts separately from compiled prompts:

```text
prompts/src/support-summary.md
prompts/dist/support-summary.md
```

Compile in the app build:

```bash
promptc optimize \
  --target=cost \
  --in prompts/src/support-summary.md \
  > prompts/dist/support-summary.md
```

Use the compiled prompt in production code. Keep source prompts readable and let
`promptc` produce the low-cost artifact.

## CI Diff Gate

Run the compiler in CI and fail if committed compiled prompts are stale:

```yaml
name: promptc

on:
  pull_request:
    paths:
      - "prompts/**"

jobs:
  compile-prompts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx @promptc/cli optimize --target=cost --in prompts/src/support-summary.md > prompts/dist/support-summary.md
      - run: git diff --exit-code prompts/dist
```

Pair this with Tokenometer if the PR should also fail on cost increases.

## Team Rollout

Start with prompts that have crisp, testable behavior: classification,
extraction, short summaries, and schema-bound outputs. Avoid broad creative
generation until the team has a task-specific eval set.

Recommended rollout order:

1. Add `promptc explain` to review what each pass would change.
2. Compile one low-risk prompt and compare outputs on a fixed eval set.
3. Commit source and compiled prompts side by side.
4. Add CI stale-output checks.
5. Add Tokenometer cost gates after the compiled prompt is stable.
