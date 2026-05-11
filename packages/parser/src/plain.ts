// packages/parser/src/plain.ts
//
// "Plain" parser: the entire input becomes a single `role`-kind Section.
// Slot literals (`{{ name }}`) are still recognised — which makes the plain
// path useful for callers who have an unstructured prompt body with
// templated variables.
//
// This is the trivial parser. No headings, no examples, no instruction
// extraction. Lossless w.r.t. the source (the original bytes are stored
// in the IR's `metadata.rawSource` and as the section's `body`).

import {
  type PromptIR,
  type Section,
  type SourceSpan,
} from "@promptc/ir";

import { findSlotOccurrences, reduceSlots } from "./slots.js";
import { hashSource, IdAllocator, LineMap, makeSpan } from "./util.js";

export function parsePlain(source: string): PromptIR {
  const lineMap = new LineMap(source);
  const ids = new IdAllocator();
  const sectionId = ids.next("section");

  const sectionSpan: SourceSpan = makeSpan(0, source.length, lineMap);
  const section: Section = {
    id: sectionId,
    kind: "role",
    heading: "Role",
    body: source,
    source: sectionSpan,
    slotRefs: [],
    instructionRefs: [],
    exampleRefs: [],
    attrs: {},
  };

  const occurrences = findSlotOccurrences(source, 0, sectionId, lineMap);
  const { slots, bySectionId } = reduceSlots(occurrences, ids);
  section.slotRefs = bySectionId.get(sectionId) ?? [];

  return {
    irVersion: 1,
    sections: [section],
    slots,
    examples: [],
    instructions: [],
    output_schema: null,
    metadata: {
      sourceFormat: "plain",
      tags: [],
      sourceHash: hashSource(source),
      rawSource: source,
      passLog: [],
    },
  };
}
