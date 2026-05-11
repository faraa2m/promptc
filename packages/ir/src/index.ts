// @promptc/ir — the typed prompt IR + utilities all downstream packages
// (@promptc/parser, @promptc/passes, @promptc/codegen, @promptc/cli) consume.
//
// Source of truth: /promptc/DESIGN.md (Phase 2 design contract).

export const version = "0.0.1";

export type {
  CompileOptions,
  Example,
  Instruction,
  InstructionKind,
  Metadata,
  NodeId,
  OutputSchema,
  Pass,
  PassLogEntry,
  PassResult,
  PreconditionResult,
  PromptIR,
  SchemaField,
  SchemaFieldType,
  Section,
  SectionKind,
  Slot,
  SlotType,
  SourceFormat,
  SourceSpan,
} from "./types.js";

export {
  __resetNodeIdsForTests,
  addExample,
  addInstruction,
  addSection,
  addSlot,
  appendPassLogEntry,
  buildPromptIR,
  cloneIR,
  setMetadata,
  setOutputSchema,
} from "./builders.js";
export type {
  AddExampleOptions,
  AddInstructionOptions,
  AddSectionOptions,
  AddSlotOptions,
  AppendPassLogEntryInput,
  BuildPromptIROptions,
  SetMetadataOptions,
} from "./builders.js";

export { deserializeIR, IRValidationError, serializeIR } from "./serialize.js";

export { validateIR } from "./validate.js";
export type { ValidationOutcome } from "./validate.js";
