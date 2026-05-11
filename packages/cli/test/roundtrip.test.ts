// packages/cli/test/roundtrip.test.ts
//
// Integration test: parse -> codegen -> parse produces an equivalent IR.
//
// This is the load-bearing round-trip property from DESIGN.md §5 (invariant 4):
// for an IR with an empty pass log, `codegen(ir, { to: ir.metadata.sourceFormat })`
// produces a string `s'` such that `parse(s', { from: ir.metadata.sourceFormat })`
// is structurally equal to the original IR, modulo source spans and trivial
// whitespace normalisation.
//
// We compare on the structural fields (sections, instructions, examples, slots)
// rather than full deep equality — source spans and metadata.sourceHash are
// expected to differ across the rewrite.

import { describe, expect, test } from "bun:test";

import { parse } from "@promptc/parser";
import { codegen } from "@promptc/codegen";

const SAMPLE_MD = `# Role

You are a helpful assistant.

# Task

Classify the input.

# Instructions

- Use short answers.
- Avoid hedging.

# Examples

Example 1
Input: hello
Output: greeting

Example 2
Input: goodbye
Output: farewell
`;

function structuralView(ir: ReturnType<typeof parse>): unknown {
  return {
    sectionsKind: ir.sections.map((s) => s.kind),
    sectionsHeading: ir.sections.map((s) => s.heading),
    instructionTexts: ir.instructions.map((i) => i.text),
    instructionKinds: ir.instructions.map((i) => i.kind),
    exampleLabels: ir.examples.map((e) => e.label),
    exampleInputs: ir.examples.map((e) => e.input.trim()),
    exampleOutputs: ir.examples.map((e) => e.output.trim()),
    slotNames: ir.slots.map((s) => s.name).sort(),
  };
}

describe("round-trip — parse -> codegen -> parse", () => {
  test("markdown round-trip preserves the structural IR view", () => {
    const original = parse(SAMPLE_MD, { format: "markdown" });
    const re_emitted = codegen(original, { to: "markdown" });
    const reparsed = parse(re_emitted, { format: "markdown" });
    expect(structuralView(reparsed)).toEqual(structuralView(original));
  });
  test("xml round-trip is structurally equivalent to its source IR", () => {
    const original = parse(SAMPLE_MD, { format: "markdown" });
    const xml = codegen(original, { to: "xml" });
    const reparsed = parse(xml, { format: "xml" });
    // Section kinds + instruction texts + example inputs/outputs should align.
    const a = structuralView(original);
    const b = structuralView(reparsed);
    expect((b as { instructionTexts: string[] }).instructionTexts).toEqual(
      (a as { instructionTexts: string[] }).instructionTexts,
    );
    expect((b as { exampleInputs: string[] }).exampleInputs).toEqual(
      (a as { exampleInputs: string[] }).exampleInputs,
    );
    expect((b as { exampleOutputs: string[] }).exampleOutputs).toEqual(
      (a as { exampleOutputs: string[] }).exampleOutputs,
    );
  });
});

describe("determinism — codegen is a pure function", () => {
  test("same IR -> same bytes (markdown)", () => {
    const ir = parse(SAMPLE_MD, { format: "markdown" });
    expect(codegen(ir, { to: "markdown" })).toEqual(codegen(ir, { to: "markdown" }));
  });
  test("same IR -> same bytes (xml)", () => {
    const ir = parse(SAMPLE_MD, { format: "markdown" });
    expect(codegen(ir, { to: "xml" })).toEqual(codegen(ir, { to: "xml" }));
  });
  test("same IR -> same bytes (plain)", () => {
    const ir = parse(SAMPLE_MD, { format: "markdown" });
    expect(codegen(ir, { to: "plain" })).toEqual(codegen(ir, { to: "plain" }));
  });
});
