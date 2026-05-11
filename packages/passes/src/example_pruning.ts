// packages/passes/src/example_pruning.ts
//
// Pass: example_pruning_by_mutual_info
//
// Removes few-shot examples that are statistically redundant with respect to
// other examples in the same prompt. The "mutual information" estimate is a
// deterministic, closed-form proxy — no learned model, no LM call:
//
//   pairwise_jaccard(a, b)
//     = |tokens(a.input) ∩ tokens(b.input)| / |tokens(a.input) ∪ tokens(b.input)|
//   redundancy(a) = max_{b != a} pairwise_jaccard(a, b)
//
// We then cluster examples using `redundancy >= threshold` as the union-find
// edge predicate (clusters are connected components). Within each cluster of
// size > 1, we retain a single representative — the example with the longest
// output (ties broken by lexicographic `id` order). Singleton clusters are
// retained as-is. Examples whose input is empty after tokenization are
// always retained (they form their own singleton clusters).
//
// ## Preconditions
//
//   1. `ir.examples.length >= 2`. (Cannot prune from one or zero.)
//
// ## Postcondition
//
//   - Returned IR's example set is a subset of the input IR's example set.
//   - For every pair `(a, b)` of retained examples that came from different
//     input-side clusters, `pairwise_jaccard(a, b) < threshold` — modulo
//     equivalence-class representatives, because the retained example from
//     cluster C may still have pairwise Jaccard ≥ threshold with examples
//     that were *dropped* from C. Within retained examples from *distinct*
//     clusters, pairwise Jaccard < threshold by construction of clustering.
//   - The set of slot ids referenced by retained examples is a subset of the
//     original set; the pass does NOT add slot references.
//   - `section.exampleRefs` is updated to drop ids of removed examples.
//
// ## Determinism proof sketch
//
// Jaccard similarity is closed-form integer/rational arithmetic over IR
// fields. Tokenization is byte-deterministic (see `tokenize`). Union-find
// merges edges in a deterministic order: pairs `(i, j)` with `i < j` in the
// IR's stored example order. Tie-breaking for cluster representative is by
// (output-length desc, id asc) — both totally-ordered. No randomness, no
// I/O.
//
// ## Behavior-preservation argument
//
// Redundant examples — examples with high input-side token overlap — by
// hypothesis add little new disambiguating signal to the model. For crisp
// eval tasks (classification, extractive QA) this is the standard
// few-shot-curation finding (DESIGN.md §4.2). Empirical validity is checked
// per-pass on the routerlab harness; the regression record lives in
// `eval/regression/regressions.json`.

import type { Example, PromptIR, Section } from "@promptc/ir";

import type {
  Pass,
  PassOptions,
  PassPreconditionResult,
  PassResult,
} from "./_types.js";

const PASS_NAME = "example_pruning_by_mutual_info";
const DEFAULT_REDUNDANCY_THRESHOLD = 0.8;

/** Same normalize/tokenize implementation as dead_instruction, copied here to
 *  keep each pass module self-contained (passes are individually importable
 *  per the package contract). */
function normalize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if ((ch >= 48 && ch <= 57) || (ch >= 97 && ch <= 122)) {
      out += text[i];
    } else if (ch >= 65 && ch <= 90) {
      out += String.fromCharCode(ch + 32);
    } else {
      out += " ";
    }
  }
  return out;
}

function tokenSet(text: string): Set<string> {
  const norm = normalize(text);
  const out = new Set<string>();
  for (const t of norm.split(" ")) {
    if (t.length >= 2) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  // Iterate the smaller for fewer membership tests.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/** Minimal deterministic union-find. */
class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];
  constructor(n: number) {
    this.parent = new Array<number>(n);
    this.rank = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.rank[i] = 0;
    }
  }
  find(x: number): number {
    let cur = x;
    // Two-pass path compression for determinism without recursion.
    while (this.parent[cur] !== cur) {
      cur = this.parent[cur] as number;
    }
    let walk = x;
    while (this.parent[walk] !== cur) {
      const next = this.parent[walk] as number;
      this.parent[walk] = cur;
      walk = next;
    }
    return cur;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank[ra] as number;
    const rankB = this.rank[rb] as number;
    if (rankA < rankB) {
      this.parent[ra] = rb;
    } else if (rankA > rankB) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] = rankA + 1;
    }
  }
}

function preconditions(ir: PromptIR): PassPreconditionResult {
  const reasons: string[] = [];
  if (ir.examples.length < 2) {
    reasons.push("ir.examples.length < 2");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Update each section's exampleRefs to drop removed ids. Pure. */
function reproject(
  sections: ReadonlyArray<Section>,
  removedIds: ReadonlySet<string>,
): Section[] {
  if (removedIds.size === 0) return sections.slice();
  const out: Section[] = [];
  for (const s of sections) {
    let changed = false;
    const refs: string[] = [];
    for (const id of s.exampleRefs) {
      if (removedIds.has(id)) {
        changed = true;
      } else {
        refs.push(id);
      }
    }
    if (changed) {
      out.push({ ...s, exampleRefs: refs });
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Estimate dropped tokens: whitespace-split count over removed input+output. */
function estimateDroppedTokens(removed: ReadonlyArray<Example>): number {
  let n = 0;
  for (const ex of removed) {
    for (const p of ex.input.split(/\s+/)) if (p.length > 0) n += 1;
    for (const p of ex.output.split(/\s+/)) if (p.length > 0) n += 1;
  }
  return n;
}

function run(ir: PromptIR, opts?: PassOptions): PassResult {
  const pre = preconditions(ir);
  if (!pre.ok) {
    return {
      ir,
      applied: false,
      reason: pre.reasons.join("; "),
    };
  }

  const threshold = opts?.exampleRedundancyThreshold ?? DEFAULT_REDUNDANCY_THRESHOLD;
  if (threshold <= 0 || threshold > 1) {
    return {
      ir,
      applied: false,
      reason: `exampleRedundancyThreshold out of range (0, 1]: ${threshold}`,
    };
  }

  const examples = ir.examples;
  const n = examples.length;
  const tokens: Set<string>[] = new Array<Set<string>>(n);
  for (let i = 0; i < n; i++) {
    const ex = examples[i];
    if (!ex) continue;
    tokens[i] = tokenSet(ex.input);
  }

  // Build clusters via union-find over pairs with Jaccard ≥ threshold.
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    const ti = tokens[i];
    if (!ti || ti.size === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const tj = tokens[j];
      if (!tj || tj.size === 0) continue;
      if (jaccard(ti, tj) >= threshold) {
        uf.union(i, j);
      }
    }
  }

  // Group example indices by cluster root, preserving insertion order.
  const clusters = new Map<number, number[]>();
  const rootOrder: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const existing = clusters.get(r);
    if (existing) {
      existing.push(i);
    } else {
      clusters.set(r, [i]);
      rootOrder.push(r);
    }
  }

  // Pick a representative for each cluster. Singletons keep their member.
  // For size > 1: max output length, ties broken by lex-min id, then lex-min
  // index.
  const keptIndices = new Set<number>();
  for (const root of rootOrder) {
    const members = clusters.get(root);
    if (!members || members.length === 0) continue;
    if (members.length === 1) {
      const m0 = members[0];
      if (m0 !== undefined) keptIndices.add(m0);
      continue;
    }
    let bestIdx = -1;
    let bestLen = -1;
    let bestId = "";
    for (const idx of members) {
      const ex = examples[idx];
      if (!ex) continue;
      const len = ex.output.length;
      if (
        len > bestLen ||
        (len === bestLen && (bestId === "" || ex.id < bestId))
      ) {
        bestIdx = idx;
        bestLen = len;
        bestId = ex.id;
      }
    }
    if (bestIdx !== -1) keptIndices.add(bestIdx);
  }

  // Walk original order to build retained list and removed list.
  const retained: Example[] = [];
  const removed: Example[] = [];
  for (let i = 0; i < n; i++) {
    const ex = examples[i];
    if (!ex) continue;
    if (keptIndices.has(i)) {
      retained.push(ex);
    } else {
      removed.push(ex);
    }
  }

  if (removed.length === 0) {
    return {
      ir,
      applied: false,
      reason: "no redundant examples above threshold",
      debug: {
        threshold,
        clusters: rootOrder.length,
        examples: n,
        retained: retained.length,
      },
    };
  }

  const removedIds = new Set<string>();
  for (const r of removed) removedIds.add(r.id);

  const nextIR: PromptIR = {
    ...ir,
    sections: reproject(ir.sections, removedIds),
    examples: retained,
  };

  return {
    ir: nextIR,
    applied: true,
    reason: "",
    droppedTokens: estimateDroppedTokens(removed),
    debug: {
      threshold,
      examples: n,
      clusters: rootOrder.length,
      retained: retained.length,
      removed: removed.length,
      removedIds: removed.map((r) => r.id),
    },
  };
}

export const examplePruningByMutualInfo: Pass = {
  name: PASS_NAME,
  preconditions,
  run,
};

export default examplePruningByMutualInfo;
