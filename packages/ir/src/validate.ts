// packages/ir/src/validate.ts
//
// Semantic invariant checks for a PromptIR. Distinct from the structural
// shape check inside `deserializeIR`: validate() assumes the value is
// already shape-valid TypeScript-wise and checks invariants the type system
// cannot encode.
//
// Invariants enforced (from DESIGN.md §3 + the agent brief):
//   I1. Every slot reference in a section/example/instruction must point to
//       a defined slot id.
//   I2. Section ids are unique. (Same applies to slot/example/instruction
//       ids — uniqueness across the whole IR is invariant 3.)
//   I3. Example pairs must have non-empty input + output.
//   I4. Output-schema fields, if present, must be a valid JSON-schema-ish
//       tree (well-formed, no name collisions among siblings, enum/array
//       payloads consistent with the declared type).
//   I5. Parent references (example.parent, instruction.parent) must point
//       to an existing section id (when non-empty).
//   I6. Slot.appearsIn must reference real section ids.
//   I7. Slot.type === "enum" requires enumValues; non-enum forbids enum
//       payload (must be null).

import type {
  Instruction,
  PromptIR,
  SchemaField,
  Section,
} from "./types.js";

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
}

export function validateIR(ir: PromptIR): ValidationOutcome {
  const errors: string[] = [];

  // I2: Section + node id uniqueness.
  const seenIds = new Set<string>();
  const idCollision = (id: string, label: string): void => {
    if (seenIds.has(id)) {
      errors.push(`duplicate node id ${JSON.stringify(id)} (${label})`);
    }
    seenIds.add(id);
  };
  for (const section of ir.sections) idCollision(section.id, "section");
  for (const slot of ir.slots) idCollision(slot.id, "slot");
  for (const example of ir.examples) idCollision(example.id, "example");
  for (const instruction of ir.instructions)
    idCollision(instruction.id, "instruction");
  if (ir.output_schema) idCollision(ir.output_schema.id, "output_schema");

  // Build lookup tables for cross-reference checks.
  const sectionsById = new Map<string, Section>();
  for (const section of ir.sections) sectionsById.set(section.id, section);
  const slotIds = new Set(ir.slots.map((s) => s.id));

  // I1 + I5 + I6: cross-reference integrity.
  for (const section of ir.sections) {
    checkSlotRefs(section.slotRefs, slotIds, errors, `section ${section.id}`);
    for (const ref of section.instructionRefs) {
      if (!ir.instructions.some((i) => i.id === ref)) {
        errors.push(
          `section ${section.id}.instructionRefs references unknown instruction ${ref}`,
        );
      }
    }
    for (const ref of section.exampleRefs) {
      if (!ir.examples.some((e) => e.id === ref)) {
        errors.push(
          `section ${section.id}.exampleRefs references unknown example ${ref}`,
        );
      }
    }
  }

  for (const slot of ir.slots) {
    // I7: enum invariants.
    if (slot.type === "enum") {
      if (slot.enumValues === null) {
        errors.push(`slot ${slot.id} is enum but enumValues is null`);
      } else if (slot.enumValues.length === 0) {
        errors.push(`slot ${slot.id} is enum but enumValues is empty`);
      }
    } else if (slot.enumValues !== null) {
      errors.push(
        `slot ${slot.id} type=${slot.type} but enumValues is not null`,
      );
    }
    // I6: appearsIn must reference real sections.
    for (const sectionId of slot.appearsIn) {
      if (!sectionsById.has(sectionId)) {
        errors.push(
          `slot ${slot.id}.appearsIn references unknown section ${sectionId}`,
        );
      }
    }
  }

  for (const example of ir.examples) {
    // I3: non-empty input + output.
    if (example.input.length === 0) {
      errors.push(`example ${example.id} has empty input`);
    }
    if (example.output.length === 0) {
      errors.push(`example ${example.id} has empty output`);
    }
    // I1
    checkSlotRefs(example.slotRefs, slotIds, errors, `example ${example.id}`);
    // I5
    if (example.parent && !sectionsById.has(example.parent)) {
      errors.push(
        `example ${example.id}.parent references unknown section ${example.parent}`,
      );
    }
  }

  for (const instruction of ir.instructions) {
    // I1
    checkSlotRefs(
      instruction.slotRefs,
      slotIds,
      errors,
      `instruction ${instruction.id}`,
    );
    // I5
    if (instruction.parent && !sectionsById.has(instruction.parent)) {
      errors.push(
        `instruction ${instruction.id}.parent references unknown section ${instruction.parent}`,
      );
    }
    // Sanity: instruction.text must be non-empty (a no-op instruction makes no sense).
    if (instruction.text.length === 0) {
      errors.push(`instruction ${instruction.id} has empty text`);
    }
    pushInstructionVerbWarnings(instruction, errors);
  }

  // I4: output schema validity.
  if (ir.output_schema && ir.output_schema.root) {
    validateSchemaField(ir.output_schema.root, errors, "output_schema.root");
  } else if (ir.output_schema && ir.output_schema.format !== "free") {
    errors.push(
      `output_schema.root is null but format=${JSON.stringify(ir.output_schema.format)} (only "free" allows null root)`,
    );
  }

  return { valid: errors.length === 0, errors };
}

function checkSlotRefs(
  refs: readonly string[],
  slotIds: ReadonlySet<string>,
  errors: string[],
  label: string,
): void {
  for (const ref of refs) {
    if (!slotIds.has(ref)) {
      errors.push(`${label}.slotRefs references unknown slot ${ref}`);
    }
  }
}

function pushInstructionVerbWarnings(
  instruction: Instruction,
  errors: string[],
): void {
  // Non-fatal sanity: required/format instructions tend to have at least one
  // verb. Empty verbs is suspicious but legal — surface as nothing here.
  void instruction;
  void errors;
}

function validateSchemaField(
  field: SchemaField,
  errors: string[],
  path: string,
): void {
  if (!field.name || field.name.length === 0) {
    errors.push(`${path}.name is empty`);
  }
  switch (field.type) {
    case "array": {
      if (!field.items) {
        errors.push(`${path}.items is required for type="array"`);
      } else {
        validateSchemaField(field.items, errors, `${path}.items`);
      }
      break;
    }
    case "object": {
      if (!field.fields) {
        errors.push(`${path}.fields is required for type="object"`);
      } else {
        const seen = new Set<string>();
        for (const child of field.fields) {
          if (seen.has(child.name)) {
            errors.push(
              `${path}.fields has duplicate child name ${JSON.stringify(child.name)}`,
            );
          }
          seen.add(child.name);
          validateSchemaField(child, errors, `${path}.fields[${child.name}]`);
        }
      }
      break;
    }
    case "enum": {
      if (!field.enumValues || field.enumValues.length === 0) {
        errors.push(`${path}.enumValues required (non-empty) for type="enum"`);
      }
      break;
    }
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      break;
  }
}
