// @promptc/passes — deterministic, LM-free optimization passes for the
// promptc IR. Each pass is documented in DESIGN.md §4.
//
// Exports:
//   - `Pass`, `PassOptions`, `PassResult`, `PassPreconditionResult` —
//     the local pass contract (see ./_types.ts).
//   - `deadInstructionElimination`            — DESIGN.md §4.1.
//   - `examplePruningByMutualInfo`            — DESIGN.md §4.2.
//   - `formatCollapse`                        — DESIGN.md §4.3.
//   - `whitespaceRedundancyStrip`             — DESIGN.md §4.4.
//   - `vocabSimplification`                   — DESIGN.md §4.5.
//
// Passes are individually importable from their module file, e.g.
//   import { deadInstructionElimination } from "@promptc/passes/dead_instruction";
// They are also re-exported from this barrel for callers that want the full
// pass list.

export type {
  Pass,
  PassOptions,
  PassPreconditionResult,
  PassResult,
} from "./_types.js";

export {
  deadInstructionElimination,
  default as deadInstructionEliminationDefault,
} from "./dead_instruction.js";

export {
  examplePruningByMutualInfo,
  default as examplePruningByMutualInfoDefault,
} from "./example_pruning.js";

export {
  formatCollapse,
  default as formatCollapseDefault,
} from "./format_collapse.js";

export {
  whitespaceRedundancyStrip,
  default as whitespaceRedundancyStripDefault,
} from "./whitespace_redundancy.js";

export {
  vocabSimplification,
  default as vocabSimplificationDefault,
} from "./vocab_simplification.js";

export const version = "0.0.1";
