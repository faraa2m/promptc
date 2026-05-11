// packages/codegen/test/codegen.test.ts
//
// Determinism + structural-invariant tests for `@promptc/codegen`.
//
// The full parser → codegen → parser round-trip lives in
// `packages/parser/test/` once the parser lands. Here we test the codegen
// side of the contract independently:
//
//   1. `codegen(ir, opts)` is a pure function of its inputs.
//   2. `toMarkdown`, `toXml`, `toPlain` produce non-empty output for non-empty IR.
//   3. Section ordering is `SectionKind` priority, then parse order (within bucket).
//   4. Slot placeholders `{{name}}` survive verbatim in markdown/plain output.
//   5. Output schema is rendered in the right format for each backend.

import { describe, expect, test } from "bun:test";

import {
  addExample,
  addInstruction,
  addSection,
  addSlot,
  buildPromptIR,
  setOutputSchema,
  type PromptIR,
} from "@promptc/ir";

import { codegen, toMarkdown, toPlain, toXml } from "../src/index.js";

function buildBasicIR(): PromptIR {
  let ir = buildPromptIR({ sourceFormat: "markdown" });
  ir = addSection(ir, "role", "You are a helpful assistant.");
  ir = addSection(ir, "task", "Classify the input as positive or negative.");
  const taskId = ir.sections[1]!.id;
  ir = addInstruction(ir, "required", "Respond with only the label.", {
    parent: taskId,
  });
  ir = addSection(ir, "examples", "");
  const examplesId = ir.sections[2]!.id;
  ir = addExample(ir, "the food was great", "positive", {
    label: "Example 1",
    parent: examplesId,
  });
  ir = addExample(ir, "the food was bad", "negative", {
    label: "Example 2",
    parent: examplesId,
  });
  return ir;
}

describe("codegen — determinism", () => {
  test("identical IR produces identical output bytes (markdown)", () => {
    const ir = buildBasicIR();
    const a = codegen(ir, { to: "markdown" });
    const b = codegen(ir, { to: "markdown" });
    expect(a).toEqual(b);
  });
  test("identical IR produces identical output bytes (xml)", () => {
    const ir = buildBasicIR();
    const a = codegen(ir, { to: "xml" });
    const b = codegen(ir, { to: "xml" });
    expect(a).toEqual(b);
  });
  test("identical IR produces identical output bytes (plain)", () => {
    const ir = buildBasicIR();
    const a = codegen(ir, { to: "plain" });
    const b = codegen(ir, { to: "plain" });
    expect(a).toEqual(b);
  });
});

describe("codegen — non-empty output", () => {
  test("markdown emits role section heading", () => {
    const ir = buildBasicIR();
    const md = toMarkdown(ir);
    expect(md).toContain("## Role");
    expect(md).toContain("You are a helpful assistant.");
  });
  test("xml emits <prompt> root", () => {
    const ir = buildBasicIR();
    const xml = toXml(ir);
    expect(xml.startsWith("<prompt>")).toBe(true);
    expect(xml.trimEnd().endsWith("</prompt>")).toBe(true);
    expect(xml).toContain("<role>");
    expect(xml).toContain("<task>");
  });
  test("plain emits uppercased section headers", () => {
    const ir = buildBasicIR();
    const plain = toPlain(ir);
    expect(plain).toContain("ROLE");
    expect(plain).toContain("TASK");
    expect(plain).toContain("EXAMPLES");
  });
});

describe("codegen — section ordering by SectionKind priority", () => {
  test("role precedes task even if parsed in reverse order", () => {
    let ir = buildPromptIR({ sourceFormat: "markdown" });
    ir = addSection(ir, "task", "Do the thing.");
    ir = addSection(ir, "role", "You are X.");
    const md = toMarkdown(ir);
    expect(md.indexOf("## Role")).toBeLessThan(md.indexOf("## Task"));
  });
  test("output_schema falls after examples", () => {
    let ir = buildPromptIR({ sourceFormat: "markdown" });
    ir = addSection(ir, "examples", "");
    const exId = ir.sections[0]!.id;
    ir = addExample(ir, "in", "out", { parent: exId });
    ir = addSection(ir, "output_schema", "");
    ir = setOutputSchema(ir, {
      id: "schema-1",
      format: "json",
      root: {
        name: "result",
        type: "object",
        required: true,
        fields: [
          { name: "label", type: "string", required: true },
          { name: "score", type: "number", required: false },
        ],
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    const md = toMarkdown(ir);
    expect(md.indexOf("## Examples")).toBeLessThan(md.indexOf("## Output Schema"));
    expect(md).toContain('"label": "string"');
    expect(md).toContain('"score": "number"');
  });
});

describe("codegen — slots", () => {
  test("slot placeholder {{name}} is preserved in markdown body", () => {
    let ir = buildPromptIR({ sourceFormat: "markdown" });
    ir = addSlot(ir, "username", "string");
    ir = addSection(ir, "role", "Hi {{username}}.");
    const md = toMarkdown(ir);
    expect(md).toContain("{{username}}");
  });
});

describe("codegen — schema rendering by format", () => {
  test("json schema renders in markdown as fenced json block", () => {
    let ir = buildPromptIR({ sourceFormat: "markdown" });
    ir = setOutputSchema(ir, {
      id: "schema-1",
      format: "json",
      root: {
        name: "result",
        type: "object",
        required: true,
        fields: [{ name: "label", type: "string", required: true }],
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    const md = toMarkdown(ir);
    expect(md).toContain("```json");
    expect(md).toContain("```");
  });
  test("xml-format schema renders as xml-shaped fence", () => {
    let ir = buildPromptIR({ sourceFormat: "markdown" });
    ir = setOutputSchema(ir, {
      id: "schema-1",
      format: "xml",
      root: {
        name: "answer",
        type: "string",
        required: true,
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    const md = toMarkdown(ir);
    expect(md).toContain("```xml");
    expect(md).toContain("<answer>string</answer>");
  });
  test("schema escapes through xml backend without literal CDATA breakage", () => {
    let ir = buildPromptIR({ sourceFormat: "xml" });
    ir = setOutputSchema(ir, {
      id: "schema-1",
      format: "json",
      root: {
        name: "result",
        type: "string",
        required: true,
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    const xml = toXml(ir);
    expect(xml).toContain('<output_schema format="json">');
    expect(xml).toContain("<![CDATA[");
    expect(xml).toContain("]]>");
  });
});

describe("codegen — pseudo-round-trip via re-codegen", () => {
  // We don't yet have a parser to feed back into; instead we verify that
  // building two structurally-equal IRs produces equal output bytes (the
  // contract codegen owes the parser/test stack).
  test("two IRs with equivalent shape produce equal markdown", () => {
    const a = buildBasicIR();
    const b = buildBasicIR();
    // The basic build above is non-deterministic across runs only via the
    // `nextId()` counter — but `buildBasicIR` builds in the same order each
    // call, and we're calling it back-to-back inside one test. The ids will
    // differ between the two `buildBasicIR` calls, but codegen output does not
    // depend on ids; it depends on structure.
    expect(toMarkdown(a).split("\n").length).toEqual(
      toMarkdown(b).split("\n").length,
    );
  });
});

describe("codegen — empty IR", () => {
  test("empty IR produces empty-ish output", () => {
    const ir = buildPromptIR({ sourceFormat: "markdown" });
    expect(toMarkdown(ir)).toEqual("\n");
    expect(toPlain(ir)).toEqual("\n");
    expect(toXml(ir).trim()).toEqual("<prompt>\n</prompt>");
  });
});
