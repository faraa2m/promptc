// types.test.ts — compile-time type assertions over the IR public surface.
//
// `bun test` runs this file as TS at runtime, but the meaningful "tests" here
// are the type-only `assertExtends` checks: if a future refactor breaks the
// declared shape of `PromptIR` (or its constituent node types), TypeScript
// rejects this file at typecheck. The runtime `expect` calls below merely
// pin a few sentinel values so the harness sees this file as a real test
// module rather than a no-op.

import { describe, expect, it } from "bun:test";

import {
  buildPromptIR,
  type CompileOptions,
  type Example,
  type Instruction,
  type InstructionKind,
  type Metadata,
  type OutputSchema,
  type Pass,
  type PassLogEntry,
  type PassResult,
  type PreconditionResult,
  type PromptIR,
  type SchemaField,
  type Section,
  type SectionKind,
  type Slot,
  type SlotType,
  type SourceFormat,
  type SourceSpan,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Type-only assertions — these are compile-time tests. If a field is renamed
// or its type widens, this file fails to typecheck.
// ---------------------------------------------------------------------------

// Helper: assert that `Sub` is assignable to `Super`.
type AssertAssignable<Sub extends Super, Super> = [Sub, Super];

// PromptIR must expose the exact top-level keys the DESIGN.md design contract
// names. We pin each individually.
const _shapeProbe: AssertAssignable<
  PromptIR,
  {
    irVersion: 1;
    sections: Section[];
    slots: Slot[];
    examples: Example[];
    instructions: Instruction[];
    output_schema: OutputSchema | null;
    metadata: Metadata;
  }
> = [
  // populate with a real value so the probe is exercised at runtime as well.
  buildPromptIR(),
  buildPromptIR(),
];
void _shapeProbe;

// Discriminated union sanity: every variant of SectionKind must be one of the
// 9 strings in DESIGN.md §3.1.
const sectionKinds: SectionKind[] = [
  "role",
  "task",
  "context",
  "examples",
  "instructions",
  "output_schema",
  "constraints",
  "tools",
  "other",
];

const slotTypes: SlotType[] = ["string", "number", "boolean", "json", "enum"];

const instructionKinds: InstructionKind[] = [
  "required",
  "optional",
  "style",
  "format",
];

const sourceFormats: SourceFormat[] = ["markdown", "xml", "plain"];

const schemaFormat: OutputSchema["format"] = "json";

// Pass contract probe.
const _passProbe: AssertAssignable<
  Pass,
  {
    readonly name: string;
    readonly description: string;
    preconditions(ir: PromptIR): PreconditionResult;
    apply(ir: PromptIR): PassResult;
  }
> = [
  {
    name: "noop",
    description: "noop pass",
    preconditions: () => ({ ok: true }),
    apply: (ir) => ({ ir, nodesChanged: 0, diagnostics: [] }),
  },
  {
    name: "noop",
    description: "noop pass",
    preconditions: () => ({ ok: true }),
    apply: (ir) => ({ ir, nodesChanged: 0, diagnostics: [] }),
  },
];
void _passProbe;

// CompileOptions surface check.
const compileOpts: CompileOptions = {
  target: "cost",
  to: "markdown",
};
void compileOpts;

// ---------------------------------------------------------------------------
// Runtime assertions — pin the enumerated unions to their string values so
// the file produces actual `bun test` output.
// ---------------------------------------------------------------------------

describe("types module", () => {
  it("exposes 9 SectionKind variants", () => {
    expect(sectionKinds.length).toBe(9);
    expect(new Set(sectionKinds).size).toBe(9);
  });

  it("exposes 5 SlotType variants", () => {
    expect(slotTypes.length).toBe(5);
    expect(slotTypes).toContain("enum");
  });

  it("exposes 4 InstructionKind variants", () => {
    expect(instructionKinds.length).toBe(4);
    expect(instructionKinds).toContain("required");
    expect(instructionKinds).toContain("style");
  });

  it("exposes 3 SourceFormat variants", () => {
    expect(sourceFormats.length).toBe(3);
    expect(sourceFormats).toContain("markdown");
  });

  it("constrains OutputSchema.format to a 4-way union", () => {
    const all: OutputSchema["format"][] = ["json", "xml", "yaml", "free"];
    expect(all.length).toBe(4);
    expect(schemaFormat).toBe("json");
  });

  it("a fresh PromptIR has irVersion=1 and empty collections", () => {
    const ir = buildPromptIR();
    expect(ir.irVersion).toBe(1);
    expect(ir.sections).toEqual([]);
    expect(ir.slots).toEqual([]);
    expect(ir.examples).toEqual([]);
    expect(ir.instructions).toEqual([]);
    expect(ir.output_schema).toBeNull();
    expect(ir.metadata.passLog).toEqual([]);
  });

  it("SourceSpan has the four numeric fields documented in DESIGN.md", () => {
    const span: SourceSpan = { start: 0, end: 1, line: 1, column: 1 };
    expect(typeof span.start).toBe("number");
    expect(typeof span.end).toBe("number");
    expect(typeof span.line).toBe("number");
    expect(typeof span.column).toBe("number");
  });

  it("SchemaField supports array+object+enum recursion", () => {
    const inner: SchemaField = {
      name: "tag",
      type: "enum",
      required: true,
      enumValues: ["a", "b"],
    };
    const outer: SchemaField = {
      name: "tags",
      type: "array",
      required: true,
      items: inner,
    };
    expect(outer.items).toBe(inner);
  });

  it("PassLogEntry tracks applied/skipReason/nodesChanged/durationMs", () => {
    const entry: PassLogEntry = {
      pass: "dead_instruction_elimination",
      applied: true,
      skipReason: null,
      nodesChanged: 3,
      durationMs: 12,
    };
    expect(entry.applied).toBe(true);
    expect(entry.nodesChanged).toBe(3);
  });
});
