// packages/ir/src/types.ts
//
// Types lifted verbatim from promptc/DESIGN.md §3.1 — the canonical contract
// landed by `promptc-design` in Phase 2. Downstream packages
// (`@promptc/parser`, `@promptc/passes`, `@promptc/codegen`, `@promptc/cli`)
// consume this module and must not extend the shape without a corresponding
// DESIGN.md revision.

/** Stable identifier for any IR node. Generated at parse time. */
export type NodeId = string;

/** Source location for round-trip + debugging. */
export interface SourceSpan {
  /** Byte offset in the original input. */
  start: number;
  /** Byte offset (exclusive) in the original input. */
  end: number;
  /** 1-indexed line number. */
  line: number;
  /** 1-indexed column number. */
  column: number;
}

/** Surface format the IR was parsed from. */
export type SourceFormat = "markdown" | "xml" | "plain";

/** Section kinds — closed set; unknown kinds parse as "other". */
export type SectionKind =
  | "role"
  | "task"
  | "context"
  | "examples"
  | "instructions"
  | "output_schema"
  | "constraints"
  | "tools"
  | "other";

export interface Section {
  id: NodeId;
  kind: SectionKind;
  /** Heading text as it appeared in the source (Markdown), or tag name (XML). */
  heading: string;
  /** Raw body text; passes may rewrite this. */
  body: string;
  /** Source location in the original input. */
  source: SourceSpan;
  /** Slot references inside this section's body (transitive of slots[]). */
  slotRefs: NodeId[];
  /** Instruction nodes attributed to this section. */
  instructionRefs: NodeId[];
  /** Example nodes attributed to this section. */
  exampleRefs: NodeId[];
  /** Free-form, parser-attached annotations. */
  attrs: Record<string, string>;
}

/** Typed placeholder ({{var}} / <slot name="var"/>). */
export type SlotType = "string" | "number" | "boolean" | "json" | "enum";

export interface Slot {
  id: NodeId;
  name: string;
  type: SlotType;
  /** For SlotType="enum"; null otherwise. */
  enumValues: string[] | null;
  /** Optional default if the caller does not bind. */
  default: string | null;
  /** Whether the slot is required at render time. */
  required: boolean;
  /** Source locations of every occurrence in the IR. */
  occurrences: SourceSpan[];
  /** Section node ids in which this slot appears. */
  appearsIn: NodeId[];
}

/** A few-shot example. */
export interface Example {
  id: NodeId;
  /** Caller-facing label, if any (e.g. "Example 1"). */
  label: string | null;
  /** The input portion of the example (raw). */
  input: string;
  /** The expected output portion. */
  output: string;
  /** Optional rationale (chain-of-thought, "Reasoning:", etc.). */
  rationale: string | null;
  /** Slots referenced inside the input/output (for binding analysis). */
  slotRefs: NodeId[];
  /** Parent section node id. */
  parent: NodeId;
  source: SourceSpan;
}

/** Imperative instruction extracted from the prompt. */
export type InstructionKind = "required" | "optional" | "style" | "format";

export interface Instruction {
  id: NodeId;
  kind: InstructionKind;
  /** The instruction text (after canonicalization). */
  text: string;
  /** Verbs detected (e.g. "respond", "format", "use", "avoid"). */
  verbs: string[];
  /** Output-schema fields this instruction is plausibly about, by name. */
  refersToFields: string[];
  /** Slots this instruction mentions, by id. */
  slotRefs: NodeId[];
  /** Parent section node id. */
  parent: NodeId;
  source: SourceSpan;
}

/** JSON-schema-like output schema; subset for tractable static analysis. */
export type SchemaFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "enum"
  | "null";

export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  required: boolean;
  /** For type="array". */
  items?: SchemaField;
  /** For type="object". */
  fields?: SchemaField[];
  /** For type="enum". */
  enumValues?: string[];
  /** Optional human description; passes may treat as ignorable. */
  description?: string;
}

export interface OutputSchema {
  id: NodeId;
  /** Either "json", "xml", "yaml", or "free" (unstructured but stated). */
  format: "json" | "xml" | "yaml" | "free";
  /** Root schema field; null for "free". */
  root: SchemaField | null;
  source: SourceSpan;
}

/** Bookkeeping attached to the IR. */
export interface Metadata {
  /** Surface format the IR was parsed from. */
  sourceFormat: SourceFormat;
  /** Free-form caller tags (e.g. "qa", "classification"). */
  tags: string[];
  /** SHA-256 of the original source bytes (for cache keys). */
  sourceHash: string;
  /** Original source bytes — kept for round-tripping. */
  rawSource: string;
  /** Names of passes that have run on this IR, in order. */
  passLog: PassLogEntry[];
}

export interface PassLogEntry {
  pass: string;
  /** Whether the pass actually ran (preconditions met). */
  applied: boolean;
  /** Reason for skip, if applied=false. */
  skipReason: string | null;
  /** Number of nodes mutated. */
  nodesChanged: number;
  /** Compile-time ms (informational, not part of behavior). */
  durationMs: number;
}

/** The top-level IR. */
export interface PromptIR {
  /** IR version — bumped on breaking type changes. */
  irVersion: 1;
  sections: Section[];
  slots: Slot[];
  examples: Example[];
  instructions: Instruction[];
  output_schema: OutputSchema | null;
  metadata: Metadata;
}

/** Pass contract — every pass implements this shape. */
export interface Pass {
  /** Stable kebab-case name. */
  readonly name: string;
  /** Short human description (one line). */
  readonly description: string;
  /** Preconditions, declared so the pipeline can skip safely. */
  preconditions(ir: PromptIR): PreconditionResult;
  /** Run the pass. Must be a pure function of `ir`. */
  apply(ir: PromptIR): PassResult;
}

export interface PreconditionResult {
  ok: boolean;
  /** If !ok, why. */
  reason?: string;
}

export interface PassResult {
  /** New IR (never mutated in place). */
  ir: PromptIR;
  /** Number of nodes mutated. */
  nodesChanged: number;
  /** Optional per-pass diagnostics (passes may attach evidence here). */
  diagnostics: string[];
}

/** Compile options accepted by the top-level `compile()` function. */
export interface CompileOptions {
  /** Optimization target — affects pass *selection*, not pass *determinism*. */
  target: "cost" | "tokens" | "none";
  /** Surface format to emit. */
  to: SourceFormat;
  /** Explicit pass order. If omitted, the default deterministic order is used. */
  passes?: string[];
  /** Hard cap on total mutations across all passes (safety rail). */
  maxMutations?: number;
}
