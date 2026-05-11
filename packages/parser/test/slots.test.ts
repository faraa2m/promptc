// packages/parser/test/slots.test.ts

import { describe, expect, test } from "bun:test";

import { parseMarkdown } from "../src/markdown.js";
import { parsePlain } from "../src/plain.js";
import { parseXml } from "../src/xml.js";

describe("slot recognition", () => {
  test("recognises {{name}} in Markdown body text", () => {
    const ir = parseMarkdown("# Role\n\nYou are {{persona}}.\n");
    const names = ir.slots.map((s) => s.name);
    expect(names).toContain("persona");
  });

  test("recognises {{name}} in XML element text", () => {
    const ir = parseXml("<prompt><role>You are {{persona}}.</role></prompt>");
    const names = ir.slots.map((s) => s.name);
    expect(names).toContain("persona");
  });

  test("recognises {{name}} in plain text", () => {
    const ir = parsePlain("Hello {{user}}, today is {{day}}.");
    const names = ir.slots.map((s) => s.name).sort();
    expect(names).toEqual(["day", "user"]);
  });

  test("typed slots: {{ count : number }} -> number type", () => {
    const ir = parsePlain("count = {{ count : number }}");
    const slot = ir.slots[0];
    expect(slot?.type).toBe("number");
    expect(slot?.name).toBe("count");
  });

  test("default value: {{ name = world }} -> default 'world', not required", () => {
    const ir = parsePlain("hello {{ name = world }}");
    const slot = ir.slots[0];
    expect(slot?.default).toBe("world");
    expect(slot?.required).toBe(false);
  });

  test("enum bracket syntax: {{ mode : enum [a|b|c] }}", () => {
    const ir = parsePlain("mode={{ mode : enum [low|medium|high] }}");
    const slot = ir.slots[0];
    expect(slot?.type).toBe("enum");
    expect(slot?.enumValues).toEqual(["low", "medium", "high"]);
  });

  test("enum with default-as-list: {{ mode : enum = a | b | c }}", () => {
    const ir = parsePlain("mode={{ mode : enum = small | medium | large }}");
    const slot = ir.slots[0];
    expect(slot?.type).toBe("enum");
    expect(slot?.enumValues).toEqual(["small", "medium", "large"]);
    expect(slot?.default).toBe("small");
  });

  test("multiple occurrences of the same slot are merged into one Slot", () => {
    const ir = parsePlain("{{ x }} ... {{ x }} ... {{ x }}");
    expect(ir.slots.length).toBe(1);
    const slot = ir.slots[0];
    expect(slot?.occurrences.length).toBe(3);
  });

  test("slot literals inside code fences are ignored in Markdown", () => {
    const md = [
      "# Role",
      "",
      "Hello {{ outside }}.",
      "",
      "```",
      "literal {{ inside }} stays opaque",
      "```",
      "",
      "Trailing {{ tail }}.",
    ].join("\n");
    const ir = parseMarkdown(md);
    const names = ir.slots.map((s) => s.name).sort();
    expect(names).toEqual(["outside", "tail"]);
  });

  test("required reflects absence of default value", () => {
    const ir = parsePlain("{{ a }} {{ b = x }}");
    const a = ir.slots.find((s) => s.name === "a");
    const b = ir.slots.find((s) => s.name === "b");
    expect(a?.required).toBe(true);
    expect(b?.required).toBe(false);
  });

  test("each Section's slotRefs lists the slot ids it contains", () => {
    const ir = parseMarkdown("# Role\n\n{{ a }}\n\n## Task\n\n{{ b }}\n");
    const role = ir.sections.find((s) => s.kind === "role");
    const task = ir.sections.find((s) => s.kind === "task");
    expect(role?.slotRefs.length).toBe(1);
    expect(task?.slotRefs.length).toBe(1);
    // The slot id in role's refs should resolve to slot named "a".
    const aId = role?.slotRefs[0];
    const aSlot = ir.slots.find((s) => s.id === aId);
    expect(aSlot?.name).toBe("a");
  });
});
