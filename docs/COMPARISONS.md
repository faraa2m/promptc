# Comparisons

How `promptc` is positioned against the closest published work in prompt
optimization. The full citation list and prior-art notes live in
[`DESIGN.md`](../DESIGN.md) §2 and §10.

## The 2x2

Prompt optimization in 2026 lives on two axes:

- **Deterministic vs. stochastic.** Does the compile path produce identical
  output bytes on identical input bytes, or does it depend on RNG /
  sampling / LM-nondeterminism?
- **LM-free vs. LM-in-the-loop.** Does the compile path call a language
  model, or does it operate purely over prompt content?

```
                  LM-free                              LM-in-the-loop
                +-------------------------------+--------------------------------------+
  Deterministic | promptc        (this work)    |  ~empty quadrant —                   |
                | ctxray / reprompt-cli         |  LMs at temp=0 are not               |
                | (regex rewriter, no IR)       |  reproducibly deterministic;         |
                | ASTro                         |  Atil 2024 reports up to 15% acc.    |
                | (code, not prompts —          |  variance even at temp=0; Ouyang     |
                |  engineering precedent)       |  2023 up to 75% output variance.     |
                +-------------------------------+--------------------------------------+
  Stochastic    | empty                         |  SAMMO, DSPy, LLMLingua family,      |
                | (no published work)           |  AutoPrompt, EvoPrompt, APO, APE,    |
                |                               |  PRewrite, OPRO, MIPRO, OpenAI       |
                |                               |  Prompt Optimizer, MLflow Prompt     |
                |                               |  Opt, Compiler.next, promptolution,  |
                |                               |  Cmprsr, CompactPrompt, LLM-DCP,     |
                |                               |  AutoCompressors, Selective Context  |
                +-------------------------------+--------------------------------------+
```

`promptc` occupies the **(Deterministic, LM-free)** quadrant with a typed
prompt IR and a formal pass framework. No other published-research artifact
currently holds this position.

## At-a-glance comparison

| dimension | `promptc` | SAMMO | DSPy | LLMLingua-2 | ctxray |
|---|---|---|---|---|---|
| **paradigm** | rule-based compiler | genetic search over a program graph | LM-driven demonstration optimizer | learned token classifier | regex rewriter |
| **compile path calls an LM** | **never** | yes (Paraphrase, APO, APE mutators) | yes (teacher LM on every train example) | yes (scoring model) | no |
| **deterministic** | **yes (bit-for-bit)** | no (genetic RNG; LM mutators) | no (LM outputs vary) | no (learned scorer) | yes |
| **requires labeled data** | no | yes (eval scoring) | yes (training set) | yes (offline trained) | no |
| **typed IR** | **yes** | program graph (different abstraction layer) | predicate signatures, not prompt-content IR | no | no |
| **per-pass preconditions / postconditions** | **yes (formal)** | no (search space) | no | no | no |
| **per-pass behavior-preservation eval** | **yes (paired bootstrap on crisp tasks)** | end-to-end task accuracy only | end-to-end task accuracy only | task-level F1 (lossy by design) | none |
| **best regime** | structural prompt simplification with preserved behavior | exploring large prompt-program spaces | compiling LM-driven pipelines from labeled data | long-context budget compression | quick AI-coding session cleanup |
| **bibliographic** | arXiv preprint forthcoming | arXiv:2404.02319 | arXiv:2310.03714 | arXiv:2403.12968 | github.com/reprompt-dev |
| **license** | Apache-2.0 | MIT | Apache-2.0 | MIT | MIT |

## Per-tool sketch

### SAMMO

`microsoft/sammo` (Schnabel & Neville, EMNLP 2024) is the closest in
*vocabulary*: prompts-as-programs, compile-time optimization. Both use the
word "compiler." That's where the kinship ends.

SAMMO is **stochastic** and **LM-in-the-loop**:

- Optimization is BeamSearch / RegularizedEvolution over a `Component`
  graph. Each candidate is constructed by mutation; mutators include
  `Paraphrase`, `Rewrite`, `APO`, `APE` — all LM-driven.
- The objective evaluates candidates by *executing* them, which is an LM
  call and is sampled (temperature-dependent).
- Re-running SAMMO on the same input is not guaranteed to produce the same
  output. Determinism is not a claimed property.

`promptc` is **deterministic** and **LM-free**:

- No search loop. Passes have stated preconditions; if they apply, they
  apply uniquely. No candidate generation, no fitness, no LM mutation.
- No LM call in the compile path. Period.

When to use which:

- **SAMMO** if you have labeled eval data, you can afford LM-sampled
  candidate evaluation at compile time, and you want to *find* a prompt
  in a large space.
- **`promptc`** if you want to *transform* an existing prompt without
  changing its empirically-observed behavior, with a reproducible,
  auditable pipeline.

### DSPy

`stanfordnlp/dspy` (Khattab et al., 2023) owns the word "compiler" in the
LLM space. Its `compile()` method runs a *teacher* LM on every training
example, collects successful traces, and binds them as few-shot
demonstrations into a *student* program.

DSPy is **stochastic** and **LM-in-the-loop**:

- Teacher and student are LMs; outputs vary run-to-run.
- Requires labeled training data.
- Output of `compile()` depends on the teacher's specific outputs that day.

`promptc` is **static, deterministic, LM-free, training-data-free**:

- No teacher, no student, no training set.
- Compile is a one-shot transformation of the prompt's structure.
- The same input bytes always compile to the same output bytes.

DSPy and `promptc` are not direct competitors. They live at different
layers of the stack:

- DSPy compiles **pipelines** (multi-call LM programs).
- `promptc` compiles **one prompt** (the unit of one LM call).

A natural composition: use `promptc` to compile each prompt that a DSPy
module's predict / cot / etc. step would issue, before DSPy executes the
program.

### LLMLingua / LongLLMLingua / LLMLingua-2

The LLMLingua family (Jiang et al., Microsoft) is the dominant
**prompt-compression** family. Its differentiation is a *learned* token-
classification or self-information scoring model that drops low-information
tokens to fit a budget.

The framing difference is the load-bearing one:

- **LLMLingua compresses.** It drops information by design. The optimum
  target is long contexts (RAG, multi-document QA) where the cost-quality
  tradeoff is favourable.
- **`promptc` does not compress.** Cost reduction is a byproduct of
  structural simplification — dead instructions, redundant examples,
  verbose phrasing. The framing is *equivalence within tolerance*, not
  *lossy approximation within tolerance*.

The two are complementary at the boundary:

- If your prompt is a 100k-token RAG context, LLMLingua is the right tool.
- If your prompt is a 1k-token instruction prompt with verbose phrasing
  and redundant few-shots, `promptc` is the right tool.

A pipeline that uses both: `promptc` first (rule-based, deterministic),
then LLMLingua on the remainder (learned, budget-aware).

### ctxray / reprompt-cli

`reprompt-dev/reprompt` is the closest **(Deterministic, LM-free)** neighbor.
It is a regex-based rewriter scoped to AI-coding session prompts.

Differentiation:

- **No typed IR.** ctxray rewrites strings; `promptc` rewrites a typed
  prompt tree.
- **No formal pass framework.** ctxray's transformations are inline; each
  `promptc` pass declares preconditions, postconditions, a determinism
  proof sketch, and a behavior-preservation argument.
- **No empirical behavior-preservation eval.** `promptc` validates every
  pass via the routerlab harness with paired-bootstrap statistical
  equivalence; ctxray does not.
- **Different scope.** ctxray targets AI-coding session prompts; `promptc`
  targets general-purpose prompts.

ctxray is the deterministic-LM-free *engineering precedent*. `promptc`
generalises that posture into a typed IR with a formal pass framework,
backed by empirical evidence on crisp eval tasks.

## Why the (Deterministic, LM-free) quadrant matters

In production systems, prompt optimization that calls an LM at compile time
has three structural problems:

1. **Cost.** Compile time pays the same dollar-per-call price as run time.
2. **Latency.** Compile time becomes minutes or hours, not milliseconds.
3. **Non-reproducibility.** Compiling the same prompt twice may produce
   different output. That breaks caching, breaks diffing, and turns
   regression debugging into a guessing game.

Determinism preserves the engineering posture that compilers in every other
domain enjoy: same source bytes + same compiler version = same artifact.
This is the property `promptc` cares about most. Everything else — the
passes, the IR, the eval methodology — is in service of it.

## Where `promptc` is **not** the right tool

- **You want to search for a better prompt in a large space.** Use SAMMO or
  DSPy. `promptc` only rewrites the prompt you give it.
- **You have a 100k-token RAG context to compress.** Use LLMLingua-2.
  `promptc` operates on the structural level; it does not score and drop
  tokens.
- **You want LLM-driven rewriting from natural-language feedback.** Use
  OpenAI Prompt Optimizer, MLflow Prompt Opt, or DSPy. `promptc` never
  calls an LM at compile time.
- **You want a prompt-versioning / observability platform.** Use Agenta,
  LangSmith, Promptfoo, Helicone. `promptc` is a transformation library;
  it composes underneath those platforms.
- **You want continuous-prefix-tuning or soft-prompt training.** Use
  AutoCompressors or any tuning runtime. `promptc` never touches model
  weights, embeddings, or continuous vectors.
- **Generative tasks (free-form summarization, story generation).** These
  are explicitly out of scope for the v0.x behavior-preservation evidence
  set. The compile path will still run, but the empirical evidence
  underwriting "same behavior, fewer tokens" only exists for crisp eval
  tasks (classification, extractive QA).
