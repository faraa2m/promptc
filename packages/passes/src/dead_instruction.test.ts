// packages/passes/src/dead_instruction.test.ts

import { describe, expect, test } from "bun:test";

import { deadInstructionElimination } from "./dead_instruction.js";
import {
  example,
  instruction,
  ir,
  outputSchema,
  schemaField,
  section,
} from "./_test_fixtures.js";

describe("dead_instruction_elimination", () => {
  test("preconditions reject empty instructions", () => {
    const empty = ir();
    const pre = deadInstructionElimination.preconditions(empty);
    expect(pre.ok).toBe(false);
    expect(pre.reasons.length).toBeGreaterThan(0);
  });

  test("preconditions reject IR with no schema and no examples", () => {
    const noAnchor = ir({
      instructions: [
        instruction({ id: "i-1", text: "do the thing" }),
      ],
    });
    const pre = deadInstructionElimination.preconditions(noAnchor);
    expect(pre.ok).toBe(false);
  });

  test("preconditions accept IR with schema only", () => {
    const withSchema = ir({
      instructions: [instruction({ id: "i-1", text: "respond" })],
      output_schema: outputSchema({
        id: "os-1",
        root: schemaField({
          name: "result",
          type: "object",
          fields: [schemaField({ name: "answer", type: "string" })],
        }),
      }),
    });
    const pre = deadInstructionElimination.preconditions(withSchema);
    expect(pre.ok).toBe(true);
    expect(pre.reasons).toEqual([]);
  });

  test("preconditions accept IR with examples only", () => {
    const withExamples = ir({
      instructions: [instruction({ id: "i-1", text: "respond" })],
      examples: [
        example({ id: "e-1", input: "what is 1+1", output: "2" }),
      ],
    });
    const pre = deadInstructionElimination.preconditions(withExamples);
    expect(pre.ok).toBe(true);
  });

  test("removes one of three instructions that is not referenced", () => {
    // Three instructions:
    //  - i-1 references field "answer" via refersToFields → KEPT
    //  - i-2 text overlaps example tokens ("classify") → KEPT
    //  - i-3 mentions nothing in schema or examples → REMOVED
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          instructionRefs: ["i-1", "i-2", "i-3"],
        }),
      ],
      instructions: [
        instruction({
          id: "i-1",
          text: "always include the answer field",
          refersToFields: ["answer"],
          parent: "s-1",
        }),
        instruction({
          id: "i-2",
          text: "classify the user query",
          parent: "s-1",
        }),
        instruction({
          id: "i-3",
          text: "vague residual filler nothing meaningful",
          parent: "s-1",
        }),
      ],
      examples: [
        example({
          id: "e-1",
          input: "please classify this query",
          output: "ok",
        }),
      ],
      output_schema: outputSchema({
        id: "os-1",
        root: schemaField({
          name: "result",
          type: "object",
          fields: [schemaField({ name: "answer", type: "string" })],
        }),
      }),
    });

    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.instructions.length).toBe(2);
    const ids = res.ir.instructions.map((i) => i.id);
    expect(ids).toEqual(["i-1", "i-2"]);

    // Section instructionRefs reflect the removal.
    expect(res.ir.sections[0]?.instructionRefs).toEqual(["i-1", "i-2"]);

    // Debug payload exposes the removal.
    expect(res.debug).toBeDefined();
    expect(res.debug?.removed).toBe(1);
    expect(res.debug?.removedIds).toEqual(["i-3"]);
  });

  test("preserves required instructions even when unreferenced", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          kind: "required",
          text: "absolutely unreferenced filler that is required",
        }),
        instruction({
          id: "i-2",
          kind: "optional",
          text: "absolutely unreferenced filler that is optional",
        }),
      ],
      examples: [
        example({ id: "e-1", input: "alpha beta gamma", output: "delta" }),
      ],
    });
    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.instructions.map((i) => i.id)).toEqual(["i-1"]);
  });

  test("preserves style instructions by default", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          kind: "style",
          text: "use a formal tone uncommon vocabulary",
        }),
      ],
      examples: [
        example({ id: "e-1", input: "alpha beta gamma", output: "delta" }),
      ],
    });
    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(false);
    expect(res.ir.instructions.length).toBe(1);
  });

  test("opts.removeStyleInstructions=true does remove style instructions", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          kind: "style",
          text: "use uncommon vocabulary",
        }),
      ],
      examples: [
        example({ id: "e-1", input: "alpha beta gamma", output: "delta" }),
      ],
    });
    const res = deadInstructionElimination.run(fixture, {
      removeStyleInstructions: true,
    });
    expect(res.applied).toBe(true);
    expect(res.ir.instructions.length).toBe(0);
  });

  test("no-op when every instruction is referenced", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          text: "respond with the answer",
          refersToFields: ["answer"],
        }),
      ],
      output_schema: outputSchema({
        id: "os-1",
        root: schemaField({
          name: "wrap",
          type: "object",
          fields: [schemaField({ name: "answer", type: "string" })],
        }),
      }),
    });
    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(false);
    expect(res.ir).toBe(fixture);
  });

  test("does not mutate input IR", () => {
    const fixture = ir({
      instructions: [
        instruction({ id: "i-1", text: "alpha referenced" }),
        instruction({ id: "i-2", text: "never appears in refs" }),
      ],
      examples: [
        example({ id: "e-1", input: "alpha example body", output: "ok" }),
      ],
    });
    const before = JSON.stringify(fixture);
    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(true);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(res.ir).not.toBe(fixture);
  });

  test("determinism: same IR produces same result", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          instructionRefs: ["i-1", "i-2", "i-3"],
        }),
      ],
      instructions: [
        instruction({
          id: "i-1",
          text: "always include the answer field",
          refersToFields: ["answer"],
        }),
        instruction({ id: "i-2", text: "classify the user query" }),
        instruction({ id: "i-3", text: "vague residual filler nothing" }),
      ],
      examples: [
        example({
          id: "e-1",
          input: "please classify this query",
          output: "ok",
        }),
      ],
      output_schema: outputSchema({
        id: "os-1",
        root: schemaField({
          name: "result",
          type: "object",
          fields: [schemaField({ name: "answer", type: "string" })],
        }),
      }),
    });
    const a = deadInstructionElimination.run(fixture);
    const b = deadInstructionElimination.run(fixture);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.applied).toBe(b.applied);
    expect(a.reason).toBe(b.reason);
    expect(a.droppedTokens).toBe(b.droppedTokens);
  });

  test("droppedTokens is a positive estimate on actual removal", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          text: "this is unreferenced filler with many tokens",
        }),
      ],
      examples: [
        example({ id: "e-1", input: "alpha", output: "beta" }),
      ],
    });
    const res = deadInstructionElimination.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.droppedTokens).toBeGreaterThan(0);
  });
});
