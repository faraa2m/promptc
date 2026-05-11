// eval/regression/optimize.ts — adapter from `OptimizeFn` to promptc internals.
//
// The regression orchestrator (`runner.ts`) does not depend on
// `@promptc/*` directly — it accepts an injected `OptimizeFn` so tests can
// supply mocks. This file provides the production wiring: `promptcOptimize`
// runs the canonical promptc pipeline (parse -> default pass order ->
// codegen) over the corpus prompt and returns the optimized string plus
// the list of passes that actually applied.
//
// Why isolate this? The pipeline pulls in `@promptc/parser`,
// `@promptc/passes`, and `@promptc/codegen`. Keeping the dependency
// surface here means the build orchestrator stays unit-testable with zero
// workspace imports.

import { parseAuto } from "../../packages/parser/src/index.ts";
import { codegen } from "../../packages/codegen/src/index.ts";
import {
  deadInstructionElimination,
  examplePruningByMutualInfo,
  formatCollapse,
  whitespaceRedundancyStrip,
  vocabSimplification,
} from "../../packages/passes/src/index.ts";
import {
  appendPassLogEntry,
  type PromptIR,
} from "../../packages/ir/src/index.ts";

import type { OptimizeFn } from "./runner.ts";

/**
 * Local mirror of the pass shape we consume from `@promptc/passes`. We
 * import the concrete passes above for compile-time linkage, but the
 * pipeline loop below uses this structural type so swapping pass
 * implementations doesn't churn this file.
 */
interface PipelinePass {
  readonly name: string;
  preconditions(ir: PromptIR): { ok: boolean; reasons?: string[]; reason?: string };
  run(ir: PromptIR): {
    ir: PromptIR;
    applied: boolean;
    reason: string;
    droppedTokens?: number;
  };
}

/**
 * Canonical pass order (DESIGN.md §4). The regression harness exercises
 * the full default pipeline because that is the configuration the paper
 * carries.
 */
const DEFAULT_PASSES: readonly PipelinePass[] = [
  deadInstructionElimination as PipelinePass,
  examplePruningByMutualInfo as PipelinePass,
  formatCollapse as PipelinePass,
  whitespaceRedundancyStrip as PipelinePass,
  vocabSimplification as PipelinePass,
];

/**
 * Production-mode optimizer adapter. Parses the source as plain text (the
 * regression corpus prompts are bare strings rendered by routerlab-style
 * templates — they have no markdown headings), runs the full default
 * pipeline, then emits plain text again so the optimized output is
 * directly comparable to the input as a model prompt.
 *
 * If any pass throws unexpectedly, the optimizer rethrows — the harness
 * catches per-prompt errors and records them in the outcome.
 */
export const promptcOptimize: OptimizeFn = async ({ source }) => {
  // parseAuto picks markdown / xml / plain based on a content heuristic.
  // For QA / classification regression prompts, this resolves to "plain".
  let ir = parseAuto(source);

  const applied: string[] = [];
  for (const pass of DEFAULT_PASSES) {
    const pre = pass.preconditions(ir);
    if (!pre.ok) {
      ir = appendPassLogEntry(ir, {
        pass: pass.name,
        applied: false,
        skipReason:
          pre.reasons?.join("; ") ?? pre.reason ?? "preconditions not met",
      });
      continue;
    }
    const result = pass.run(ir);
    if (result.applied) {
      applied.push(pass.name);
      ir = appendPassLogEntry(result.ir, {
        pass: pass.name,
        applied: true,
      });
    } else {
      ir = appendPassLogEntry(ir, {
        pass: pass.name,
        applied: false,
        skipReason: result.reason || "no-op",
      });
    }
  }

  // Emit plain text — same surface format the corpus uses for input.
  const optimized = codegen(ir, { to: "plain" });
  return { optimized, passesApplied: applied };
};
