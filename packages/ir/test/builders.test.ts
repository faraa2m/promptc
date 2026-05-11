// builders.test.ts — exercise the pure-functional builder API.
//
// Two non-negotiable properties are tested here:
//   1. Immutability — builders never mutate their input IR.
//   2. Round-trip — build → serialize → deserialize yields an equal IR.

import { beforeEach, describe, expect, it } from "bun:test";

import {
  __resetNodeIdsForTests,
  addExample,
  addInstruction,
  addSection,
  addSlot,
  appendPassLogEntry,
  buildPromptIR,
  cloneIR,
  deserializeIR,
  serializeIR,
  setMetadata,
  setOutputSchema,
} from "../src/index.js";

beforeEach(() => __resetNodeIdsForTests());

describe("buildPromptIR", () => {
  it("returns an empty IR with metadata defaults", () => {
    const ir = buildPromptIR();
    expect(ir.irVersion).toBe(1);
    expect(ir.metadata.sourceFormat).toBe("plain");
    expect(ir.metadata.tags).toEqual([]);
    expect(ir.metadata.rawSource).toBe("");
    expect(ir.metadata.passLog).toEqual([]);
  });

  it("respects caller-supplied metadata", () => {
    const ir = buildPromptIR({
      sourceFormat: "markdown",
      rawSource: "# Hi",
      sourceHash: "abc",
      tags: ["qa"],
    });
    expect(ir.metadata.sourceFormat).toBe("markdown");
    expect(ir.metadata.rawSource).toBe("# Hi");
    expect(ir.metadata.sourceHash).toBe("abc");
    expect(ir.metadata.tags).toEqual(["qa"]);
  });

  it("copies caller arrays (no aliasing)", () => {
    const tags = ["a"];
    const ir = buildPromptIR({ tags });
    tags.push("b");
    expect(ir.metadata.tags).toEqual(["a"]);
  });
});

describe("addSection", () => {
  it("appends a section without mutating the input IR", () => {
    const empty = buildPromptIR();
    const withSection = addSection(empty, "role", "You are a helpful agent.");
    expect(empty.sections.length).toBe(0);
    expect(withSection.sections.length).toBe(1);
    const section = withSection.sections[0];
    expect(section).toBeDefined();
    if (section) {
      expect(section.kind).toBe("role");
      expect(section.body).toBe("You are a helpful agent.");
      expect(section.heading).toBe("Role");
    }
  });

  it("preserves an explicit heading + attrs", () => {
    const ir = addSection(buildPromptIR(), "task", "Classify the sentiment.", {
      heading: "Task — sentiment",
      attrs: { preserve_whitespace: "true" },
    });
    expect(ir.sections[0]?.heading).toBe("Task — sentiment");
    expect(ir.sections[0]?.attrs.preserve_whitespace).toBe("true");
  });
});

describe("addSlot", () => {
  it("defaults enumValues correctly per slot type", () => {
    const stringIr = addSlot(buildPromptIR(), "name", "string");
    expect(stringIr.slots[0]?.enumValues).toBeNull();

    const enumIr = addSlot(buildPromptIR(), "sentiment", "enum", {
      enumValues: ["pos", "neg", "neu"],
    });
    expect(enumIr.slots[0]?.enumValues).toEqual(["pos", "neg", "neu"]);
  });

  it("clones enumValues to avoid aliasing", () => {
    const values = ["a", "b"];
    const ir = addSlot(buildPromptIR(), "x", "enum", { enumValues: values });
    values.push("c");
    expect(ir.slots[0]?.enumValues).toEqual(["a", "b"]);
  });

  it("respects required + default", () => {
    const ir = addSlot(buildPromptIR(), "x", "string", {
      required: true,
      default: "fallback",
    });
    expect(ir.slots[0]?.required).toBe(true);
    expect(ir.slots[0]?.default).toBe("fallback");
  });
});

describe("addInstruction", () => {
  it("attaches to a parent section when given one", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "instructions", "do this", { id: "S1" });
    ir = addInstruction(ir, "required", "Respond in English.", {
      parent: "S1",
    });
    expect(ir.instructions.length).toBe(1);
    expect(ir.instructions[0]?.parent).toBe("S1");
    expect(ir.sections[0]?.instructionRefs).toContain(ir.instructions[0]?.id);
  });

  it("never mutates the source IR", () => {
    const a = buildPromptIR();
    const b = addInstruction(a, "style", "Keep it concise.");
    expect(a.instructions.length).toBe(0);
    expect(b.instructions.length).toBe(1);
  });
});

describe("addExample", () => {
  it("stores input + output verbatim and links parent ref", () => {
    let ir = buildPromptIR();
    ir = addSection(ir, "examples", "", { id: "EX" });
    ir = addExample(ir, "Q: 2+2?", "A: 4", { parent: "EX", label: "Ex 1" });
    expect(ir.examples[0]?.input).toBe("Q: 2+2?");
    expect(ir.examples[0]?.output).toBe("A: 4");
    expect(ir.examples[0]?.label).toBe("Ex 1");
    expect(ir.sections[0]?.exampleRefs).toContain(ir.examples[0]?.id);
  });
});

describe("setOutputSchema", () => {
  it("attaches a schema and is reversible with null", () => {
    let ir = buildPromptIR();
    ir = setOutputSchema(ir, {
      id: "schema-1",
      format: "json",
      root: {
        name: "root",
        type: "object",
        required: true,
        fields: [{ name: "answer", type: "string", required: true }],
      },
      source: { start: 0, end: 0, line: 1, column: 1 },
    });
    expect(ir.output_schema?.format).toBe("json");
    ir = setOutputSchema(ir, null);
    expect(ir.output_schema).toBeNull();
  });

  it("clones the schema (no aliasing)", () => {
    const schema = {
      id: "s1",
      format: "json" as const,
      root: null,
      source: { start: 0, end: 0, line: 1, column: 1 },
    };
    const ir = setOutputSchema(buildPromptIR(), schema);
    schema.format = "xml" as never;
    expect(ir.output_schema?.format).toBe("json");
  });
});

describe("setMetadata", () => {
  it("patches only specified fields", () => {
    const ir = setMetadata(buildPromptIR(), { tags: ["qa"] });
    expect(ir.metadata.tags).toEqual(["qa"]);
    expect(ir.metadata.sourceFormat).toBe("plain");
  });
});

describe("appendPassLogEntry", () => {
  it("appends in order; defaults nodesChanged/durationMs to 0", () => {
    let ir = buildPromptIR();
    ir = appendPassLogEntry(ir, { pass: "p1", applied: true });
    ir = appendPassLogEntry(ir, {
      pass: "p2",
      applied: false,
      skipReason: "missing schema",
    });
    expect(ir.metadata.passLog.length).toBe(2);
    expect(ir.metadata.passLog[0]?.pass).toBe("p1");
    expect(ir.metadata.passLog[1]?.skipReason).toBe("missing schema");
    expect(ir.metadata.passLog[0]?.nodesChanged).toBe(0);
  });
});

describe("cloneIR", () => {
  it("returns a deep copy", () => {
    let ir = buildPromptIR({ tags: ["a"] });
    ir = addSection(ir, "task", "do x", { id: "S1" });
    const copy = cloneIR(ir);
    expect(copy).toEqual(ir);
    expect(copy).not.toBe(ir);
    expect(copy.sections).not.toBe(ir.sections);
    expect(copy.sections[0]).not.toBe(ir.sections[0]);
  });
});

describe("round-trip: build → serialize → deserialize", () => {
  it("preserves a complex IR exactly", () => {
    let ir = buildPromptIR({
      sourceFormat: "markdown",
      rawSource: "# Demo\n",
      sourceHash: "h",
      tags: ["qa", "classification"],
    });
    ir = addSection(ir, "role", "You are an assistant.", { id: "S1" });
    ir = addSection(ir, "task", "Answer the question.", { id: "S2" });
    ir = addSlot(ir, "question", "string", {
      id: "SL1",
      required: true,
      appearsIn: ["S2"],
    });
    ir = addExample(ir, "Q: hi?", "A: hello", {
      id: "EX1",
      parent: "S2",
      slotRefs: ["SL1"],
    });
    ir = addInstruction(ir, "required", "Respond in English.", {
      id: "I1",
      parent: "S2",
      verbs: ["respond"],
    });
    ir = setOutputSchema(ir, {
      id: "OS1",
      format: "json",
      root: {
        name: "root",
        type: "object",
        required: true,
        fields: [
          { name: "answer", type: "string", required: true },
          {
            name: "tags",
            type: "array",
            required: false,
            items: { name: "tag", type: "string", required: true },
          },
        ],
      },
      source: { start: 0, end: 10, line: 1, column: 1 },
    });
    ir = appendPassLogEntry(ir, {
      pass: "whitespace_redundancy_strip",
      applied: true,
      nodesChanged: 2,
      durationMs: 1,
    });

    const json = serializeIR(ir);
    const restored = deserializeIR(json);
    expect(restored).toEqual(ir);
  });
});
