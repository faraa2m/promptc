// validate.test.ts — confirm validateIR enforces the documented IR
// invariants.

import { beforeEach, describe, expect, it } from "bun:test";

import {
  __resetNodeIdsForTests,
  addExample,
  addInstruction,
  addSection,
  addSlot,
  buildPromptIR,
  setOutputSchema,
  validateIR,
  type PromptIR,
} from "../src/index.js";

beforeEach(() => __resetNodeIdsForTests());

function happy(): PromptIR {
  let ir = buildPromptIR({ sourceFormat: "markdown" });
  ir = addSection(ir, "task", "Answer the question.", { id: "S1" });
  ir = addSection(ir, "examples", "", { id: "S2" });
  ir = addSlot(ir, "question", "string", {
    id: "SL1",
    required: true,
    appearsIn: ["S1"],
  });
  ir = addInstruction(ir, "required", "Respond in JSON.", {
    id: "I1",
    parent: "S1",
    slotRefs: ["SL1"],
  });
  ir = addExample(ir, "Q", "A", { id: "EX1", parent: "S2" });
  ir = setOutputSchema(ir, {
    id: "OS1",
    format: "json",
    root: {
      name: "root",
      type: "object",
      required: true,
      fields: [{ name: "answer", type: "string", required: true }],
    },
    source: { start: 0, end: 0, line: 1, column: 1 },
  });
  return ir;
}

describe("validateIR — happy path", () => {
  it("accepts a fully-populated, internally-consistent IR", () => {
    const outcome = validateIR(happy());
    expect(outcome).toEqual({ valid: true, errors: [] });
  });

  it("accepts an empty IR", () => {
    expect(validateIR(buildPromptIR())).toEqual({ valid: true, errors: [] });
  });
});

describe("validateIR — slot-reference invariant", () => {
  it("rejects a section pointing to a non-existent slot", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "task", "x", { id: "S1", slotRefs: ["ghost"] });
    const outcome = validateIR(ir);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("rejects an instruction pointing to a non-existent slot", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "task", "x", { id: "S1" });
    ir = addInstruction(ir, "required", "do x", {
      id: "I1",
      parent: "S1",
      slotRefs: ["ghost"],
    });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("rejects an example pointing to a non-existent slot", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "examples", "x", { id: "S1" });
    ir = addExample(ir, "in", "out", {
      id: "E1",
      parent: "S1",
      slotRefs: ["ghost"],
    });
    expect(validateIR(ir).valid).toBe(false);
  });
});

describe("validateIR — example invariant", () => {
  it("rejects an example with an empty input", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "examples", "", { id: "S1" });
    ir = addExample(ir, "", "out", { id: "E1", parent: "S1" });
    const outcome = validateIR(ir);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.some((e) => /empty input/.test(e))).toBe(true);
  });

  it("rejects an example with an empty output", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "examples", "", { id: "S1" });
    ir = addExample(ir, "in", "", { id: "E1", parent: "S1" });
    const outcome = validateIR(ir);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.some((e) => /empty output/.test(e))).toBe(true);
  });
});

describe("validateIR — output schema validity", () => {
  it("rejects a JSON schema whose array field omits items", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "json",
      root: { name: "root", type: "array", required: true },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    const outcome = validateIR(ir);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.some((e) => /items.*required/.test(e))).toBe(true);
  });

  it("rejects an object schema with duplicate child names", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "json",
      root: {
        name: "root",
        type: "object",
        required: true,
        fields: [
          { name: "a", type: "string", required: true },
          { name: "a", type: "string", required: true },
        ],
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("rejects enum field with empty enumValues", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "json",
      root: { name: "root", type: "enum", required: true, enumValues: [] },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("requires root for non-free schemas", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "json",
      root: null,
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("allows null root only when format=free", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "free",
      root: null,
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    expect(validateIR(ir).valid).toBe(true);
  });
});

describe("validateIR — node id uniqueness", () => {
  it("rejects duplicate section ids", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "task", "x", { id: "S1" });
    ir = addSection(ir, "context", "y", { id: "S1" });
    const outcome = validateIR(ir);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.some((e) => /duplicate/.test(e))).toBe(true);
  });

  it("rejects duplicate ids across node kinds", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "task", "x", { id: "DUP" });
    ir = addSlot(ir, "name", "string", { id: "DUP" });
    expect(validateIR(ir).valid).toBe(false);
  });
});

describe("validateIR — parent / appearsIn references", () => {
  it("rejects instruction.parent pointing to a non-existent section", () => {
    const ir = addInstruction(buildPromptIR(), "required", "do x", {
      parent: "GHOST",
    });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("rejects slot.appearsIn pointing to a non-existent section", () => {
    const ir = addSlot(buildPromptIR(), "x", "string", { appearsIn: ["GHOST"] });
    expect(validateIR(ir).valid).toBe(false);
  });
});

describe("validateIR — slot type/enum invariants", () => {
  it("rejects enum slot with null enumValues", () => {
    const ir = addSlot(buildPromptIR(), "x", "enum", { enumValues: null });
    expect(validateIR(ir).valid).toBe(false);
  });

  it("rejects non-enum slot with non-null enumValues", () => {
    const ir = addSlot(buildPromptIR(), "x", "string", { enumValues: ["a"] });
    expect(validateIR(ir).valid).toBe(false);
  });
});
