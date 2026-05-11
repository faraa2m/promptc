// packages/passes/src/_types.ts
//
// Local pass contract for the `@promptc/passes` package.
//
// This contract differs from the canonical `Pass` / `PassResult` types in
// `@promptc/ir` (DESIGN.md §3.1) in two intentional ways:
//
//   1. Pass entrypoint is `run(ir, opts?)` rather than `apply(ir)` — passes in
//      this package take a per-pass `PassOptions` for thresholds and tuning
//      knobs. The default-options call site (`run(ir)`) is what the pipeline
//      invokes; explicit options are for tests and callers that want to
//      override defaults without mutating module state.
//   2. `PassResult` carries `applied` + `reason` + optional `droppedTokens`
//      and `debug` payload, instead of `nodesChanged` + `diagnostics`. The
//      pipeline driver (Phase 3 codegen/cli) is responsible for mapping
//      between this local shape and `PassLogEntry` when extending
//      `metadata.passLog`.
//
// The local contract is intentionally narrow: no IO, no side effects, no
// mutation of the input IR. Implementations MUST return a fresh `PromptIR`
// whenever `applied === true`, and MUST return the input IR by reference
// whenever `applied === false`.

import type { PromptIR } from "@promptc/ir";

/** Per-pass tuning knobs. Each pass picks its relevant subset. */
export interface PassOptions {
  /**
   * Jaccard redundancy threshold for `example_pruning_by_mutual_info`.
   * Two examples with pairwise Jaccard ≥ threshold are clustered as
   * redundant. Default 0.8.
   */
  exampleRedundancyThreshold?: number;
  /**
   * When `true`, `dead_instruction_elimination` also removes instructions of
   * kind "style". Default `false` (style instructions are preserved per the
   * DESIGN.md §4.1 behavior-preservation rule).
   */
  removeStyleInstructions?: boolean;
}

/** Result of a single pass invocation. */
export interface PassResult {
  /**
   * Resulting IR. If `applied === false`, this is the input IR reference
   * (the pass did nothing).
   */
  ir: PromptIR;
  /**
   * `true` iff the pass ran and produced a (possibly identical-by-value) new
   * IR. `false` means preconditions failed or there was nothing to change.
   */
  applied: boolean;
  /**
   * Human-readable reason. Empty string when `applied === true` and the pass
   * completed without notable diagnostics; otherwise carries the skip /
   * no-op reason.
   */
  reason: string;
  /**
   * Optional estimate of tokens dropped by the pass, using a whitespace-
   * tokenization proxy. Not authoritative — the canonical cost evidence is
   * produced by the eval harness using llm-tokens-atlas counts (DESIGN.md
   * §6.6). This is informational only.
   */
  droppedTokens?: number;
  /**
   * Optional structured debug payload. Stable per pass — passes document
   * their `debug` shape in their module's source. Useful for tests and the
   * `--explain` CLI surface.
   */
  debug?: Record<string, unknown>;
}

/** Pass preconditions result. */
export interface PassPreconditionResult {
  ok: boolean;
  reasons: string[];
}

/** A single deterministic, LM-free optimization pass. */
export interface Pass {
  /** Stable kebab-case identifier — matches DESIGN.md §4 pass names. */
  readonly name: string;
  /**
   * Cheap precondition check. Pure function of the IR. The pipeline calls
   * this before `run` and skips the pass if `ok === false`.
   */
  preconditions(ir: PromptIR): PassPreconditionResult;
  /**
   * Run the pass. MUST be a pure function of `(ir, opts)`. MUST NOT mutate
   * the input IR. MUST return the input IR reference when `applied === false`.
   */
  run(ir: PromptIR, opts?: PassOptions): PassResult;
}
