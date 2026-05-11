// packages/cli/src/pipeline.ts
//
// Drives the canonical promptc pass pipeline (DESIGN.md §4):
//   1. dead_instruction_elimination
//   2. example_pruning_by_mutual_info
//   3. format_collapse
//   4. whitespace_redundancy_strip
//   5. vocab_simplification
//
// Each pass exposes the local `Pass` contract from `@promptc/passes` (see
// `_types.ts` in that package). The CLI is the integration layer: it adapts
// the per-pass `{ applied, reason, droppedTokens?, debug? }` result into a
// `PassLogEntry` written into `ir.metadata.passLog`, and records the same
// information in a `PassRecord` for the CLI's summary printer.
//
// Passes that haven't landed yet (format_collapse, whitespace_redundancy_strip,
// vocab_simplification — Phase 3 in-flight) are tolerated: we attempt to import
// them dynamically and substitute a "stubbed" record when they don't exist.

import { appendPassLogEntry, type PromptIR } from "@promptc/ir";

/**
 * A pass record for the CLI summary. Strictly a CLI-internal type — not part
 * of any public package contract.
 */
export interface PassRecord {
  name: string;
  description: string;
  applied: boolean;
  /** Reason for skip / no-op. Empty when `applied === true`. */
  skipReason: string;
  /** True iff the pass refused to run due to its declared preconditions. */
  preconditionFailure: boolean;
  /** Token-drop estimate (whitespace-tokenized proxy), if the pass reports one. */
  droppedTokens?: number;
  /** Compile-time wall ms for the pass invocation. */
  durationMs: number;
  /** True when no pass implementation was found in `@promptc/passes`. */
  stubbed: boolean;
}

export interface RunPipelineOptions {
  target: "cost" | "tokens" | "none";
  /** Explicit pass list (overrides defaults). */
  passes?: string[];
  /** Hard cap on total mutations across all passes. */
  maxMutations?: number;
}

export interface RunPipelineOutcome {
  ir: PromptIR;
  records: PassRecord[];
  mutationCap: number | null;
}

/**
 * Local pass-shape we expect from `@promptc/passes`. We do not import the
 * type directly to keep the CLI loosely coupled to the passes package's
 * pre-1.0 churn — the structural shape below is the integration contract.
 */
interface ImportedPass {
  readonly name: string;
  preconditions(ir: PromptIR): { ok: boolean; reasons?: string[]; reason?: string };
  run(
    ir: PromptIR,
    opts?: Record<string, unknown>,
  ): {
    ir: PromptIR;
    applied: boolean;
    reason: string;
    droppedTokens?: number;
    debug?: Record<string, unknown>;
  };
}

interface PassEntry {
  name: string;
  description: string;
  impl: ImportedPass | null;
}

const PASS_ORDER: { name: string; description: string }[] = [
  {
    name: "dead_instruction_elimination",
    description: "Drop instructions not referenced by output schema, examples, or peers.",
  },
  {
    name: "example_pruning_by_mutual_info",
    description: "Drop few-shot examples redundant by token-overlap with retained peers.",
  },
  {
    name: "format_collapse",
    description: "Collapse verbose markdown/XML formatting where whitespace-insensitive.",
  },
  {
    name: "whitespace_redundancy_strip",
    description: "Trim trailing whitespace, collapse blank-line runs, strip filler openers.",
  },
  {
    name: "vocab_simplification",
    description: "Rewrite verbose phrases to short equivalents from a curated map.",
  },
];

let cachedRegistry: PassEntry[] | null = null;

// Static import. The CLI is tolerant of missing exports — it probes the
// namespace below to handle the case where a sibling pass implementation
// hasn't landed yet (Phase 3 in-flight).
import * as PASSES_MODULE_NS from "@promptc/passes";
const PASSES_MODULE: Record<string, unknown> = PASSES_MODULE_NS as unknown as Record<
  string,
  unknown
>;

/**
 * Resolve the full pass registry. Tolerates missing exports — the CLI must
 * work even if some passes haven't landed yet.
 */
function getRegistry(): PassEntry[] {
  if (cachedRegistry) return cachedRegistry;
  const out: PassEntry[] = [];
  for (const entry of PASS_ORDER) {
    const impl = pickPass(PASSES_MODULE, entry.name);
    out.push({ name: entry.name, description: entry.description, impl });
  }
  cachedRegistry = out;
  return out;
}

/**
 * Translate a kebab-case pass name to the camelCase export and look it up
 * inside the imported passes module. Returns `null` if missing.
 */
function pickPass(mod: Record<string, unknown>, name: string): ImportedPass | null {
  const candidates = [
    toCamel(name),
    `${toCamel(name)}Default`,
    toPascal(name),
    name,
  ];
  for (const key of candidates) {
    const val = mod[key];
    if (isImportedPass(val)) return val;
  }
  return null;
}

function toCamel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}
function toPascal(s: string): string {
  const camel = toCamel(s);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function isImportedPass(val: unknown): val is ImportedPass {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.run === "function" &&
    typeof obj.preconditions === "function"
  );
}

/**
 * Public: enumerate every pass with its description and resolved implementation
 * status. Used by `promptc passes` and `promptc explain`.
 */
export interface PassListEntry {
  name: string;
  description: string;
  impl: ImportedPass | null;
}

export function listAllPasses(): PassListEntry[] {
  return getRegistry().map((e) => ({
    name: e.name,
    description: e.description,
    impl: e.impl,
  }));
}

/**
 * Execute the pipeline. Returns the final IR plus per-pass records.
 *
 * - When `opts.passes` is supplied, those passes run *in the given order*. If a
 *   requested name isn't recognised, it is logged as a record with
 *   `stubbed=true, applied=false, skipReason="unknown pass"` — the CLI surfaces
 *   that as exit code 3.
 * - When omitted, the default DESIGN.md §4 order is used, but passes whose
 *   target is "none" still run — `target` only affects future pass selection;
 *   today every pass is unconditionally beneficial for cost and tokens.
 */
export function runPipeline(ir: PromptIR, opts: RunPipelineOptions): RunPipelineOutcome {
  const registry = getRegistry();
  const order =
    opts.passes && opts.passes.length > 0
      ? opts.passes
          .map((requested) => {
            const known = registry.find((e) => e.name === requested);
            if (known) return known;
            // Synthesize an "unknown" entry that records as stubbed.
            return { name: requested, description: "(unknown)", impl: null } satisfies PassEntry;
          })
      : registry;

  const cap = opts.maxMutations ?? null;
  let mutationsRemaining = cap;
  const records: PassRecord[] = [];

  let current = ir;
  for (const entry of order) {
    if (cap !== null && mutationsRemaining !== null && mutationsRemaining <= 0) {
      records.push({
        name: entry.name,
        description: entry.description,
        applied: false,
        skipReason: "mutation cap reached",
        preconditionFailure: false,
        durationMs: 0,
        stubbed: entry.impl === null,
      });
      current = appendPassLogEntry(current, {
        pass: entry.name,
        applied: false,
        skipReason: "mutation cap reached",
      });
      continue;
    }
    if (entry.impl === null) {
      records.push({
        name: entry.name,
        description: entry.description,
        applied: false,
        skipReason: "pass not implemented",
        preconditionFailure: false,
        durationMs: 0,
        stubbed: true,
      });
      current = appendPassLogEntry(current, {
        pass: entry.name,
        applied: false,
        skipReason: "pass not implemented",
      });
      continue;
    }
    const start = Date.now();
    const pre = entry.impl.preconditions(current);
    if (!pre.ok) {
      const reasonText = pre.reasons?.join("; ") ?? pre.reason ?? "preconditions not met";
      const duration = Date.now() - start;
      records.push({
        name: entry.name,
        description: entry.description,
        applied: false,
        skipReason: reasonText,
        preconditionFailure: true,
        durationMs: duration,
        stubbed: false,
      });
      current = appendPassLogEntry(current, {
        pass: entry.name,
        applied: false,
        skipReason: reasonText,
        durationMs: duration,
      });
      continue;
    }
    const result = entry.impl.run(current);
    const duration = Date.now() - start;
    if (result.applied) {
      // Count any change as a "mutation" against the cap, using nodes-delta as
      // a conservative proxy. We track mutations only if the cap is set.
      const beforeNodes =
        current.sections.length +
        current.slots.length +
        current.examples.length +
        current.instructions.length;
      const afterNodes =
        result.ir.sections.length +
        result.ir.slots.length +
        result.ir.examples.length +
        result.ir.instructions.length;
      const delta = Math.max(1, Math.abs(beforeNodes - afterNodes));
      if (mutationsRemaining !== null) mutationsRemaining -= delta;
      current = appendPassLogEntry(result.ir, {
        pass: entry.name,
        applied: true,
        nodesChanged: delta,
        durationMs: duration,
      });
      records.push({
        name: entry.name,
        description: entry.description,
        applied: true,
        skipReason: "",
        preconditionFailure: false,
        droppedTokens: result.droppedTokens,
        durationMs: duration,
        stubbed: false,
      });
    } else {
      current = appendPassLogEntry(current, {
        pass: entry.name,
        applied: false,
        skipReason: result.reason || "no-op",
        durationMs: duration,
      });
      records.push({
        name: entry.name,
        description: entry.description,
        applied: false,
        skipReason: result.reason || "no-op",
        preconditionFailure: false,
        durationMs: duration,
        stubbed: false,
      });
    }
  }

  return { ir: current, records, mutationCap: cap };
}
