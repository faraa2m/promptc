// packages/ir/src/builders.ts
//
// Pure fluent builders for constructing PromptIR values in tests and parsers.
// Every builder returns a NEW IR (no in-place mutation), satisfying invariant
// (2) "Immutable in transit" from DESIGN.md §3.
//
// Builders are deliberately small and uncomposed — they are the moral
// equivalent of `cons` for a linked list. Parsers build IRs out of these;
// passes use the same primitives to produce new IRs.

import type {
  Example,
  Instruction,
  InstructionKind,
  Metadata,
  NodeId,
  OutputSchema,
  PromptIR,
  Section,
  SectionKind,
  Slot,
  SlotType,
  SourceFormat,
  SourceSpan,
} from "./types.js";

/** Origin-zero source span, used when nodes are constructed in tests. */
const ZERO_SPAN: SourceSpan = { start: 0, end: 0, line: 1, column: 1 };

/**
 * Deep-clone an IR so the returned value shares no references with the input.
 *
 * `structuredClone` is available in every supported runtime (Node 17+, Bun
 * 1.x, modern browsers) and handles nested arrays + plain objects cleanly.
 * The PromptIR shape is intentionally pure data (no Date, no Map, no
 * functions on nodes — see DESIGN.md §3 invariant 1) so this is a faithful
 * deep clone.
 */
export function cloneIR(ir: PromptIR): PromptIR {
  return structuredClone(ir);
}

export interface BuildPromptIROptions {
  sourceFormat?: SourceFormat;
  rawSource?: string;
  sourceHash?: string;
  tags?: string[];
}

/**
 * Construct an empty PromptIR. All collections are empty arrays; metadata is
 * initialised with caller-supplied defaults or sensible zero values.
 */
export function buildPromptIR(opts: BuildPromptIROptions = {}): PromptIR {
  const metadata: Metadata = {
    sourceFormat: opts.sourceFormat ?? "plain",
    tags: opts.tags ? [...opts.tags] : [],
    sourceHash: opts.sourceHash ?? "",
    rawSource: opts.rawSource ?? "",
    passLog: [],
  };
  return {
    irVersion: 1,
    sections: [],
    slots: [],
    examples: [],
    instructions: [],
    output_schema: null,
    metadata,
  };
}

let nodeCounter = 0;

/**
 * Generate a deterministic-ish node id for use by builders in tests.
 * Real parsers will supply their own ids (typically derived from byte
 * offsets in the source) — see DESIGN.md §3 invariant 3.
 */
function nextId(prefix: string): NodeId {
  nodeCounter += 1;
  return `${prefix}-${nodeCounter.toString(16).padStart(6, "0")}`;
}

/** Reset the test-only id counter. Exposed for deterministic test setup. */
export function __resetNodeIdsForTests(): void {
  nodeCounter = 0;
}

export interface AddSectionOptions {
  id?: NodeId;
  heading?: string;
  source?: SourceSpan;
  slotRefs?: NodeId[];
  instructionRefs?: NodeId[];
  exampleRefs?: NodeId[];
  attrs?: Record<string, string>;
}

/**
 * Append a new Section to a copy of the IR. Returns the new IR; the input
 * is untouched.
 */
export function addSection(
  ir: PromptIR,
  kind: SectionKind,
  body: string,
  opts: AddSectionOptions = {},
): PromptIR {
  const section: Section = {
    id: opts.id ?? nextId("section"),
    kind,
    heading: opts.heading ?? defaultHeadingForKind(kind),
    body,
    source: opts.source ?? ZERO_SPAN,
    slotRefs: opts.slotRefs ? [...opts.slotRefs] : [],
    instructionRefs: opts.instructionRefs ? [...opts.instructionRefs] : [],
    exampleRefs: opts.exampleRefs ? [...opts.exampleRefs] : [],
    attrs: opts.attrs ? { ...opts.attrs } : {},
  };
  const next = cloneIR(ir);
  next.sections.push(section);
  return next;
}

function defaultHeadingForKind(kind: SectionKind): string {
  switch (kind) {
    case "role":
      return "Role";
    case "task":
      return "Task";
    case "context":
      return "Context";
    case "examples":
      return "Examples";
    case "instructions":
      return "Instructions";
    case "output_schema":
      return "Output Schema";
    case "constraints":
      return "Constraints";
    case "tools":
      return "Tools";
    case "other":
      return "Other";
  }
}

export interface AddExampleOptions {
  id?: NodeId;
  label?: string | null;
  rationale?: string | null;
  slotRefs?: NodeId[];
  parent?: NodeId;
  source?: SourceSpan;
}

/**
 * Append an Example. If `opts.parent` is set, the corresponding Section's
 * `exampleRefs` is also updated (still without mutating the original IR).
 */
export function addExample(
  ir: PromptIR,
  input: string,
  output: string,
  opts: AddExampleOptions = {},
): PromptIR {
  const example: Example = {
    id: opts.id ?? nextId("example"),
    label: opts.label ?? null,
    input,
    output,
    rationale: opts.rationale ?? null,
    slotRefs: opts.slotRefs ? [...opts.slotRefs] : [],
    parent: opts.parent ?? "",
    source: opts.source ?? ZERO_SPAN,
  };
  const next = cloneIR(ir);
  next.examples.push(example);
  if (example.parent) {
    const parent = next.sections.find((s) => s.id === example.parent);
    if (parent && !parent.exampleRefs.includes(example.id)) {
      parent.exampleRefs.push(example.id);
    }
  }
  return next;
}

export interface AddInstructionOptions {
  id?: NodeId;
  verbs?: string[];
  refersToFields?: string[];
  slotRefs?: NodeId[];
  parent?: NodeId;
  source?: SourceSpan;
}

/**
 * Append an Instruction. If `opts.parent` is set, the corresponding Section's
 * `instructionRefs` is also updated.
 */
export function addInstruction(
  ir: PromptIR,
  kind: InstructionKind,
  text: string,
  opts: AddInstructionOptions = {},
): PromptIR {
  const instruction: Instruction = {
    id: opts.id ?? nextId("instr"),
    kind,
    text,
    verbs: opts.verbs ? [...opts.verbs] : [],
    refersToFields: opts.refersToFields ? [...opts.refersToFields] : [],
    slotRefs: opts.slotRefs ? [...opts.slotRefs] : [],
    parent: opts.parent ?? "",
    source: opts.source ?? ZERO_SPAN,
  };
  const next = cloneIR(ir);
  next.instructions.push(instruction);
  if (instruction.parent) {
    const parent = next.sections.find((s) => s.id === instruction.parent);
    if (parent && !parent.instructionRefs.includes(instruction.id)) {
      parent.instructionRefs.push(instruction.id);
    }
  }
  return next;
}

export interface AddSlotOptions {
  id?: NodeId;
  enumValues?: string[] | null;
  default?: string | null;
  required?: boolean;
  occurrences?: SourceSpan[];
  appearsIn?: NodeId[];
}

/** Append a Slot. */
export function addSlot(
  ir: PromptIR,
  name: string,
  type: SlotType,
  opts: AddSlotOptions = {},
): PromptIR {
  const slot: Slot = {
    id: opts.id ?? nextId("slot"),
    name,
    type,
    enumValues:
      opts.enumValues === undefined
        ? type === "enum"
          ? []
          : null
        : opts.enumValues === null
          ? null
          : [...opts.enumValues],
    default: opts.default ?? null,
    required: opts.required ?? false,
    occurrences: opts.occurrences ? opts.occurrences.map((s) => ({ ...s })) : [],
    appearsIn: opts.appearsIn ? [...opts.appearsIn] : [],
  };
  const next = cloneIR(ir);
  next.slots.push(slot);
  return next;
}

/**
 * Set (or replace) the IR's output schema. Pass `null` to clear it.
 */
export function setOutputSchema(
  ir: PromptIR,
  schema: OutputSchema | null,
): PromptIR {
  const next = cloneIR(ir);
  next.output_schema = schema === null ? null : structuredClone(schema);
  return next;
}

export interface SetMetadataOptions {
  sourceFormat?: SourceFormat;
  rawSource?: string;
  sourceHash?: string;
  tags?: string[];
}

/**
 * Update top-level metadata fields. Unspecified fields are preserved.
 * `passLog` is never overwritten by this function — passes append to it
 * via `appendPassLogEntry` below.
 */
export function setMetadata(ir: PromptIR, patch: SetMetadataOptions): PromptIR {
  const next = cloneIR(ir);
  if (patch.sourceFormat !== undefined) {
    next.metadata.sourceFormat = patch.sourceFormat;
  }
  if (patch.rawSource !== undefined) {
    next.metadata.rawSource = patch.rawSource;
  }
  if (patch.sourceHash !== undefined) {
    next.metadata.sourceHash = patch.sourceHash;
  }
  if (patch.tags !== undefined) {
    next.metadata.tags = [...patch.tags];
  }
  return next;
}

export interface AppendPassLogEntryInput {
  pass: string;
  applied: boolean;
  skipReason?: string | null;
  nodesChanged?: number;
  durationMs?: number;
}

/**
 * Append a PassLogEntry. Used by `@promptc/passes` to record a pass run.
 */
export function appendPassLogEntry(
  ir: PromptIR,
  entry: AppendPassLogEntryInput,
): PromptIR {
  const next = cloneIR(ir);
  next.metadata.passLog.push({
    pass: entry.pass,
    applied: entry.applied,
    skipReason: entry.skipReason ?? null,
    nodesChanged: entry.nodesChanged ?? 0,
    durationMs: entry.durationMs ?? 0,
  });
  return next;
}
