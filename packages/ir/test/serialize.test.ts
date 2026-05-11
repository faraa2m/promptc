// serialize.test.ts — verify that the canonical serializer is deterministic
// (same IR → same bytes) and that deserialize is the inverse.

import { beforeEach, describe, expect, it } from "bun:test";

import {
  __resetNodeIdsForTests,
  addExample,
  addInstruction,
  addSection,
  addSlot,
  buildPromptIR,
  deserializeIR,
  IRValidationError,
  serializeIR,
  setOutputSchema,
  type PromptIR,
} from "../src/index.js";

beforeEach(() => __resetNodeIdsForTests());

function sampleIR(): PromptIR {
  let ir = buildPromptIR({
    sourceFormat: "markdown",
    rawSource: "src",
    sourceHash: "h",
    tags: ["qa"],
  });
  ir = addSection(ir, "task", "do thing", { id: "S1" });
  ir = addSlot(ir, "x", "string", { id: "SL1", appearsIn: ["S1"] });
  ir = addInstruction(ir, "required", "Answer in English.", {
    id: "I1",
    parent: "S1",
    slotRefs: ["SL1"],
  });
  ir = addExample(ir, "in", "out", { id: "EX1", parent: "S1" });
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

describe("serializeIR", () => {
  it("produces byte-identical output across runs", () => {
    const ir = sampleIR();
    const a = serializeIR(ir);
    const b = serializeIR(ir);
    expect(a).toBe(b);
  });

  it("is independent of key insertion order", () => {
    const ir = sampleIR();
    const flipped: PromptIR = {
      metadata: ir.metadata,
      output_schema: ir.output_schema,
      instructions: ir.instructions,
      examples: ir.examples,
      slots: ir.slots,
      sections: ir.sections,
      irVersion: ir.irVersion,
    };
    expect(serializeIR(flipped)).toBe(serializeIR(ir));
  });

  it("emits 2-space indentation and trailing newline", () => {
    const ir = buildPromptIR();
    const json = serializeIR(ir);
    expect(json.endsWith("\n")).toBe(true);
    // The first non-brace line should be indented by exactly two spaces.
    const lines = json.split("\n");
    const indented = lines.find(
      (line) => line.length > 0 && /^\s+/.test(line),
    );
    expect(indented?.startsWith("  ")).toBe(true);
    expect(indented?.startsWith("   ")).toBe(false);
  });

  it("emits keys in lexicographic order at every depth", () => {
    const ir = sampleIR();
    const json = serializeIR(ir);
    // Top-level: irVersion < metadata < output_schema < ... lexicographically.
    // We verify by reparsing and checking the order Object.keys returns
    // (V8/Bun preserves insertion order on stringified inputs).
    const reparsed = JSON.parse(json);
    expect(Object.keys(reparsed)).toEqual([
      "examples",
      "instructions",
      "irVersion",
      "metadata",
      "output_schema",
      "sections",
      "slots",
    ]);

    const section = reparsed.sections[0];
    expect(Object.keys(section)).toEqual(
      [...Object.keys(section)].slice().sort(),
    );
    const metadataKeys = Object.keys(reparsed.metadata);
    expect(metadataKeys).toEqual([...metadataKeys].slice().sort());
  });

  it("handles empty arrays and empty objects compactly", () => {
    const ir = buildPromptIR();
    const json = serializeIR(ir);
    expect(json).toContain('"examples": []');
    expect(json).toContain('"instructions": []');
    expect(json).toContain('"sections": []');
    expect(json).toContain('"slots": []');
  });

  it("rejects non-finite numbers", () => {
    const ir = buildPromptIR();
    // Reach into metadata.passLog to inject NaN — illegal per JSON spec.
    const broken = {
      ...ir,
      metadata: {
        ...ir.metadata,
        passLog: [
          {
            pass: "p",
            applied: true,
            skipReason: null,
            nodesChanged: Number.NaN,
            durationMs: 0,
          },
        ],
      },
    };
    expect(() => serializeIR(broken)).toThrow(IRValidationError);
  });
});

describe("deserializeIR", () => {
  it("is the inverse of serializeIR for valid input", () => {
    const ir = sampleIR();
    const restored = deserializeIR(serializeIR(ir));
    expect(restored).toEqual(ir);
  });

  it("throws IRValidationError on malformed JSON", () => {
    expect(() => deserializeIR("{ not json")).toThrow(IRValidationError);
  });

  it("throws IRValidationError when irVersion is wrong", () => {
    const json = JSON.stringify({
      irVersion: 2,
      sections: [],
      slots: [],
      examples: [],
      instructions: [],
      output_schema: null,
      metadata: {
        sourceFormat: "plain",
        tags: [],
        sourceHash: "",
        rawSource: "",
        passLog: [],
      },
    });
    expect(() => deserializeIR(json)).toThrow(IRValidationError);
  });

  it("throws when a required field is missing", () => {
    const json = JSON.stringify({
      irVersion: 1,
      // sections missing
      slots: [],
      examples: [],
      instructions: [],
      output_schema: null,
      metadata: {
        sourceFormat: "plain",
        tags: [],
        sourceHash: "",
        rawSource: "",
        passLog: [],
      },
    });
    expect(() => deserializeIR(json)).toThrow(IRValidationError);
  });
});
