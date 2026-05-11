# promptc — Design Document

_Status: Design finalized 2026-05-10. Implementation follows this contract._
_Authors: Faraazuddin Mohammed._
_License: Apache-2.0._

## 1. Vision

`promptc` is a **deterministic, LM-free compiler for prompts as an AST/IR**. The user supplies a prompt in a human-readable format (Markdown, XML, plain). The parser lifts it to a typed prompt intermediate representation. A sequence of optimization passes — each with stated preconditions, postconditions, a determinism proof sketch, and a behavior-preservation argument — rewrites the IR. A codegen step emits the optimized prompt back into the chosen surface format. The compile path **never calls an LLM**, never consults a learned model, and produces a bit-for-bit reproducible output for any fixed input. Behavior preservation — that the optimized prompt yields outputs statistically equivalent to those from the original under the same model — is empirically validated using `routerlab`'s eval harness on crisp evaluation tasks (classification, extractive QA).

The contribution is paradigmatic, not algorithmic: a typed prompt IR, a formal pass framework, and a corpus of before/after evidence that the framework actually preserves behavior.

## 2. Paradigmatic positioning

Prompt optimization in 2026 lives on two axes:

- **Deterministic vs. stochastic.** Does the compile path produce identical output on identical input, or does it depend on RNG / sampling / LM-nondeterminism?
- **LM-free vs. LM-in-the-loop.** Does the compile path call a language model, or does it operate purely over the prompt content?

```
                       LM-free                              LM-in-the-loop
                   +---------------------------------+--------------------------------------+
       Deterministic | promptc        (this work)    |  (~empty quadrant — LMs at temp=0     |
                     | ctxray / reprompt-cli         |   are not reproducibly deterministic; |
                     | (regex rewriter, no IR)       |   Atil 2024 reports up to 15% acc.    |
                     | ASTro (code, not prompts —    |   variance, Ouyang 2023 up to 75%     |
                     |  engineering precedent)        |   output variance, even at temp=0)    |
                   +---------------------------------+--------------------------------------+
        Stochastic   | (empty — no published work)   |  SAMMO, DSPy, LLMLingua family,       |
                     |                                |  AutoPrompt, EvoPrompt, APO, APE,     |
                     |                                |  PRewrite, OPRO, MIPRO, OpenAI Prompt |
                     |                                |  Optimizer, MLflow Prompt Opt,        |
                     |                                |  Compiler.next, promptolution,        |
                     |                                |  Cmprsr, CompactPrompt, LLM-DCP,      |
                     |                                |  AutoCompressors, Selective Context   |
                   +---------------------------------+--------------------------------------+
```

The closest neighbors and their quadrants:

- **SAMMO** (`arXiv:2404.02319`, Microsoft, EMNLP 2024) — *Stochastic × LM-in-the-loop.* Uses BeamSearch / RegularizedEvolution over a prompt-program execution graph. Mutators include LM-driven operators (`Paraphrase`, `Rewrite`, `APO`, `APE`) whose outputs vary run-to-run. The search objective evaluates candidates by *executing* them, which is LM-driven and stochastic. Same vocabulary as promptc ("prompts as programs," "compile-time optimization"), opposite quadrant.
- **DSPy** (`arXiv:2310.03714`, Stanford NLP) — *Stochastic × LM-in-the-loop.* `compile()` runs a teacher LM on every training example, collecting successful traces as few-shot demonstrations, then binds them into a student. Requires labeled data; outputs are LM-dependent. Owns "compiler" terminology in the LLM space.
- **LLMLingua / LongLLMLingua / LLMLingua-2** (Microsoft) — *Stochastic × LM-in-the-loop.* Uses a learned token-classification or self-information scoring model to drop low-information tokens. Optimal regime: long contexts (RAG, multi-document QA). LLMLingua-2 explicitly frames compression as a token-classification problem.
- **`ctxray` / `reprompt-cli`** (independent dev, 2026, MIT) — *Deterministic × LM-free*, **same quadrant as promptc**. Differentiates as: no IR, no formal pass framework, no per-pass equivalence eval, scope limited to AI-coding sessions. The closest deterministic-LM-free neighbor; cited and differentiated explicitly in the companion paper.
- **Compiler.next** (`arXiv:2510.24799`) — *Stochastic × LM-in-the-loop*, but at the workflow layer rather than the prompt-content layer. Cited as adjacent, not competing.

promptc occupies *(Deterministic × LM-free)* with a **typed prompt IR and formally-described optimization passes** — a position no other published-research artifact currently holds.

## 3. The Prompt IR

The IR is a typed tree. The root is `PromptIR`. Its children are five typed lists (and optional output schema + metadata):

```
PromptIR
  ├── sections: Section[]              // e.g. role, task, context, examples, output_schema
  ├── slots: Slot[]                    // typed placeholders ({{var}}) with constraints
  ├── examples: Example[]              // few-shot examples (input/output pairs)
  ├── instructions: Instruction[]      // imperative instructions, each typed
  ├── output_schema?: OutputSchema     // JSON-schema-like, optional
  └── metadata: Metadata
```

The IR is **content-level**, not execution-level. A `PromptIR` instance represents *one prompt*, not a multi-call pipeline. This is the load-bearing distinction from SAMMO's `Component` graph, which represents a *prompt program* with multiple LM invocations.

### 3.1 TypeScript type definitions

The following definitions land in `packages/ir/src/types.ts`. They are valid TypeScript and should be lifted verbatim.

```ts
// packages/ir/src/types.ts

/** Stable identifier for any IR node. Generated at parse time. */
export type NodeId = string;

/** Source location for round-trip + debugging. */
export interface SourceSpan {
  /** Byte offset in the original input. */
  start: number;
  /** Byte offset (exclusive) in the original input. */
  end: number;
  /** 1-indexed line number. */
  line: number;
  /** 1-indexed column number. */
  column: number;
}

/** Surface format the IR was parsed from. */
export type SourceFormat = "markdown" | "xml" | "plain";

/** Section kinds — closed set; unknown kinds parse as "other". */
export type SectionKind =
  | "role"
  | "task"
  | "context"
  | "examples"
  | "instructions"
  | "output_schema"
  | "constraints"
  | "tools"
  | "other";

export interface Section {
  id: NodeId;
  kind: SectionKind;
  /** Heading text as it appeared in the source (Markdown), or tag name (XML). */
  heading: string;
  /** Raw body text; passes may rewrite this. */
  body: string;
  /** Source location in the original input. */
  source: SourceSpan;
  /** Slot references inside this section's body (transitive of slots[]). */
  slotRefs: NodeId[];
  /** Instruction nodes attributed to this section. */
  instructionRefs: NodeId[];
  /** Example nodes attributed to this section. */
  exampleRefs: NodeId[];
  /** Free-form, parser-attached annotations. */
  attrs: Record<string, string>;
}

/** Typed placeholder ({{var}} / <slot name="var"/>). */
export type SlotType = "string" | "number" | "boolean" | "json" | "enum";

export interface Slot {
  id: NodeId;
  name: string;
  type: SlotType;
  /** For SlotType="enum"; null otherwise. */
  enumValues: string[] | null;
  /** Optional default if the caller does not bind. */
  default: string | null;
  /** Whether the slot is required at render time. */
  required: boolean;
  /** Source locations of every occurrence in the IR. */
  occurrences: SourceSpan[];
  /** Section node ids in which this slot appears. */
  appearsIn: NodeId[];
}

/** A few-shot example. */
export interface Example {
  id: NodeId;
  /** Caller-facing label, if any (e.g. "Example 1"). */
  label: string | null;
  /** The input portion of the example (raw). */
  input: string;
  /** The expected output portion. */
  output: string;
  /** Optional rationale (chain-of-thought, "Reasoning:", etc.). */
  rationale: string | null;
  /** Slots referenced inside the input/output (for binding analysis). */
  slotRefs: NodeId[];
  /** Parent section node id. */
  parent: NodeId;
  source: SourceSpan;
}

/** Imperative instruction extracted from the prompt. */
export type InstructionKind = "required" | "optional" | "style" | "format";

export interface Instruction {
  id: NodeId;
  kind: InstructionKind;
  /** The instruction text (after canonicalization). */
  text: string;
  /** Verbs detected (e.g. "respond", "format", "use", "avoid"). */
  verbs: string[];
  /** Output-schema fields this instruction is plausibly about, by name. */
  refersToFields: string[];
  /** Slots this instruction mentions, by id. */
  slotRefs: NodeId[];
  /** Parent section node id. */
  parent: NodeId;
  source: SourceSpan;
}

/** JSON-schema-like output schema; subset for tractable static analysis. */
export type SchemaFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "enum"
  | "null";

export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  required: boolean;
  /** For type="array". */
  items?: SchemaField;
  /** For type="object". */
  fields?: SchemaField[];
  /** For type="enum". */
  enumValues?: string[];
  /** Optional human description; passes may treat as ignorable. */
  description?: string;
}

export interface OutputSchema {
  id: NodeId;
  /** Either "json", "xml", "yaml", or "free" (unstructured but stated). */
  format: "json" | "xml" | "yaml" | "free";
  /** Root schema field; null for "free". */
  root: SchemaField | null;
  source: SourceSpan;
}

/** Bookkeeping attached to the IR. */
export interface Metadata {
  /** Surface format the IR was parsed from. */
  sourceFormat: SourceFormat;
  /** Free-form caller tags (e.g. "qa", "classification"). */
  tags: string[];
  /** SHA-256 of the original source bytes (for cache keys). */
  sourceHash: string;
  /** Original source bytes — kept for round-tripping. */
  rawSource: string;
  /** Names of passes that have run on this IR, in order. */
  passLog: PassLogEntry[];
}

export interface PassLogEntry {
  pass: string;
  /** Whether the pass actually ran (preconditions met). */
  applied: boolean;
  /** Reason for skip, if applied=false. */
  skipReason: string | null;
  /** Number of nodes mutated. */
  nodesChanged: number;
  /** Compile-time ms (informational, not part of behavior). */
  durationMs: number;
}

/** The top-level IR. */
export interface PromptIR {
  /** IR version — bumped on breaking type changes. */
  irVersion: 1;
  sections: Section[];
  slots: Slot[];
  examples: Example[];
  instructions: Instruction[];
  output_schema: OutputSchema | null;
  metadata: Metadata;
}

/** Pass contract — every pass implements this shape. */
export interface Pass {
  /** Stable kebab-case name. */
  readonly name: string;
  /** Short human description (one line). */
  readonly description: string;
  /** Preconditions, declared so the pipeline can skip safely. */
  preconditions(ir: PromptIR): PreconditionResult;
  /** Run the pass. Must be a pure function of `ir`. */
  apply(ir: PromptIR): PassResult;
}

export interface PreconditionResult {
  ok: boolean;
  /** If !ok, why. */
  reason?: string;
}

export interface PassResult {
  /** New IR (never mutated in place). */
  ir: PromptIR;
  /** Number of nodes mutated. */
  nodesChanged: number;
  /** Optional per-pass diagnostics (passes may attach evidence here). */
  diagnostics: string[];
}

/** Compile options accepted by the top-level `compile()` function. */
export interface CompileOptions {
  /** Optimization target — affects pass *selection*, not pass *determinism*. */
  target: "cost" | "tokens" | "none";
  /** Surface format to emit. */
  to: SourceFormat;
  /** Explicit pass order. If omitted, the default deterministic order is used. */
  passes?: string[];
  /** Hard cap on total mutations across all passes (safety rail). */
  maxMutations?: number;
}
```

**Invariants the IR maintains:**

1. **Pure data.** `PromptIR` is a plain object — no class instances, no functions on nodes. Trivially serializable to JSON.
2. **Immutable in transit.** Passes never mutate their input. They return a new `PromptIR`. (Internally a pass may use mutation for efficiency; the boundary is pure.)
3. **Identifiers stable across passes.** A pass that does not remove a node preserves that node's `id`. A pass that removes a node never re-uses the id.
4. **Round-trippable.** Codegen of an IR with no applied passes equals the original source modulo a documented canonical normalization (whitespace trim, blank-line collapse) — see §4 for guarantees and exceptions.
5. **No cycles.** The IR is a tree.

## 4. Optimization passes (initial set)

Each pass below is defined with: name, what it does, **preconditions** (what must be true of the IR for the pass to be safe), **postconditions** (what is guaranteed after the pass), **determinism proof sketch**, **behavior-preservation argument**, and **failure mode** (what happens when preconditions fail).

The default deterministic order is:

```
1. dead_instruction_elimination
2. example_pruning_by_mutual_info
3. format_collapse
4. whitespace_redundancy_strip
5. vocab_simplification
```

This order is chosen so that earlier passes do not regret later ones (e.g. dead-instruction elimination must precede vocab simplification, because deletion is cheaper than rewriting + then deleting).

---

### 4.1 `dead_instruction_elimination`

**What it does.** Removes `Instruction` nodes that are *not referenced* by the prompt's output schema, by any retained example, or by any other retained instruction. An instruction is "referenced" if its `refersToFields` overlaps `output_schema.root.fields[*].name` (transitively), or if any of its `slotRefs` appears in the rendered output schema or in any retained example. Instructions of kind `"style"` are *not* eliminated (style instructions may affect output character even without explicit reference).

**Preconditions.**
- `ir.output_schema` is non-null **OR** `ir.examples.length > 0`. (If neither exists, "dead" is undefined — every instruction is, by default, referenced.)
- Every `Instruction.refersToFields` and `Instruction.slotRefs` is populated by the parser. (If empty, the pass cannot decide and skips that instruction conservatively.)

**Postconditions.**
- For every `Instruction` `I` removed: `I.kind != "style"`, and there exists no field `f` in `output_schema` with `f.name ∈ I.refersToFields`, and there exists no slot `s` referenced by `I` such that `s` appears in `output_schema` or in any `Example`.
- `metadata.passLog` is extended with one `PassLogEntry`.
- `ir.sections[*].instructionRefs` is updated to reflect the removed instructions.
- No other IR field changes.

**Determinism proof sketch.** The pass is a pure function of `ir`: it iterates `ir.instructions` in their stored order (which is parse order, which is byte-offset order in the source), computes a boolean predicate `isReferenced(instr, ir)` using only IR fields, and removes instructions where the predicate is false. The predicate has no I/O, no RNG, no LM calls. The output is the unique fixed-point of one pass.

**Behavior-preservation argument.** A `"required"` or `"format"` instruction that the output schema does not reference is, by hypothesis, irrelevant to the rendered output. Models may still pattern-match it as context, but the empirical claim is that *for crisp eval tasks* (extractive QA, classification), removing such instructions does not change downstream metrics within paired-bootstrap tolerance. This is the **load-bearing empirical claim of the paper** and is validated by routerlab.

**Failure mode.** If preconditions fail, the pass writes `applied=false, skipReason="no output_schema or examples to anchor reference analysis"` and returns the IR unchanged. The pipeline continues.

---

### 4.2 `example_pruning_by_mutual_info`

**What it does.** Removes `Example` nodes whose contribution to disambiguating the task is below a threshold. The mutual-information estimate is *not* learned — it is a closed-form deterministic function:

```
score(example_i) = unique_token_share(example_i) + slot_coverage(example_i)
                 - redundancy_with_other_retained_examples(example_i)
```

Where:
- `unique_token_share(e)` = |unique non-stopword tokens in `e.input ∪ e.output`| / |total tokens|.
- `slot_coverage(e)` = number of `Slot.id` in `e.slotRefs` not yet covered by previously-retained examples / total slots.
- `redundancy(e)` = max Jaccard overlap of `e`'s token-set against any previously-retained example.

Examples are ranked by `score(example_i)` (descending, ties broken by `Example.id` lexicographic order for determinism). The top-K are retained, where `K = min(ir.examples.length, configurableMaxExamples)`, and examples below a threshold `tau` are dropped regardless of K. Defaults: `K=∞`, `tau=0.15`.

**Preconditions.**
- `ir.examples.length >= 2`. (Cannot prune from one or zero.)
- For every retained example after pruning, every `Slot.id ∈ ir.slots[required=true]` is covered by at least one example OR by the output schema's defaults. (Conservative coverage check.)

**Postconditions.**
- The retained examples are a subset of the original examples.
- The set of `Slot.id`s referenced by *required* slots in the retained examples is a superset of the required-slot set referenced by the *original* retained set, given coverage budget. (No required-slot regression.)
- `metadata.passLog` is extended.

**Determinism proof sketch.** The score function is closed-form, integer/rational arithmetic over IR fields. Tie-breaking is by `Example.id`, which is parser-deterministic. No randomness, no I/O.

**Behavior-preservation argument.** Empirically, redundant few-shot examples (high token-overlap with other retained examples) do not raise eval accuracy beyond the diminishing-return point. The pass keeps the highest-marginal-information examples. The behavior-preservation argument is again validated by routerlab on classification + extractive-QA tasks.

**Failure mode.** If preconditions fail (≤1 example, or required-slot coverage would regress), the pass returns the IR unchanged.

---

### 4.3 `format_collapse`

**What it does.** Collapses verbose Markdown / XML formatting into a shorter equivalent *iff* the surface format is provably whitespace-insensitive at that location. Specific rewrites:

- Markdown bulleted lists with one-line items collapse to comma-separated inline lists when inside an `instructions` or `constraints` section.
- XML elements with no attributes and a single text child collapse from `<tag>text</tag>` to a labeled line `tag: text` when emitted as Markdown or plain (no collapse when emitting XML).
- Markdown heading depth is canonicalized: H3+ promote to H2 within a section's own body if no semantic siblings exist.

**Preconditions.**
- The target output format (`CompileOptions.to`) is known and is `markdown` or `plain`. Format collapse is a no-op when `to = "xml"`.
- For each candidate node: no inline-rendered slot inside the node uses a format-sensitive slot type (e.g. a `json`-typed slot, which expects a JSON literal preserved with surrounding context).

**Postconditions.**
- Every collapsed node renders to a string `s'` such that `parseToIR(s').sections == parseToIR(s).sections` modulo source-span and heading-text changes.
- No `Slot`, `Example`, `Instruction`, `OutputSchema` node is added or removed.
- `metadata.passLog` updated.

**Determinism proof sketch.** Each rewrite is a pure local rewrite over a node, gated by a syntactic predicate on the same node. Application order is the IR's parse order. No randomness.

**Behavior-preservation argument.** Markdown / plain parsers used by current frontier models tolerate whitespace + heading-depth collapse without semantic shift in tested tasks. The empirical check is again per-task via routerlab; if a particular model-task pair regresses, that combination is logged and the pass can be disabled via `CompileOptions.passes`.

**Failure mode.** If the output format is XML or if a candidate node fails the slot-type predicate, the pass skips that node. Other nodes still get processed.

---

### 4.4 `whitespace_redundancy_strip`

**What it does.** Removes redundant whitespace and trivially redundant phrases:

- Trims trailing whitespace on every line.
- Collapses runs of ≥3 newlines into 2.
- Collapses runs of ≥2 spaces inside paragraph text into 1 space (unaffected: inside code blocks, inside slot literals).
- Strips a small curated list of high-frequency redundant openers from instruction nodes: `"Please "`, `"Make sure to "`, `"Be sure to "`, `"Note that "`, `"It is important that you "`. The curated list is published in `packages/passes/data/redundant_openers.json` and versioned.

**Preconditions.**
- No node has `attrs.preserve_whitespace = "true"`. (Parsers may mark code blocks, raw user content with this attribute.)

**Postconditions.**
- For every section `S`: `S.body.length` after the pass is ≤ `S.body.length` before.
- No `Slot`, `Example`, or `OutputSchema` node text changes (we never touch slot literals or schema text).
- The set of `Instruction.text` values may shrink (curated openers stripped) but `Instruction.id`, `Instruction.kind`, `Instruction.refersToFields`, and `Instruction.slotRefs` are preserved.

**Determinism proof sketch.** All operations are pure-string regex applications over a fixed alphabet of patterns. Curated openers list is content-addressed by a hash recorded in `metadata.passLog`. No randomness, no I/O at compile time.

**Behavior-preservation argument.** Whitespace normalization is the canonical example of a behavior-preserving rewrite in any modern tokenizer (tested across providers in `llm-tokens-atlas`). The opener list is conservative: each entry is a politeness phrase whose removal has been validated to be neutral on classification + extractive-QA tasks in routerlab.

**Failure mode.** Code blocks and `preserve_whitespace`-attributed nodes are left untouched. The pass logs how many lines were skipped.

---

### 4.5 `vocab_simplification`

**What it does.** Replaces verbose phrases with shorter equivalents from a curated, versioned map (`packages/passes/data/vocab_map.json`). Examples of entries (illustrative, final list TBD):

```
"in order to"      -> "to"
"due to the fact that" -> "because"
"a large number of"    -> "many"
"at this point in time"-> "now"
"in the event that"    -> "if"
```

The map is **closed**: only listed phrases are rewritten. No fuzzy matching. Match is case-insensitive but case-preserving on replacement (first-letter capitalization preserved).

**Preconditions.**
- The phrase occurs in an `Instruction.text`, a `Section.body`, or non-slot, non-codeblock portions of an `Example`. Phrases inside slot literals, code blocks, schema strings, or `attrs.preserve_text="true"` regions are not touched.

**Postconditions.**
- For every replaced occurrence, `text.length` strictly decreases.
- The phrase map's SHA-256 is recorded in `metadata.passLog` for reproducibility.
- No node added or removed.

**Determinism proof sketch.** The map is a finite static dictionary. Replacement is a left-to-right pass over each candidate node, taking the longest match at each position (greedy). No randomness.

**Behavior-preservation argument.** Each entry in the map is hand-curated for semantic equivalence in instruction-following contexts and validated by routerlab on the target task classes. The map is versioned; entries proven to harm a task get removed (with a regression-test record).

**Failure mode.** If the map cannot be loaded (file missing), the pass returns `applied=false, skipReason="vocab_map missing"`.

---

## 5. Compilation pipeline

```
input string  --parse-->  PromptIR
                            |
                            v
                  +-----------------------+
                  | pass 1 preconditions? |
                  +-----------------------+
                            |
                       yes  |  no -> log skip, IR unchanged
                            v
                  +-----------------------+
                  |     pass 1 apply      |
                  +-----------------------+
                            |
                            v
                          (...)
                            |
                            v
                  +-----------------------+
                  |     pass N apply      |
                  +-----------------------+
                            |
                            v
                          codegen
                            |
                            v
                       output string
```

Per-stage guarantees:

- **Parse.** `parse(source, { from })` is a pure function. Same bytes in → same `PromptIR` out. Errors are returned as a structured `ParseDiagnostic[]`, not exceptions.
- **Pass pipeline.** Pass order is fixed (default order in §4) unless overridden via `CompileOptions.passes`. Every pass writes one `PassLogEntry` to `metadata.passLog`, even if skipped.
- **Codegen.** `codegen(ir, { to })` is a pure function. For a `PromptIR` whose `metadata.passLog` is empty and whose `metadata.sourceFormat == to`, `codegen` produces a string `s'` such that `parse(s', { from: to })` is structurally equal (modulo source spans) to the original IR. **Round-trip property:** `codegen ∘ parse` is the identity on the IR equivalence class.

Determinism of the whole compile path follows from determinism of each stage and the absence of any side-effect-bearing call (no RNG, no clock, no file I/O except for *static, content-addressed* asset loading like `vocab_map.json`).

## 6. Behavior-preservation eval methodology

Behavior preservation is a per-pass + per-task-class empirical claim, not a theorem. The methodology:

1. **Task classes.** Initial validation is scoped to two crisp task classes from routerlab: **classification** (single-label and multi-label) and **extractive QA**. These are chosen because they have unambiguous correctness metrics (exact-match, F1) and are robust to surface-level variation in the prompt.
2. **Dataset.** For each task class, ~200 prompts are drawn from routerlab's seed task definitions. Each prompt is run through both the original IR and the optimized IR (after the full default pass pipeline). Both are evaluated against the same gold labels using the same scoring function.
3. **Model pool.** At least three models from the routerlab pool: one frontier (Claude Opus 4.7 or equivalent), one mid-tier (Claude Sonnet 4.6 or Llama 3.3 70B on Groq), one low-tier (Claude Haiku 4.5 or Llama 3.1 8B). This pins behavior across the cost-quality frontier rather than at one operating point.
4. **Statistical test.** Per (pass, task-class, model), we compute a **paired bootstrap confidence interval** on the difference `metric(optimized) - metric(original)`. The null hypothesis is statistical equivalence within a stated tolerance `δ` (default `δ = 0.02` absolute F1 / accuracy). Equivalence is **declared** when the bootstrap 95% CI for the difference falls entirely within `[-δ, +δ]`.
5. **Per-pass evidence.** Each pass also gets a *per-pass* run with only that pass enabled, so the contribution of each pass is separately reported. This is the per-pass-level evidence that the paper carries.
6. **Cost evidence.** Token deltas (input + output) are measured using `llm-tokens-atlas`-calibrated empirical counts (not offline-tokenizer proxies), so the reported cost reduction is grounded in real provider economics — see Project 1 and Project 2 in the parent plan.
7. **Regression record.** Any (pass, task-class, model) where statistical equivalence fails is logged in `eval/regression/regressions.json`, and the offending pass is *disabled by default* for that combination until corrected. The disablement is opt-out, not silent.

This methodology is the **empirical contribution that LLMLingua-family papers structurally cannot match**, because their compression is lossy by design (the budget controller intentionally drops information). promptc's claim is *equivalence within tolerance*, not *lossy approximation within tolerance*.

## 7. Open optimization corpus

Alongside the paper, promptc publishes an open corpus on HuggingFace: **`promptc-corpus`** (CC-BY-4.0). Each row is a (before, after) pair with metadata:

```json
{
  "id": "promptc-corpus-0001",
  "task_class": "classification",
  "source_format": "markdown",
  "original_prompt": "...",
  "optimized_prompt": "...",
  "passes_applied": ["dead_instruction_elimination", "format_collapse"],
  "tokens_original": { "anthropic": 412, "openai": 388, "gemini": 405 },
  "tokens_optimized": { "anthropic": 287, "openai": 271, "gemini": 282 },
  "cost_delta_usd_per_million_calls": { "claude_sonnet_4_6": 0.43, "claude_haiku_4_5": 0.09 },
  "quality_metric": "f1",
  "quality_original": 0.87,
  "quality_optimized": 0.86,
  "equivalence_test": { "bootstrap_ci_low": -0.018, "bootstrap_ci_high": 0.004, "tolerance": 0.02, "pass": true }
}
```

The corpus is the **citable, reusable artifact** that makes promptc evaluable by others without re-running our infrastructure. Target initial size: 500 pairs spanning classification + extractive QA.

## 8. Non-goals

promptc is **not**:

- A **prompt-compression library.** LLMLingua, LongLLMLingua, LLMLingua-2, Cmprsr, CompactPrompt, LLM-DCP, and AutoCompressors own the compression niche; their best regime is long contexts and their mechanism is learned scoring. promptc never frames itself as "compression" — cost reduction is a *byproduct* of structural simplification, not the goal.
- A **prompt-search system.** SAMMO, EvoPrompt, AutoPrompt, APO, APE, OPRO own the search niche. promptc has no search loop, no candidate evaluation, no iterative refinement at compile time.
- An **LLM-in-the-loop optimizer.** DSPy, MIPRO, OpenAI Prompt Optimizer, MLflow Prompt Optimization, PRewrite, TextGrad own the LM-in-the-loop niche. promptc's compile path is provably LM-free.
- A **soft-prompt or weight-tuning framework.** AutoCompressors and continuous-prefix-tuning methods operate on model internals; promptc never touches model weights, embeddings, or continuous vectors.
- A **fine-tuning runtime.** No training, no gradient steps, no model state ever leaves the IR.
- A **prompt-versioning ops platform.** Agenta, LangSmith, Promptfoo, Helicone all do prompt versioning + observability. promptc is a *transformation library*; it composes underneath such platforms but does not replace them.
- A **multi-call agent orchestration framework.** LangGraph, LangChain agents, CrewAI, AutoGen, and `microsoft/sammo` (at the program-graph level) own that space. promptc operates over one prompt at a time.

## 9. Glossary

- **IR (Intermediate Representation):** the typed in-memory data structure that promptc passes mutate. See `PromptIR` in §3.
- **Pass:** a function `PromptIR → PromptIR` with stated preconditions and postconditions. See `Pass` in §3.
- **Determinism:** *Same input bytes + same compiler version → same output bytes.* No reliance on RNG, clock, or external services at compile time.
- **Behavior preservation:** *Statistical equivalence within a stated tolerance* on a stated task class, validated empirically via routerlab. Not a formal theorem; an empirically defended claim.
- **Crisp eval task:** a task with an unambiguous, scoreable correctness metric (e.g. extractive-QA exact match, classification accuracy). Generative tasks (free-form summarization, story generation) are *not* crisp and are out of scope for behavior-preservation validation in this initial release.

## 10. References

Headline references for the closest related works:

- Schnabel & Neville, SAMMO / "Prompts As Programs" — `arXiv:2404.02319`.
- Khattab et al., DSPy — `arXiv:2310.03714`.
- Jiang et al., LLMLingua-2 — `arXiv:2403.12968`.
- ctxray / reprompt-cli — github.com/reprompt-dev/reprompt.
- Compiler.next — `arXiv:2510.24799`.
- A Systematic Survey of Automatic Prompt Optimization Techniques — `arXiv:2502.16923`.
- llm-tokens-atlas — github.com/faraa2m/llm-tokens-atlas (cost grounding).
- routerlab — github.com/faraa2m/routerlab (eval harness).
- tokenometer — github.com/faraa2m/tokenometer (methodology origin).
