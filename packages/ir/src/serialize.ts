// packages/ir/src/serialize.ts
//
// IR <-> canonical JSON. Determinism is non-negotiable: same IR produces the
// same bytes, on every platform, on every run. This is the basis for the
// compile cache key (`metadata.sourceHash` × pass pipeline → output) and for
// the snapshot tests in `@promptc/passes`.
//
// Canonical form rules:
//   1. Keys are emitted in lexicographic order at every object depth.
//   2. Arrays preserve their input order (semantic order is part of the IR).
//   3. Two spaces of indentation, LF line endings, trailing newline.
//   4. No `undefined` values reach the output — JSON has no slot for them.
//
// JSON.stringify with a `replacer` would not suffice on its own because the
// `replacer` callback cannot guarantee key order for plain objects across
// engines. We therefore stringify by hand.

import type { PromptIR } from "./types.js";

/** Thrown by `deserializeIR` when the input is not a valid PromptIR. */
export class IRValidationError extends Error {
  public readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "IRValidationError";
    this.errors = errors;
  }
}

/**
 * Serialize an IR to canonical JSON. Deterministic and stable across runs.
 *
 * Note: this function does not validate the IR. Callers that need to enforce
 * invariants should compose `validateIR` before serialising.
 */
export function serializeIR(ir: PromptIR): string {
  return `${stringifyCanonical(ir, 0)}\n`;
}

/**
 * Parse a canonical-JSON IR back into a typed PromptIR.
 *
 * Validates the structural shape (required fields present, types correct)
 * and throws `IRValidationError` on mismatch. Note: this is *shape*
 * validation, not the deeper invariant check in `validateIR`. Use both
 * together when consuming untrusted input.
 */
export function deserializeIR(json: string): PromptIR {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new IRValidationError(`invalid JSON: ${reason}`);
  }
  const errors: string[] = [];
  if (!isPromptIRShape(parsed, errors)) {
    throw new IRValidationError(
      `value is not a valid PromptIR (${errors.length} error${errors.length === 1 ? "" : "s"})`,
      errors,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Canonical stringifier
// ---------------------------------------------------------------------------

const INDENT_UNIT = "  ";

function stringifyCanonical(value: unknown, depth: number): string {
  if (value === null) return "null";
  const t = typeof value;
  switch (t) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value as number)) {
        throw new IRValidationError(
          `non-finite number cannot be serialised: ${String(value)}`,
        );
      }
      return JSON.stringify(value);
    case "boolean":
      return (value as boolean) ? "true" : "false";
    case "bigint":
      throw new IRValidationError("bigint values are not supported in PromptIR");
    case "function":
    case "symbol":
    case "undefined":
      throw new IRValidationError(
        `unsupported value type in PromptIR: ${t}`,
      );
    case "object":
      if (Array.isArray(value)) {
        return stringifyArray(value, depth);
      }
      return stringifyObject(value as Record<string, unknown>, depth);
    default:
      throw new IRValidationError(`unhandled value type in PromptIR: ${t}`);
  }
}

function stringifyArray(arr: readonly unknown[], depth: number): string {
  if (arr.length === 0) return "[]";
  const inner = INDENT_UNIT.repeat(depth + 1);
  const outer = INDENT_UNIT.repeat(depth);
  const items = arr.map((item) => `${inner}${stringifyCanonical(item, depth + 1)}`);
  return `[\n${items.join(",\n")}\n${outer}]`;
}

function stringifyObject(obj: Record<string, unknown>, depth: number): string {
  // Drop undefined-valued keys to match JSON.stringify semantics.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  if (keys.length === 0) return "{}";
  const inner = INDENT_UNIT.repeat(depth + 1);
  const outer = INDENT_UNIT.repeat(depth);
  const entries = keys.map((k) => {
    const valueStr = stringifyCanonical(obj[k], depth + 1);
    return `${inner}${JSON.stringify(k)}: ${valueStr}`;
  });
  return `{\n${entries.join(",\n")}\n${outer}}`;
}

// ---------------------------------------------------------------------------
// Shape validation (used by deserialize)
// ---------------------------------------------------------------------------

function isPromptIRShape(value: unknown, errors: string[]): value is PromptIR {
  if (!isPlainObject(value)) {
    errors.push("root is not an object");
    return false;
  }
  if (value.irVersion !== 1) {
    errors.push(`irVersion must be 1 (got ${JSON.stringify(value.irVersion)})`);
  }
  expectArray(value, "sections", errors, isSectionShape);
  expectArray(value, "slots", errors, isSlotShape);
  expectArray(value, "examples", errors, isExampleShape);
  expectArray(value, "instructions", errors, isInstructionShape);
  if (
    value.output_schema !== null &&
    !isOutputSchemaShape(value.output_schema, errors)
  ) {
    // expectArray helpers already pushed; nothing extra to do here besides
    // recording the path.
    errors.push("output_schema must be null or an OutputSchema");
  }
  if (!isMetadataShape(value.metadata, errors)) {
    errors.push("metadata is missing or malformed");
  }
  return errors.length === 0;
}

function isSectionShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value)) return push(errors, "section is not an object");
  return (
    expectString(value, "id", errors, "section.id") &&
    expectString(value, "kind", errors, "section.kind") &&
    expectString(value, "heading", errors, "section.heading") &&
    expectString(value, "body", errors, "section.body") &&
    expectSpan(value.source, "section.source", errors) &&
    expectStringArray(value.slotRefs, "section.slotRefs", errors) &&
    expectStringArray(value.instructionRefs, "section.instructionRefs", errors) &&
    expectStringArray(value.exampleRefs, "section.exampleRefs", errors) &&
    expectStringRecord(value.attrs, "section.attrs", errors)
  );
}

function isSlotShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value)) return push(errors, "slot is not an object");
  const enumOk =
    value.enumValues === null ||
    expectStringArray(value.enumValues, "slot.enumValues", errors);
  const defaultOk =
    value.default === null ||
    (typeof value.default === "string" ||
      push(errors, "slot.default must be string or null"));
  return (
    expectString(value, "id", errors, "slot.id") &&
    expectString(value, "name", errors, "slot.name") &&
    expectString(value, "type", errors, "slot.type") &&
    enumOk &&
    defaultOk &&
    typeof value.required === "boolean" &&
    expectSpanArray(value.occurrences, "slot.occurrences", errors) &&
    expectStringArray(value.appearsIn, "slot.appearsIn", errors)
  );
}

function isExampleShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value)) return push(errors, "example is not an object");
  const labelOk =
    value.label === null ||
    (typeof value.label === "string" ||
      push(errors, "example.label must be string or null"));
  const rationaleOk =
    value.rationale === null ||
    (typeof value.rationale === "string" ||
      push(errors, "example.rationale must be string or null"));
  return (
    expectString(value, "id", errors, "example.id") &&
    labelOk &&
    expectString(value, "input", errors, "example.input") &&
    expectString(value, "output", errors, "example.output") &&
    rationaleOk &&
    expectStringArray(value.slotRefs, "example.slotRefs", errors) &&
    expectString(value, "parent", errors, "example.parent") &&
    expectSpan(value.source, "example.source", errors)
  );
}

function isInstructionShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value))
    return push(errors, "instruction is not an object");
  return (
    expectString(value, "id", errors, "instruction.id") &&
    expectString(value, "kind", errors, "instruction.kind") &&
    expectString(value, "text", errors, "instruction.text") &&
    expectStringArray(value.verbs, "instruction.verbs", errors) &&
    expectStringArray(
      value.refersToFields,
      "instruction.refersToFields",
      errors,
    ) &&
    expectStringArray(value.slotRefs, "instruction.slotRefs", errors) &&
    expectString(value, "parent", errors, "instruction.parent") &&
    expectSpan(value.source, "instruction.source", errors)
  );
}

function isOutputSchemaShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value))
    return push(errors, "output_schema is not an object");
  const okFormat =
    typeof value.format === "string" &&
    ["json", "xml", "yaml", "free"].includes(value.format);
  if (!okFormat) push(errors, "output_schema.format invalid");
  const okRoot = value.root === null || isPlainObject(value.root);
  if (!okRoot) push(errors, "output_schema.root must be null or object");
  return (
    expectString(value, "id", errors, "output_schema.id") &&
    okFormat &&
    okRoot &&
    expectSpan(value.source, "output_schema.source", errors)
  );
}

function isMetadataShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value)) return push(errors, "metadata is not an object");
  return (
    expectString(value, "sourceFormat", errors, "metadata.sourceFormat") &&
    expectStringArray(value.tags, "metadata.tags", errors) &&
    expectString(value, "sourceHash", errors, "metadata.sourceHash") &&
    expectString(value, "rawSource", errors, "metadata.rawSource") &&
    Array.isArray(value.passLog) &&
    value.passLog.every((entry) => isPassLogEntryShape(entry, errors))
  );
}

function isPassLogEntryShape(value: unknown, errors: string[]): boolean {
  if (!isPlainObject(value))
    return push(errors, "passLogEntry is not an object");
  const skipOk =
    value.skipReason === null ||
    (typeof value.skipReason === "string" ||
      push(errors, "passLogEntry.skipReason must be string or null"));
  return (
    expectString(value, "pass", errors, "passLogEntry.pass") &&
    typeof value.applied === "boolean" &&
    skipOk &&
    typeof value.nodesChanged === "number" &&
    typeof value.durationMs === "number"
  );
}

// ---------------------------------------------------------------------------
// Predicates / tiny helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function push(errors: string[], msg: string): false {
  errors.push(msg);
  return false;
}

function expectString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  pathLabel: string,
): boolean {
  if (typeof obj[key] !== "string") {
    return push(errors, `${pathLabel} must be a string`);
  }
  return true;
}

function expectStringArray(
  value: unknown,
  pathLabel: string,
  errors: string[],
): boolean {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return push(errors, `${pathLabel} must be string[]`);
  }
  return true;
}

function expectStringRecord(
  value: unknown,
  pathLabel: string,
  errors: string[],
): boolean {
  if (!isPlainObject(value)) {
    return push(errors, `${pathLabel} must be Record<string,string>`);
  }
  for (const v of Object.values(value)) {
    if (typeof v !== "string") {
      return push(errors, `${pathLabel} must be Record<string,string>`);
    }
  }
  return true;
}

function expectSpan(
  value: unknown,
  pathLabel: string,
  errors: string[],
): boolean {
  if (!isPlainObject(value)) {
    return push(errors, `${pathLabel} must be a SourceSpan`);
  }
  const ok =
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    typeof value.line === "number" &&
    typeof value.column === "number";
  if (!ok) return push(errors, `${pathLabel} must be a SourceSpan`);
  return true;
}

function expectSpanArray(
  value: unknown,
  pathLabel: string,
  errors: string[],
): boolean {
  if (!Array.isArray(value)) {
    return push(errors, `${pathLabel} must be SourceSpan[]`);
  }
  return value.every((v) => expectSpan(v, pathLabel, errors));
}

function expectArray(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  itemCheck: (item: unknown, errors: string[]) => boolean,
): boolean {
  const value = obj[key];
  if (!Array.isArray(value)) {
    return push(errors, `${key} must be an array`);
  }
  let ok = true;
  for (const item of value) {
    if (!itemCheck(item, errors)) ok = false;
  }
  return ok;
}
