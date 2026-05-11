// packages/passes/src/dead_instruction.ts
//
// Pass: dead_instruction_elimination
//
// Removes `Instruction` nodes that are not referenced by anything that
// matters for the prompt's rendered output: the output schema, the retained
// examples, or any other retained instruction. Conservatively preserves any
// instruction marked `kind: "required"` regardless of references, and (by
// default) preserves `kind: "style"` instructions per DESIGN.md §4.1's
// behavior-preservation rule.
//
// ## Preconditions
//
//   1. `ir.instructions.length >= 1`. (Nothing to do otherwise.)
//   2. `ir.output_schema !== null` OR `ir.examples.length >= 1`. (Without
//      either, "reference set" is empty, and we cannot decide what is dead;
//      conservatively skip.)
//
// ## Postcondition
//
// For every remaining instruction `I` after the pass either:
//   - `I.kind === "required"`, OR
//   - `isReferenced(I, ir)` returns `true` (see implementation), where
//     "referenced" means at least one of:
//       a. `I.refersToFields` overlaps the field-name set of
//          `output_schema.root` (transitive over object / array shapes).
//       b. `I.slotRefs` intersects the slot-ref set of any example or any
//          `appearsIn` link of the output schema's slots.
//       c. `I.text` (case-insensitive, tokenized) contains a token that
//          appears in any retained example's input/output OR in any output-
//          schema field name.
//
// ## Determinism proof sketch
//
// The pass is a pure function of `ir`. Reference detection uses only
// IR-internal data. The reference set is computed once. Instructions are
// iterated in stored (parse) order. The retention predicate has no I/O, no
// RNG, no clock, no LM. Same input bytes → same output bytes.
//
// ## Behavior-preservation argument
//
// A `kind: "optional" | "format"` instruction that the schema, examples, and
// retained instructions all fail to reference is, by hypothesis, not load-
// bearing on the rendered output. `kind: "required"` and `kind: "style"`
// instructions are conservatively retained: the former because the author
// explicitly marked them mandatory, the latter because style affects
// character even without explicit reference (DESIGN.md §4.1). The empirical
// validity of this rule for crisp eval tasks (classification, extractive QA)
// is the load-bearing eval claim in `eval/regression/`.

import type {
  Example,
  Instruction,
  OutputSchema,
  PromptIR,
  SchemaField,
  Section,
} from "@promptc/ir";

import type {
  Pass,
  PassOptions,
  PassPreconditionResult,
  PassResult,
} from "./_types.js";

const PASS_NAME = "dead_instruction_elimination";

/** ASCII-lowercase + replace non-alnum with a single space. Deterministic. */
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

/** Tokenize on whitespace; drop short tokens (length < 2). */
function tokenize(text: string): string[] {
  const norm = normalize(text);
  const toks: string[] = [];
  for (const t of norm.split(" ")) {
    if (t.length >= 2) toks.push(t);
  }
  return toks;
}

/**
 * Collect every field name in a schema, recursively into objects + arrays.
 * Returns the set in insertion order for stable iteration (though we use it
 * as a membership oracle here).
 */
function collectFieldNames(field: SchemaField | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!field) return out;
  const stack: SchemaField[] = [field];
  while (stack.length > 0) {
    const f = stack.pop();
    if (!f) continue;
    out.add(f.name);
    if (f.fields) {
      for (const sub of f.fields) stack.push(sub);
    }
    if (f.items) {
      stack.push(f.items);
    }
  }
  return out;
}

/** Token set for a single example (input + output, normalized + tokenized). */
function exampleTokens(ex: Example): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(ex.input)) out.add(t);
  for (const t of tokenize(ex.output)) out.add(t);
  if (ex.rationale) {
    for (const t of tokenize(ex.rationale)) out.add(t);
  }
  return out;
}

/** Build the reference set used to test instruction reachability. */
interface ReferenceSet {
  /** Output-schema field names (full recursive collection). */
  schemaFieldNames: Set<string>;
  /** Union of every example's tokenized input/output/rationale. */
  exampleTokens: Set<string>;
  /** Union of slot ids referenced by any example. */
  exampleSlotIds: Set<string>;
  /** Tokenized schema field names — for token-level text matching. */
  schemaFieldNameTokens: Set<string>;
}

function buildReferenceSet(
  examples: ReadonlyArray<Example>,
  schema: OutputSchema | null,
): ReferenceSet {
  const schemaFieldNames =
    schema && schema.root ? collectFieldNames(schema.root) : new Set<string>();
  const schemaFieldNameTokens = new Set<string>();
  for (const n of schemaFieldNames) {
    for (const t of tokenize(n)) schemaFieldNameTokens.add(t);
  }
  const exTokens = new Set<string>();
  const exSlotIds = new Set<string>();
  for (const ex of examples) {
    for (const t of exampleTokens(ex)) exTokens.add(t);
    for (const sid of ex.slotRefs) exSlotIds.add(sid);
  }
  return {
    schemaFieldNames,
    exampleTokens: exTokens,
    exampleSlotIds: exSlotIds,
    schemaFieldNameTokens,
  };
}

/**
 * Decide whether `instr` is referenced by the reference set. Conservative:
 * any single match returns `true`.
 */
function isReferenced(instr: Instruction, refs: ReferenceSet): boolean {
  // (a) refersToFields overlaps schema field names.
  for (const fname of instr.refersToFields) {
    if (refs.schemaFieldNames.has(fname)) return true;
  }
  // (b) slotRefs overlap example slot refs.
  for (const sid of instr.slotRefs) {
    if (refs.exampleSlotIds.has(sid)) return true;
  }
  // (c) text-token overlap with schema field names OR example tokens.
  for (const tok of tokenize(instr.text)) {
    if (refs.schemaFieldNameTokens.has(tok)) return true;
    if (refs.exampleTokens.has(tok)) return true;
  }
  return false;
}

/** Estimate dropped tokens as whitespace-tokenized count of removed text. */
function estimateDroppedTokens(removed: ReadonlyArray<Instruction>): number {
  let n = 0;
  for (const i of removed) {
    // Cheap whitespace-split count; not authoritative.
    const parts = i.text.split(/\s+/);
    for (const p of parts) if (p.length > 0) n += 1;
  }
  return n;
}

/** Update `section.instructionRefs` to drop removed ids. Pure: returns new array. */
function reproject(
  sections: ReadonlyArray<Section>,
  removedIds: ReadonlySet<string>,
): Section[] {
  if (removedIds.size === 0) {
    return sections.slice();
  }
  const out: Section[] = [];
  for (const s of sections) {
    let changed = false;
    const refs: string[] = [];
    for (const id of s.instructionRefs) {
      if (removedIds.has(id)) {
        changed = true;
      } else {
        refs.push(id);
      }
    }
    if (changed) {
      out.push({ ...s, instructionRefs: refs });
    } else {
      out.push(s);
    }
  }
  return out;
}

function preconditions(ir: PromptIR): PassPreconditionResult {
  const reasons: string[] = [];
  if (ir.instructions.length < 1) {
    reasons.push("ir.instructions is empty");
  }
  if (ir.output_schema === null && ir.examples.length === 0) {
    reasons.push("no output_schema and no examples to anchor reference analysis");
  }
  return { ok: reasons.length === 0, reasons };
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

  const removeStyle = opts?.removeStyleInstructions === true;
  const refs = buildReferenceSet(ir.examples, ir.output_schema);

  const kept: Instruction[] = [];
  const removed: Instruction[] = [];
  for (const instr of ir.instructions) {
    if (instr.kind === "required") {
      kept.push(instr);
      continue;
    }
    if (instr.kind === "style" && !removeStyle) {
      kept.push(instr);
      continue;
    }
    if (isReferenced(instr, refs)) {
      kept.push(instr);
    } else {
      removed.push(instr);
    }
  }

  if (removed.length === 0) {
    return {
      ir,
      applied: false,
      reason: "no dead instructions found",
      debug: {
        candidates: ir.instructions.length,
        kept: kept.length,
        removed: 0,
      },
    };
  }

  const removedIds = new Set<string>();
  for (const r of removed) removedIds.add(r.id);

  const nextIR: PromptIR = {
    ...ir,
    sections: reproject(ir.sections, removedIds),
    instructions: kept,
  };

  return {
    ir: nextIR,
    applied: true,
    reason: "",
    droppedTokens: estimateDroppedTokens(removed),
    debug: {
      candidates: ir.instructions.length,
      kept: kept.length,
      removed: removed.length,
      removedIds: removed.map((r) => r.id),
    },
  };
}

export const deadInstructionElimination: Pass = {
  name: PASS_NAME,
  preconditions,
  run,
};

export default deadInstructionElimination;
