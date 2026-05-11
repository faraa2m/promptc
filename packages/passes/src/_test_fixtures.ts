// packages/passes/src/_test_fixtures.ts
//
// Internal test fixtures: small, deterministic factories for `PromptIR`
// nodes. Not part of the public surface — this module is consumed only by
// the package's own test files. Each factory returns a value-typed object;
// callers can override any field via the optional `partial` argument.

import type {
  Example,
  Instruction,
  Metadata,
  OutputSchema,
  PromptIR,
  SchemaField,
  Section,
  Slot,
  SourceSpan,
} from "@promptc/ir";

export function span(start = 0, end = 0, line = 1, column = 1): SourceSpan {
  return { start, end, line, column };
}

export function section(partial: Partial<Section> & { id: string }): Section {
  return {
    id: partial.id,
    kind: partial.kind ?? "other",
    heading: partial.heading ?? "",
    body: partial.body ?? "",
    source: partial.source ?? span(),
    slotRefs: partial.slotRefs ?? [],
    instructionRefs: partial.instructionRefs ?? [],
    exampleRefs: partial.exampleRefs ?? [],
    attrs: partial.attrs ?? {},
  };
}

export function instruction(
  partial: Partial<Instruction> & { id: string; text: string },
): Instruction {
  return {
    id: partial.id,
    kind: partial.kind ?? "optional",
    text: partial.text,
    verbs: partial.verbs ?? [],
    refersToFields: partial.refersToFields ?? [],
    slotRefs: partial.slotRefs ?? [],
    parent: partial.parent ?? "section-root",
    source: partial.source ?? span(),
  };
}

export function example(
  partial: Partial<Example> & { id: string; input: string; output: string },
): Example {
  return {
    id: partial.id,
    label: partial.label ?? null,
    input: partial.input,
    output: partial.output,
    rationale: partial.rationale ?? null,
    slotRefs: partial.slotRefs ?? [],
    parent: partial.parent ?? "section-root",
    source: partial.source ?? span(),
  };
}

export function slot(partial: Partial<Slot> & { id: string; name: string }): Slot {
  return {
    id: partial.id,
    name: partial.name,
    type: partial.type ?? "string",
    enumValues: partial.enumValues ?? null,
    default: partial.default ?? null,
    required: partial.required ?? false,
    occurrences: partial.occurrences ?? [],
    appearsIn: partial.appearsIn ?? [],
  };
}

export function schemaField(
  partial: Partial<SchemaField> & { name: string },
): SchemaField {
  return {
    name: partial.name,
    type: partial.type ?? "string",
    required: partial.required ?? false,
    ...(partial.items !== undefined ? { items: partial.items } : {}),
    ...(partial.fields !== undefined ? { fields: partial.fields } : {}),
    ...(partial.enumValues !== undefined ? { enumValues: partial.enumValues } : {}),
    ...(partial.description !== undefined ? { description: partial.description } : {}),
  };
}

export function outputSchema(
  partial: Partial<OutputSchema> & { id: string },
): OutputSchema {
  return {
    id: partial.id,
    format: partial.format ?? "json",
    root: partial.root ?? null,
    source: partial.source ?? span(),
  };
}

export function metadata(partial: Partial<Metadata> = {}): Metadata {
  return {
    sourceFormat: partial.sourceFormat ?? "markdown",
    tags: partial.tags ?? [],
    sourceHash: partial.sourceHash ?? "0".repeat(64),
    rawSource: partial.rawSource ?? "",
    passLog: partial.passLog ?? [],
  };
}

export function ir(partial: Partial<PromptIR> = {}): PromptIR {
  return {
    irVersion: 1,
    sections: partial.sections ?? [],
    slots: partial.slots ?? [],
    examples: partial.examples ?? [],
    instructions: partial.instructions ?? [],
    output_schema: partial.output_schema ?? null,
    metadata: partial.metadata ?? metadata(),
  };
}
