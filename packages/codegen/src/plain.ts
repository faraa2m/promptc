// packages/codegen/src/plain.ts
//
// IR -> plain text. Sections concatenated with blank-line separators, prefixed
// by a single uppercase section header line ("ROLE", "TASK", ...) to keep the
// surface parseable back into an IR.

import type {
  Example,
  OutputSchema,
  PromptIR,
  SchemaField,
  Section,
  SectionKind,
} from "@promptc/ir";

const SECTION_PRIORITY: Record<SectionKind, number> = {
  role: 0,
  task: 1,
  context: 2,
  constraints: 3,
  instructions: 4,
  tools: 5,
  examples: 6,
  output_schema: 7,
  other: 8,
};

export interface PlainCodegenOptions {
  /** Whether to emit a trailing newline. Default: true. */
  trailingNewline?: boolean;
}

export function toPlain(ir: PromptIR, opts: PlainCodegenOptions = {}): string {
  const trailingNewline = opts.trailingNewline ?? true;
  const ordered = orderSections(ir.sections);
  const parts: string[] = [];

  for (const section of ordered) {
    parts.push(renderSection(section, ir));
  }

  if (ir.output_schema && !ordered.some((s) => s.kind === "output_schema")) {
    parts.push(renderOutputSchemaBlock(ir.output_schema));
  }

  let out = parts.filter((p) => p.length > 0).join("\n\n").trimEnd();
  if (trailingNewline) out += "\n";
  return out;
}

function orderSections(sections: Section[]): Section[] {
  return [...sections]
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => {
      const pa = SECTION_PRIORITY[a.s.kind];
      const pb = SECTION_PRIORITY[b.s.kind];
      if (pa !== pb) return pa - pb;
      return a.idx - b.idx;
    })
    .map(({ s }) => s);
}

function renderSection(section: Section, ir: PromptIR): string {
  const header = headerForKind(section.kind, section.heading);
  const lines: string[] = [header];

  const body = section.body.trim();
  const instr = resolveRefs(section.instructionRefs, ir.instructions);
  const examples = resolveRefs(section.exampleRefs, ir.examples);
  const hasStructured = instr.length > 0 || examples.length > 0;

  if (!hasStructured && body.length > 0) {
    lines.push(body);
  }

  if (instr.length > 0) {
    for (const i of instr) lines.push(`- ${i.text.trim()}`);
  }

  for (const ex of examples) {
    lines.push("");
    lines.push(...renderExample(ex));
  }

  if (section.kind === "output_schema" && ir.output_schema) {
    lines.push("");
    lines.push(renderOutputSchemaPayload(ir.output_schema));
  }

  return lines.join("\n");
}

function renderExample(ex: Example): string[] {
  const out: string[] = [];
  out.push(`# ${ex.label ?? "Example"}`);
  out.push(`Input: ${oneLine(ex.input)}`);
  out.push(`Output: ${oneLine(ex.output)}`);
  if (ex.rationale && ex.rationale.trim().length > 0) {
    out.push(`Reasoning: ${oneLine(ex.rationale)}`);
  }
  return out;
}

function renderOutputSchemaBlock(schema: OutputSchema): string {
  return `OUTPUT_SCHEMA\n${renderOutputSchemaPayload(schema)}`;
}

function renderOutputSchemaPayload(schema: OutputSchema): string {
  if (schema.format === "free" || schema.root === null) return "(free-form output)";
  return JSON.stringify(shapeOf(schema.root), null, 2);
}

function shapeOf(field: SchemaField): unknown {
  switch (field.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of field.fields ?? []) out[f.name] = shapeOf(f);
      return out;
    }
    case "array":
      return [field.items ? shapeOf(field.items) : "..."];
    case "enum":
      return field.enumValues ?? [];
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return field.type;
  }
}

function headerForKind(kind: SectionKind, heading: string): string {
  if (kind === "other") {
    return heading.trim().length > 0 ? heading.trim().toUpperCase() : "SECTION";
  }
  return kind.toUpperCase();
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function resolveRefs<T extends { id: string }>(ids: string[], pool: T[]): T[] {
  const seen = new Set(ids);
  return pool.filter((n) => seen.has(n.id));
}
