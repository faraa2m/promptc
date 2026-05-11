// packages/parser/test/markdown.test.ts

import { describe, expect, test } from "bun:test";

import { parseMarkdown } from "../src/markdown.js";

describe("parseMarkdown", () => {
  test("splits ATX headings into sections with kinds inferred", () => {
    const source = `# Role

You are a helpful assistant.

## Task

Answer the user's question.

## Examples

Example 1:
Input: What is the capital of France?
Output: Paris

## Output Schema

\`\`\`json
{ "answer": "string" }
\`\`\`
`;
    const ir = parseMarkdown(source);
    const kinds = ir.sections.map((s) => s.kind);
    expect(kinds).toContain("role");
    expect(kinds).toContain("task");
    expect(kinds).toContain("examples");
    expect(kinds).toContain("output_schema");
    expect(ir.metadata.sourceFormat).toBe("markdown");
    expect(ir.metadata.rawSource).toBe(source);
    expect(ir.metadata.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("includes implicit lead block (no heading) when prose appears first", () => {
    const ir = parseMarkdown("intro prose\n\n# Role\n\nstuff");
    expect(ir.sections.length).toBe(2);
    // First section is the lead block; second is the explicit Role.
    expect(ir.sections[0]?.kind).toBe("other");
    expect(ir.sections[1]?.kind).toBe("role");
  });

  test("extracts list items in an instructions section as Instruction nodes", () => {
    const ir = parseMarkdown(
      [
        "## Instructions",
        "",
        "- Always answer in JSON",
        "- Use the schema below",
        "- Never apologise",
        "",
        "## Output",
        "",
        "schema here",
      ].join("\n"),
    );
    expect(ir.instructions.length).toBe(3);
    const texts = ir.instructions.map((i) => i.text);
    expect(texts).toContain("Always answer in JSON");
    expect(texts).toContain("Use the schema below");
    expect(texts).toContain("Never apologise");
  });

  test("ignores list items inside fenced code blocks", () => {
    const ir = parseMarkdown(
      [
        "## Instructions",
        "",
        "- a real item",
        "",
        "```",
        "- not an instruction",
        "- still inside code",
        "```",
        "- another real item",
      ].join("\n"),
    );
    expect(ir.instructions.length).toBe(2);
  });

  test("extracts Input:/Output: example pairs", () => {
    const ir = parseMarkdown(
      [
        "## Examples",
        "",
        "Example 1:",
        "Input: hello",
        "Output: world",
        "",
        "Example 2:",
        "Input: foo",
        "Output: bar",
      ].join("\n"),
    );
    expect(ir.examples.length).toBe(2);
    expect(ir.examples[0]?.input).toBe("hello");
    expect(ir.examples[0]?.output).toBe("world");
    expect(ir.examples[1]?.input).toBe("foo");
    expect(ir.examples[1]?.output).toBe("bar");
  });

  test("captures example labels", () => {
    const ir = parseMarkdown(
      "## Examples\n\nExample 7:\nInput: a\nOutput: b\n",
    );
    expect(ir.examples[0]?.label?.toLowerCase()).toContain("example");
  });

  test("produces deterministic output for identical input", () => {
    const src = "# Role\n\nYou are helpful.\n\n## Task\n\nAnswer {{ q }}.\n";
    const ir1 = parseMarkdown(src);
    const ir2 = parseMarkdown(src);
    expect(JSON.stringify(ir1)).toBe(JSON.stringify(ir2));
  });

  test("source spans point at the correct line for each section", () => {
    const ir = parseMarkdown(
      ["# Role", "", "body line", "", "## Task", "", "another"].join("\n"),
    );
    expect(ir.sections[0]?.source.line).toBe(1);
    expect(ir.sections[1]?.source.line).toBe(5);
  });
});
