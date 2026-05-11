// packages/parser/test/plain.test.ts

import { describe, expect, test } from "bun:test";

import { parsePlain } from "../src/plain.js";

describe("parsePlain", () => {
  test("wraps the whole input as a single role section", () => {
    const ir = parsePlain("Please answer the question.");
    expect(ir.sections.length).toBe(1);
    const sec = ir.sections[0];
    expect(sec?.kind).toBe("role");
    expect(sec?.body).toBe("Please answer the question.");
    expect(ir.metadata.sourceFormat).toBe("plain");
  });

  test("accepts empty input and produces a single empty section", () => {
    const ir = parsePlain("");
    expect(ir.sections.length).toBe(1);
    expect(ir.sections[0]?.body).toBe("");
    expect(ir.slots.length).toBe(0);
  });

  test("recognises slot literals embedded in the text", () => {
    const ir = parsePlain("Hello {{ name }}, your score is {{ score : number }}.");
    expect(ir.slots.length).toBe(2);
    const names = ir.slots.map((s) => s.name).sort();
    expect(names).toEqual(["name", "score"]);
    const scoreSlot = ir.slots.find((s) => s.name === "score");
    expect(scoreSlot?.type).toBe("number");
  });

  test("preserves the source bytes verbatim", () => {
    const src = "line 1\nline 2\n   line 3   \n";
    const ir = parsePlain(src);
    expect(ir.metadata.rawSource).toBe(src);
    expect(ir.sections[0]?.body).toBe(src);
  });

  test("metadata.sourceHash is the SHA-256 of the source", () => {
    const ir = parsePlain("hello");
    // The SHA-256 hex of "hello" is fixed.
    expect(ir.metadata.sourceHash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
