# Example: `redundant-instructions` — `dead_instruction_elimination` demo

The `Instructions` section here mixes load-bearing rules (must-return-span,
JSON format) with two `optional`-kind instructions that mention concepts
nothing else in the prompt references — astronomy trivia, scientific
notation. The `dead_instruction_elimination` pass drops those.

## Run

```bash
promptc optimize --target=cost --in examples/redundant-instructions/prompt.md
```

## Expected reduction

| metric | before | after | delta |
|---|---|---|---|
| tokens (whitespace proxy) | 152 | 131 | **-21 (-13.8%)** |
| bytes | 966 | 822 | **-144** |

## What fires

- `dead_instruction_elimination` applied — drops two `optional`-kind
  instructions whose text shares no tokens with the output schema, examples,
  or other retained instructions:
  - "Consider whether numerical values appear in scientific notation."
  - "Prefer to think about astronomy trivia and weather forecasts before
    answering."
- `whitespace_redundancy_strip` applied — collapses the empty lines the
  removed bullets left behind.

The pass conservatively retains:
- `kind: required` instructions (anything starting with "must", "always",
  "never", "do not"...) regardless of references.
- `kind: style` instructions, by default — flip the
  `removeStyleInstructions` option to allow them to be culled. (Not exposed
  through the CLI in v0.0.1; you can set it via the programmatic API.)

## Isolate the pass

```bash
promptc optimize --target=cost \
  --passes=dead_instruction_elimination \
  --in examples/redundant-instructions/prompt.md
```

## Dry-run

```bash
promptc explain --in examples/redundant-instructions/prompt.md \
  --pass=dead_instruction_elimination
```

The `debug` block lists the ids of every instruction the pass would remove.
