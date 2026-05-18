# promptc Benchmark Examples

These examples show the kind of evidence to collect before adopting a compiler
pass in production. The exact numbers depend on tokenizer, model, and prompt
shape, so treat them as templates for local benchmark reports.

## Verbose Instruction Cleanup

Input:

```markdown
# Task

Summarize the input passage in one sentence. In order to keep the summary
tight, due to the fact that brevity matters, prior to writing, take into
account the main topic.
```

Command:

```bash
promptc optimize --target=cost --in prompt.md
```

Observed result from the README demo:

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Tokens | 32 | 23 | -28.1% |
| Bytes | 179 | 147 | -17.9% |

Behavior-preservation check: run the original and compiled prompts against the
same fixed examples and compare task-specific scores. For classification and
extractive QA, use exact match or schema-valid output as the primary metric.

## Few-Shot Example Pruning

Use this benchmark when prompts include many near-duplicate examples:

```bash
promptc optimize \
  --target=cost \
  --passes=example_pruning_by_mutual_info \
  --in examples/duplicate-examples/prompt.md
```

Report:

| Metric | Required Evidence |
|---|---|
| Token delta | Before/after token count from `promptc` output or Tokenometer |
| Example coverage | Which examples were retained and why |
| Output stability | Paired eval score on the same examples |
| Failure review | Manual review of cases where compiled output differs |

## Production Acceptance Bar

A prompt is ready to compile in CI when:

- The pass list is explicit or the default pipeline has been reviewed.
- Output changes are tested against a fixed eval set.
- Token savings are measured on the target model family.
- The compiled artifact is committed or generated in a reproducible build step.
