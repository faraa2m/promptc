// packages/parser/test/auto.test.ts

import { describe, expect, test } from "bun:test";

import { detectFormat, parseAuto } from "../src/auto.js";

describe("detectFormat", () => {
  test("detects XML from a `<tag>` opener", () => {
    expect(detectFormat("<prompt><role>r</role></prompt>")).toBe("xml");
  });

  test("detects XML from a leading <?xml?> declaration", () => {
    expect(detectFormat('<?xml version="1.0"?>\n<prompt></prompt>')).toBe("xml");
  });

  test("detects Markdown from an ATX heading anywhere in the input", () => {
    expect(detectFormat("# Role\n\nbody")).toBe("markdown");
    expect(detectFormat("intro\n\n## Task\n\nbody")).toBe("markdown");
  });

  test("falls back to plain for inputs with no headings or tags", () => {
    expect(detectFormat("just some words")).toBe("plain");
    expect(detectFormat("")).toBe("plain");
  });

  test("does not misidentify `<` followed by non-name characters as XML", () => {
    expect(detectFormat("2 < 3 evaluates to true")).toBe("plain");
  });
});

describe("parseAuto", () => {
  test("dispatches to XML parser for XML input", () => {
    const ir = parseAuto("<prompt><role>hi</role></prompt>");
    expect(ir.metadata.sourceFormat).toBe("xml");
  });

  test("dispatches to Markdown parser for Markdown input", () => {
    const ir = parseAuto("# Role\n\nbody");
    expect(ir.metadata.sourceFormat).toBe("markdown");
  });

  test("dispatches to plain parser for plain text", () => {
    const ir = parseAuto("hello world");
    expect(ir.metadata.sourceFormat).toBe("plain");
  });
});
