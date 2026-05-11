// packages/parser/test/xml.test.ts

import { describe, expect, test } from "bun:test";

import { ParseError } from "../src/errors.js";
import { parseXml } from "../src/xml.js";

describe("parseXml", () => {
  test("parses a well-formed <prompt> with all common sections", () => {
    const src = `<prompt>
  <role>You are a strict classifier.</role>
  <task>Label the document.</task>
  <examples>
    <example label="ex1">
      <input>doc one</input>
      <output>positive</output>
    </example>
    <example>
      <input>doc two</input>
      <output>negative</output>
      <rationale>contains negation</rationale>
    </example>
  </examples>
  <output_schema>{ "label": "string" }</output_schema>
</prompt>`;
    const ir = parseXml(src);
    expect(ir.metadata.sourceFormat).toBe("xml");
    const kinds = ir.sections.map((s) => s.kind);
    expect(kinds).toContain("role");
    expect(kinds).toContain("task");
    expect(kinds).toContain("examples");
    expect(kinds).toContain("output_schema");
    expect(ir.examples.length).toBe(2);
    expect(ir.examples[0]?.input).toBe("doc one");
    expect(ir.examples[0]?.output).toBe("positive");
    expect(ir.examples[0]?.label).toBe("ex1");
    expect(ir.examples[1]?.rationale).toBe("contains negation");
  });

  test("decodes the five named XML entities", () => {
    const src = "<prompt><role>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;</role></prompt>";
    const ir = parseXml(src);
    const role = ir.sections.find((s) => s.kind === "role");
    expect(role?.body).toBe(`a & b < c > d "e" 'f'`);
  });

  test("supports self-closing tags", () => {
    const src = `<prompt><role/><task>do it</task></prompt>`;
    const ir = parseXml(src);
    expect(ir.sections.length).toBe(2);
    expect(ir.sections.find((s) => s.kind === "role")?.body).toBe("");
  });

  test("treats the root tag as a section when not <prompt>", () => {
    const ir = parseXml("<role>just a role</role>");
    expect(ir.sections.length).toBe(1);
    expect(ir.sections[0]?.kind).toBe("role");
    expect(ir.sections[0]?.body).toBe("just a role");
  });

  test("throws ParseError on mismatched tags with line:column", () => {
    const src = "<prompt>\n  <role>oops</wrong>\n</prompt>";
    let thrown: unknown = null;
    try {
      parseXml(src);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    if (thrown instanceof ParseError) {
      expect(thrown.location.line).toBe(2);
      expect(thrown.location.column).toBeGreaterThan(0);
      expect(thrown.format).toBe("xml");
    }
  });

  test("throws ParseError on unclosed element", () => {
    let thrown: unknown = null;
    try {
      parseXml("<prompt><role>oh no");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
  });

  test("rejects DOCTYPE declarations as defense against XXE", () => {
    const src = "<!DOCTYPE foo [<!ENTITY x \"evil\">]><prompt><role>hi</role></prompt>";
    let thrown: unknown = null;
    try {
      parseXml(src);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    if (thrown instanceof ParseError) {
      expect(thrown.message).toContain("DOCTYPE");
    }
  });

  test("rejects unknown entity references", () => {
    let thrown: unknown = null;
    try {
      parseXml("<prompt><role>&xee;</role></prompt>");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
  });

  test("CDATA sections preserve their content verbatim", () => {
    const src =
      "<prompt><role><![CDATA[ <not-a-tag> & raw stuff ]]></role></prompt>";
    const ir = parseXml(src);
    const role = ir.sections.find((s) => s.kind === "role");
    expect(role?.body).toBe(" <not-a-tag> & raw stuff ");
  });

  test("ignores namespace prefixes on tag names", () => {
    const ir = parseXml("<p:prompt xmlns:p='urn:x'><p:role>R</p:role></p:prompt>");
    expect(ir.sections.find((s) => s.kind === "role")?.body).toBe("R");
  });

  test("supports <instructions> with <instruction kind='required'> children", () => {
    const src = `<prompt>
  <instructions>
    <instruction kind="required">Respond in JSON</instruction>
    <instruction kind="style">Be polite</instruction>
  </instructions>
</prompt>`;
    const ir = parseXml(src);
    expect(ir.instructions.length).toBe(2);
    expect(ir.instructions[0]?.kind).toBe("required");
    expect(ir.instructions[1]?.kind).toBe("style");
  });
});
