// packages/parser/src/slots.ts
//
// Slot extraction from a body of text. Recognises `{{ name }}` placeholders
// with an optional inline type annotation:
//
//     {{ user_name }}                          -> string slot named "user_name"
//     {{ count : number }}                     -> number slot
//     {{ verbose : boolean = false }}          -> boolean slot, default "false"
//     {{ data : json }}                        -> json slot
//     {{ mode : enum = small | medium | large }} -> enum slot, four values, default
//                                                 the first listed
//     {{ severity : enum [low | medium | high] }} -> enum slot, no default
//
// The mustache-like brace form `{{ ... }}` is the canonical surface — any
// content between `{{` and `}}` is interpreted as a slot reference. The
// extractor is intentionally permissive: an unparseable inner body falls
// back to a plain string slot whose `name` is the trimmed inner body. The
// caller decides whether the resulting slot is valid (currently every
// shape is accepted; the parser itself rejects nothing here).
//
// Determinism: the regex scan is left-to-right and stable. Slot ids are
// allocated through the shared `IdAllocator`, so the same source always
// produces the same ids in the same order.

import type { NodeId, Slot, SlotType, SourceSpan } from "@promptc/ir";

import { type IdAllocator, LineMap, makeSpan } from "./util.js";

/** One `{{ ... }}` occurrence found in the source. */
export interface SlotOccurrence {
  /** Trimmed slot name as it appeared in the source. */
  name: string;
  /** Type annotation, if any. */
  type: SlotType;
  /** Enum values, if `type==="enum"`; else null. */
  enumValues: string[] | null;
  /** Default value as written, or null. */
  default: string | null;
  /** Section node id the occurrence belongs to. */
  appearsIn: NodeId;
  /** Span of the `{{...}}` token in the source. */
  source: SourceSpan;
}

/** Regex pattern for a `{{ ... }}` slot literal. Pre-compiled, reused. */
const SLOT_PATTERN = /\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * Scan `body` (an excerpt of the original source starting at byte
 * `bodyOffset`) for slot literals. Each match is reported with full source
 * spans relative to the original source.
 */
export function findSlotOccurrences(
  body: string,
  bodyOffset: number,
  parentSectionId: NodeId,
  lineMap: LineMap,
): SlotOccurrence[] {
  const out: SlotOccurrence[] = [];
  // Reset regex state (it has the `g` flag).
  SLOT_PATTERN.lastIndex = 0;
  let match = SLOT_PATTERN.exec(body);
  while (match !== null) {
    const innerRaw = match[1] ?? "";
    const startOffset = bodyOffset + match.index;
    const endOffset = startOffset + match[0].length;
    const parsed = interpretSlotBody(innerRaw);
    out.push({
      name: parsed.name,
      type: parsed.type,
      enumValues: parsed.enumValues,
      default: parsed.default,
      appearsIn: parentSectionId,
      source: makeSpan(startOffset, endOffset, lineMap),
    });
    match = SLOT_PATTERN.exec(body);
  }
  return out;
}

interface InterpretedSlot {
  name: string;
  type: SlotType;
  enumValues: string[] | null;
  default: string | null;
}

/** Parse the contents between `{{ ` and ` }}` into a typed slot descriptor. */
function interpretSlotBody(inner: string): InterpretedSlot {
  const trimmed = inner.trim();
  if (trimmed === "") {
    // `{{ }}` is interpreted as an unnamed string slot. Callers see it as
    // a literal-looking slot they can decide to reject; we don't.
    return { name: "", type: "string", enumValues: null, default: null };
  }
  // Split off an optional `= default` tail. We respect only the first `=`
  // outside of bracket groups so that enum value lists with `=` would not
  // be miscut — but in practice enum values are simple bare words.
  const eqIndex = findTopLevelChar(trimmed, "=");
  const head = eqIndex >= 0 ? trimmed.slice(0, eqIndex).trim() : trimmed;
  const defaultValue =
    eqIndex >= 0 ? trimmed.slice(eqIndex + 1).trim() || null : null;

  // Split head into name + optional `:type` portion.
  const colonIndex = findTopLevelChar(head, ":");
  if (colonIndex < 0) {
    return {
      name: head,
      type: "string",
      enumValues: null,
      default: defaultValue,
    };
  }
  const name = head.slice(0, colonIndex).trim();
  const typeSpec = head.slice(colonIndex + 1).trim();
  return interpretTypeSpec(name, typeSpec, defaultValue);
}

/**
 * Interpret a `:type` annotation. For enum types, look for either
 * `enum = a | b | c` or `enum [ a | b | c ]` syntax.
 */
function interpretTypeSpec(
  name: string,
  typeSpec: string,
  defaultValue: string | null,
): InterpretedSlot {
  // enum [ a | b | c ]
  const bracketMatch = typeSpec.match(/^enum\s*\[([^\]]*)\]$/i);
  if (bracketMatch) {
    const values = splitEnumValues(bracketMatch[1] ?? "");
    return { name, type: "enum", enumValues: values, default: defaultValue };
  }
  // enum (followed by values pulled from the `=` tail)
  if (/^enum$/i.test(typeSpec)) {
    if (defaultValue === null) {
      return { name, type: "enum", enumValues: [], default: null };
    }
    // When written as `mode: enum = a | b | c`, the right-hand side is a
    // pipe-delimited list. The default value is the first listed.
    const values = splitEnumValues(defaultValue);
    return {
      name,
      type: "enum",
      enumValues: values,
      default: values[0] ?? null,
    };
  }
  // string | number | boolean | json
  const norm = typeSpec.toLowerCase();
  if (
    norm === "string" ||
    norm === "number" ||
    norm === "boolean" ||
    norm === "json"
  ) {
    return {
      name,
      type: norm,
      enumValues: null,
      default: defaultValue,
    };
  }
  // Unknown type spec: keep the name, fall back to string. The annotation
  // is preserved in the default (so codegen can round-trip if needed).
  return { name, type: "string", enumValues: null, default: defaultValue };
}

function splitEnumValues(raw: string): string[] {
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Find the index of the first occurrence of `ch` outside of `[...]` groups.
 * Returns -1 if not found. This lets us tolerate enum-bracket payloads
 * containing the `=` or `:` characters.
 */
function findTopLevelChar(haystack: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < haystack.length; i += 1) {
    const c = haystack[i];
    if (c === "[") depth += 1;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/**
 * Reduce a set of slot occurrences (potentially with the same `name`
 * appearing in multiple sections) into the IR's flat `Slot[]` list. Each
 * unique slot name produces exactly one `Slot`, whose `occurrences` field
 * accumulates every span and whose `appearsIn` field accumulates every
 * parent section id. Slot ids are allocated via the shared `IdAllocator`
 * in deterministic occurrence-order.
 *
 * The returned `bySectionId` map lets callers populate each section's
 * `slotRefs` field with the slot node ids it transitively references.
 */
export function reduceSlots(
  occurrences: SlotOccurrence[],
  ids: IdAllocator,
): {
  slots: Slot[];
  bySectionId: Map<NodeId, NodeId[]>;
} {
  const byName = new Map<string, Slot>();
  const bySection = new Map<NodeId, NodeId[]>();
  for (const occ of occurrences) {
    const existing = byName.get(occ.name);
    if (existing) {
      existing.occurrences.push(occ.source);
      if (!existing.appearsIn.includes(occ.appearsIn)) {
        existing.appearsIn.push(occ.appearsIn);
      }
      // Merge type info conservatively: first occurrence wins on type,
      // but enumValues are accumulated, and a non-null default trumps a
      // null default.
      if (existing.type === "enum" && occ.type === "enum") {
        for (const v of occ.enumValues ?? []) {
          if (!(existing.enumValues ?? []).includes(v)) {
            (existing.enumValues ?? []).push(v);
          }
        }
      }
      if (existing.default === null && occ.default !== null) {
        existing.default = occ.default;
      }
    } else {
      const slot: Slot = {
        id: ids.next("slot"),
        name: occ.name,
        type: occ.type,
        enumValues: occ.enumValues,
        default: occ.default,
        // Required when there is no default value.
        required: occ.default === null,
        occurrences: [occ.source],
        appearsIn: [occ.appearsIn],
      };
      byName.set(occ.name, slot);
    }
  }

  // Sync `required` with `default` after merge.
  for (const slot of byName.values()) {
    slot.required = slot.default === null;
  }

  // Build the per-section ref map in slot-allocation order.
  const slots = [...byName.values()];
  for (const slot of slots) {
    for (const sectionId of slot.appearsIn) {
      const existing = bySection.get(sectionId) ?? [];
      if (!existing.includes(slot.id)) existing.push(slot.id);
      bySection.set(sectionId, existing);
    }
  }
  return { slots, bySectionId: bySection };
}
