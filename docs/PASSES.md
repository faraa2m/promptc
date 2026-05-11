# Passes

Each `promptc` optimization pass is a pure function `PromptIR -> PromptIR`
with stated preconditions, postconditions, a determinism proof sketch, and a
behavior-preservation argument. This document is a reader-facing summary;
the formal contract lives in [`DESIGN.md`](../DESIGN.md) §4.

Pipeline default order (each pass is chosen so it doesn't regret a later
pass):

1. [`dead_instruction_elimination`](#1-dead_instruction_elimination)
2. [`example_pruning_by_mutual_info`](#2-example_pruning_by_mutual_info)
3. [`format_collapse`](#3-format_collapse)
4. [`whitespace_redundancy_strip`](#4-whitespace_redundancy_strip)
5. [`vocab_simplification`](#5-vocab_simplification)

To list them from the CLI:

```bash
promptc passes
```

To dry-run a single pass on your prompt:

```bash
promptc explain --in prompt.md --pass=<name>
```

To run only a chosen subset:

```bash
promptc optimize --target=cost --passes=<a>,<b> --in prompt.md
```

---

## 1. `dead_instruction_elimination`

> Drop instructions not referenced by output schema, examples, or peers.

### What it does

Walks `ir.instructions` in parse order. An instruction `I` is **referenced**
if at least one of:

1. `I.refersToFields` overlaps the field-name set of `ir.output_schema`
   (recursively into nested objects and arrays).
2. `I.slotRefs` overlaps the slot ids referenced by any retained example.
3. A normalised/tokenized form of `I.text` shares a token with any schema
   field name, example input, example output, or example rationale.

Unreferenced instructions whose `kind` is `"optional"` or `"format"` are
removed. `kind: "required"` instructions are always retained. `kind:
"style"` instructions are retained unless the caller passes
`removeStyleInstructions: true` (not exposed in the CLI in v0.0.1, but
available programmatically).

### Preconditions

- `ir.instructions.length >= 1` (something to do).
- `ir.output_schema !== null` OR `ir.examples.length >= 1` — without either,
  the reference set is empty, and "dead" is undecidable; the pass
  conservatively skips.

### Postconditions

- Every retained instruction is `kind: "required"`, `kind: "style"` (by
  default), OR was determined to be `isReferenced` against the IR's
  reference set.
- `section.instructionRefs` is reprojected to drop ids of removed
  instructions.
- No other IR field changes.

### Determinism

Pure function of the IR. Reference detection uses only IR fields; iteration
is in stored (parse-order) sequence; the retention predicate has no I/O, no
RNG, no clock, no LM. Same input -> same output bytes.

### Behavior preservation

A `kind: "optional" | "format"` instruction that the schema, examples, and
retained instructions all fail to reference is — by hypothesis — not load-
bearing on the rendered output for crisp eval tasks (classification,
extractive QA). This is empirically validated by the
[routerlab](https://github.com/faraa2m/routerlab) harness.

### Before / after

Before:

```markdown
# Instructions
- Must return the exact span verbatim, no paraphrase.
- Format the answer as JSON.
- Consider whether numerical values appear in scientific notation.
- Prefer to think about astronomy trivia and weather forecasts before answering.
```

After:

```markdown
# Instructions
- Must return the exact span verbatim, no paraphrase.
- Format the answer as JSON.
```

The astronomy and scientific-notation bullets reference nothing else in the
prompt and are dropped. The `must` bullet is retained because `kind` was
inferred as `required`. See
[`examples/redundant-instructions/`](../examples/redundant-instructions/)
for a full runnable example.

### When to disable

- The prompt is short and every instruction is intentional context (in this
  case `removeStyleInstructions: false` already preserves style; if you
  want even more conservatism, omit the pass via `--passes=`).
- The output schema is implicit (caller infers structure from examples
  only) and the schema/example token overlap is too coarse to capture the
  reference relationship reliably.
- You are running on generative tasks (free-form summarization, story
  generation) — these are outside the v0.x behavior-preservation evidence
  set.

---

## 2. `example_pruning_by_mutual_info`

> Drop few-shot examples redundant by token-overlap with retained peers.

### What it does

Clusters examples by pairwise Jaccard similarity on input-side token sets.
Two examples with Jaccard >= `exampleRedundancyThreshold` (default `0.8`)
are placed in the same cluster (transitive closure via union-find). For each
cluster of size > 1, the example with the longest `output` is retained (ties
broken by lex-min `id`, then lex-min index). Singletons survive untouched.

The "mutual information" framing is illustrative, not literal: this is a
closed-form, rule-based redundancy estimate, not a learned signal. The
empirical contribution is that it preserves accuracy on crisp eval tasks
within paired-bootstrap tolerance.

### Preconditions

- `ir.examples.length >= 2`. Cannot prune from one or zero.

### Postconditions

- The retained example set is a subset of the input set.
- For every pair of retained examples that came from **distinct** clusters,
  pairwise Jaccard < threshold by construction.
- The slot-id set referenced by retained examples is a subset of the
  original; the pass never adds slot references.
- `section.exampleRefs` is updated to drop removed ids.

### Determinism

Jaccard similarity is integer/rational arithmetic over deterministic token
sets. Pair iteration is in stored example order (i < j). Union-find merges
edges in a deterministic order. Cluster-representative selection is by
(`-output.length`, `id`) — both totally ordered. No randomness, no I/O.

### Behavior preservation

Redundant examples — examples with high input-side token overlap with other
retained examples — by hypothesis add little marginal disambiguating signal
to the model. This is the standard few-shot-curation result. The retention
rule (longest output) preserves the most informative output text within a
cluster.

### Before / after

Before (six examples, four near-duplicates of a "where is my order"
support request):

```
Example 1: My order has not arrived and I want to know where it is.
Example 2: My order has not arrived and I want to know where it is please.
Example 3: My order has not arrived yet and I want to know where it is.
Example 4: My order has not arrived and I would like to know where it is.
Example 5: How much does the enterprise plan cost per seat?
Example 6: Do you offer volume discounts for annual contracts?
```

After (one support representative kept, both sales examples kept):

```
Example 1: My order has not arrived and I want to know where it is.
Example 4: My order has not arrived and I would like to know where it is.
Example 5: How much does the enterprise plan cost per seat?
Example 6: Do you offer volume discounts for annual contracts?
```

See [`examples/duplicate-examples/`](../examples/duplicate-examples/) for
a full runnable example.

### When to disable

- Curated few-shots where minor wording variation is itself a learning
  signal (the prompt teaches the model to be robust to phrasing variance).
- Examples that look redundant on input but cover distinct rationale
  classes — pairwise input-side Jaccard doesn't see rationale text.
- Generative tasks outside the v0.x evidence set.

To tune (programmatically):

```ts
examplePruningByMutualInfo.run(ir, { exampleRedundancyThreshold: 0.6 });
```

---

## 3. `format_collapse`

> Collapse verbose markdown/XML formatting where whitespace-insensitive.

### What it does

Three rewrite rules, each gated by a structural-equivalence check that
re-parses before/after into a normalised representation and confirms bit-
equality of bullets, XML elements, and prose tokens:

- **R1.** Markdown bullets in `instructions` / `constraints` sections, when
  every item is a single line with no commas, collapse to a comma-separated
  inline list. Note: the markdown codegen re-renders typed `Instruction`
  nodes as bullets, so this rewrite's visible payoff comes when emitting
  to `plain`.
- **R2.** XML elements of the form `<tag>text</tag>` on their own line
  collapse to `tag: text` — but only when the target surface format is
  `markdown` or `plain`. Never collapses when the user asked for `xml`.
- **R3.** A YAML flat-scalar `OutputSchema` (root is an object, every
  child is a primitive scalar) collapses to plain `key=type` form. Not yet
  reachable through the markdown / XML parsers — the parsers don't
  populate the typed `OutputSchema` field in v0.0.1 — but the rewrite is
  unit-tested against synthetic IRs.

### Preconditions

- At least one candidate exists: a bulleted `instructions` /
  `constraints` section, an XML-style tag in a body, or an
  `output_schema` with `format: "yaml"` and a flat-scalar root.
- No candidate node uses a format-sensitive slot type (a `json`-typed slot
  embedded directly in body text).

### Postconditions

- Every rewritten node satisfies `equivalentUnderFormat(before, after) ==
  true` — the structure (bullets, XML elements, prose tokens) is bit-equal.
- No Slot, Example, Instruction node is added or removed.
- The OutputSchema id is preserved across R3.

### Determinism

Each rewrite is a pure local transformation gated by a syntactic predicate
on the same node. Application order is the IR's stored (parse) order. No
randomness, no I/O, no clock.

### Behavior preservation

Each rewrite preserves structural semantic content under the equivalence
helper. Empirically, tokenisers tolerate the swap without semantic shift on
crisp eval tasks. R2 is the most aggressive of the three (changes surface
syntax visibly) — if your downstream model relies on XML tags being literal
XML tags, force `--to=xml` so R2 skips.

### Before / after (R2)

Before:

```markdown
# Context
<repo>promptc</repo>
<language>TypeScript</language>
<style>concise</style>
```

After:

```markdown
# Context
repo: promptc
language: TypeScript
style: concise
```

See [`examples/yaml-output-schema/`](../examples/yaml-output-schema/) for
a full runnable example.

### When to disable

- The downstream model expects XML literally (e.g. Anthropic's
  XML-flavoured chat templates with structural roles like `<role>`).
  Force `--to=xml` so R2 skips.
- The bullet lists carry meaning beyond their items (e.g. ordered priority
  affects model behavior in your task).
- You have validated that R3's YAML -> plain swap regresses on your model
  and want to keep YAML.

---

## 4. `whitespace_redundancy_strip`

> Trim trailing whitespace, collapse blank-line runs, strip filler openers.

### What it does

Three independent string rewrites applied to every section body and every
instruction text:

1. Strip trailing whitespace on every line.
2. Strip leading + trailing whitespace from the body as a whole.
3. Collapse runs of 3+ consecutive newlines into 2 (one blank line max).

All three are **fence-aware**: bytes inside fenced code blocks (```...``` or
~~~...~~~) are preserved byte-for-byte. Tokenizers + parsers rely on exact
whitespace inside code fences.

### Preconditions

- At least one section has body OR at least one instruction has text.
- No node has `attrs.preserve_whitespace === "true"` (the parser may set
  this on user-pasted content).
- At least one node carries an actionable whitespace pattern.

### Postconditions

- For every modified section/instruction outside a fenced code block:
  no trailing whitespace on any line, no leading/trailing whitespace
  surrounding the body, no run of 3+ newlines remaining.
- No Slot, Example, or `OutputSchema` text changes.
- Instruction `id`, `kind`, `refersToFields`, `slotRefs` are all preserved.

### Determinism

All rewrites are pure string regex applications over a fixed alphabet of
patterns (`/[ \t]+$/`, `/\n{3,}/`). The fence-awareness is a linear scan
over backticks. No randomness, no I/O, no clock.

### Behavior preservation

Whitespace normalisation is the canonical behavior-preserving rewrite under
modern BPE tokenizers (validated across providers in
[`llm-tokens-atlas`](https://github.com/faraa2m/llm-tokens-atlas)). Removing
trailing whitespace and collapsing blank-line runs never changes the
semantic content visible to a model — only the token-count economics.

### Before / after

Before:

```
# Role   



# Task   

Answer the user question.   



# Instructions   

- be precise   
```

After:

```
# Role

# Task

Answer the user question.

# Instructions

- be precise
```

See [`examples/whitespace-heavy/`](../examples/whitespace-heavy/) for a
full runnable example.

### When to disable

- Almost never. The pass is conservative — every rewrite is provably
  byte-economic and tokenizer-safe. The one disable-worthy case is
  indentation-sensitive content outside a fenced code block (rare); the
  parser should attach `preserve_whitespace = "true"` to those nodes.

---

## 5. `vocab_simplification`

> Rewrite verbose phrases to short equivalents from a curated map.

### What it does

Replaces verbose phrases with shorter, semantically-equivalent forms using
a closed, versioned map ([`vocab_table.json`](../packages/passes/src/vocab_table.json)).
Matching is case-insensitive but case-preserving on the first character of
the matched span (so `In order to` -> `To` and `in order to` -> `to`).
Selection is greedy longest-leftmost.

A representative subset of entries:

| long | short |
|---|---|
| `in order to` | `to` |
| `due to the fact that` | `because` |
| `prior to` | `before` |
| `take into account` | `consider` |
| `in the event that` | `if` |
| `make use of` | `use` |
| `with regard to` | `about` |
| `at this point in time` | `now` |
| `a large number of` | `many` |

The map is **closed**: only listed phrases are rewritten. No fuzzy
matching. No synonym swaps. No register shifts. Every entry is hand-curated
for semantic equivalence in directive prose.

### Preconditions

- `ir.instructions.length >= 1` OR at least one section has a non-empty
  `body`. (Without candidate text, nothing to rewrite.)
- The vocab map loads cleanly (statically imported; malformed JSON throws
  at module load, which is what we want).

### Postconditions

- Every Instruction text and Section body, after the pass, contains zero
  occurrences of any `long` entry from the table.
- Replacement is case-preserving on the first character of the match.
- No node added or removed. Slot ids, instruction ids, section ids
  preserved.
- The map's SHA-256 is attached to `debug.tableHash` for reproducibility.

### Determinism

The map is a finite static dictionary loaded once at module import.
Replacement is a single left-to-right scan over each candidate string,
taking the longest match at each position. No randomness, no I/O at run
time, no clock.

### Behavior preservation

Each map entry is a phrase whose long form and short form share truth-
conditions in standard-English directive prose. The map is intentionally
conservative — Strunk & White category-1 redundancies + a small set of
stock fillers; no synonym swaps, no register changes, no rhetorical
reformulations. Empirical validity is per the routerlab harness.

### Before / after

Before:

```
In order to keep the summary tight, due to the fact that brevity matters,
prior to writing, take into account the main topic. In the event that the
passage has multiple themes, make use of the most central one. With regard
to length, stay under twenty words.
```

After:

```
To keep the summary tight, because brevity matters, before writing,
consider the main topic. If the passage has multiple themes, use the most
central one. About length, stay under twenty words.
```

See [`examples/verbose/`](../examples/verbose/) for a full runnable example.

### When to disable

- Domain prose where a specific verbose phrase is a load-bearing technical
  term (e.g. "as a matter of fact" used as a legal-prose hedge — the map's
  rewrite to "in fact" would weaken the legal nuance).
- Prompts where rhetorical register matters more than token economics
  (poetic, ceremonial, legalistic).
- You spotted a regression on your specific model-task combination; the
  map is versioned and entries can be removed.

To run the rest of the pipeline without this pass:

```bash
promptc optimize --target=cost \
  --passes=dead_instruction_elimination,example_pruning_by_mutual_info,format_collapse,whitespace_redundancy_strip \
  --in prompt.md
```

---

## Composing passes

Default pipeline order (DESIGN.md §4):

```
1. dead_instruction_elimination
2. example_pruning_by_mutual_info
3. format_collapse
4. whitespace_redundancy_strip
5. vocab_simplification
```

This order is chosen so earlier passes do not regret later ones. Examples:

- Dropping an instruction first (1) is cheaper than rewriting and then
  dropping it (5).
- Format collapse (3) runs before whitespace strip (4) because collapse
  can leave behind whitespace patterns that strip then cleans up.
- Vocab simplification (5) runs last because it operates on the post-
  reduction text and can leave occasional whitespace artifacts; strip
  cannot cover those, but the impact is small and the alternative
  (running strip twice) costs determinism clarity.

If you override the order via `--passes=a,b,c`, you are responsible for
choosing one that won't regret itself. The CLI does not re-order your list.
