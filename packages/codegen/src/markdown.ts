// packages/codegen/src/markdown.ts
//
// IR -> Markdown surface text. Inverse of `@promptc/parser`'s markdown reader.
//
// Determinism contract (DESIGN.md §5):
//   - Pure function of the input IR. No clock, no RNG, no I/O.
//   - Sections emit in a stable order driven by `SectionKind` priority,
//     ties broken by parse-order (the order they sit in `ir.sections`).
//   - Slots render as `{{name}}` placeholders, identical bytes for identical IR.
//
// Round-trip claim (DESIGN.md §5, invariant 4):
//   For an IR whose `metadata.passLog` is empty and `metadata.sourceFormat === "markdown"`,
//   `parse(codegen(ir, { to: "markdown" }))` is structurally equal to `ir` modulo
//   source spans and trivial whitespace normalization.

import type {
  Example,
  Instruction,
  OutputSchema,
  PromptIR,
  SchemaField,
  Section,
  SectionKind,
  Slot,
} from "@promptc/ir";

/** Heading depth promotion: every section becomes an H2 in markdown by default. */
const DEFAULT_HEADING_LEVEL = 2;

/**
 * Stable ordering for `SectionKind` so codegen is deterministic across IRs that
 * were parsed in a different surface order. Lower number = earlier emission.
 *
 * This mirrors the conventional structure of a system prompt:
 *   role -> task -> context -> constraints -> instructions -> tools -> examples -> output_schema -> other
 */
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

export interface MarkdownCodegenOptions {
  /** Heading level to use for top-level sections (default: 2). */
  headingLevel?: number;
  /** Whether to emit a trailing newline. Default: true. */
  trailingNewline?: boolean;
}

/**
 * Render `ir` as a Markdown string. Pure, deterministic.
 *
 * Section ordering is by `SECTION_PRIORITY` first, then by index in `ir.sections`
 * (parse order). This guarantees that two IRs whose only difference is the order
 * of sections having the same kind priority still produce different bytes — but
 * IRs whose sections are reordered within the same priority bucket produce
 * different bytes too, which is the desired behavior (parse order is data).
 */
export function toMarkdown(ir: PromptIR, opts: MarkdownCodegenOptions = {}): string {
  const headingLevel = opts.headingLevel ?? DEFAULT_HEADING_LEVEL;
  const trailingNewline = opts.trailingNewline ?? true;
  const heading = "#".repeat(Math.max(1, Math.min(6, headingLevel)));

  const ordered = orderSections(ir.sections);
  const parts: string[] = [];

  for (const section of ordered) {
    parts.push(renderSection(section, heading, ir));
  }

  if (ir.output_schema && !ordered.some((s) => s.kind === "output_schema")) {
    parts.push(renderOutputSchemaBlock(ir.output_schema, heading));
  }

  let out = parts.join("\n\n").trimEnd();
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

function renderSection(section: Section, heading: string, ir: PromptIR): string {
  const title = section.heading.trim().length > 0 ? section.heading.trim() : titleForKind(section.kind);
  const blocks: string[] = [`${heading} ${title}`];

  const body = section.body.trim();
  const instr = resolveRefs(section.instructionRefs, ir.instructions);
  const examples = resolveRefs(section.exampleRefs, ir.examples);

  // If this section has structured instructions or examples, prefer the
  // typed list — the body was already lifted into the typed nodes by the
  // parser and would duplicate if rendered verbatim.
  const hasStructured = instr.length > 0 || examples.length > 0;

  if (!hasStructured && body.length > 0) {
    blocks.push(body);
  }

  if (instr.length > 0) {
    blocks.push(renderInstructionList(instr));
  }

  for (const ex of examples) {
    blocks.push(renderExample(ex));
  }

  // Output schema lives inside its section.
  if (section.kind === "output_schema" && ir.output_schema) {
    blocks.push(renderOutputSchemaPayload(ir.output_schema));
  }

  return blocks.join("\n\n");
}

function renderInstructionList(instr: Instruction[]): string {
  return instr.map((i) => `- ${i.text.trim()}`).join("\n");
}

function renderExample(ex: Example): string {
  // Emit each example as a plain `Label / Input / Output` triple so the
  // markdown parser's example scanner can re-parse it (DESIGN.md §5
  // round-trip property). The label form `Example N` (no bold, no heading)
  // matches the parser's expected regex.
  const lines: string[] = [];
  const label = ex.label && ex.label.trim().length > 0 ? ex.label.trim() : "Example";
  lines.push(label);
  lines.push(`Input: ${oneLine(ex.input)}`);
  lines.push(`Output: ${oneLine(ex.output)}`);
  if (ex.rationale && ex.rationale.trim().length > 0) {
    lines.push(`Reasoning: ${oneLine(ex.rationale)}`);
  }
  return lines.join("\n");
}

function renderOutputSchemaBlock(schema: OutputSchema, heading: string): string {
  return `${heading} Output Schema\n\n${renderOutputSchemaPayload(schema)}`;
}

function renderOutputSchemaPayload(schema: OutputSchema): string {
  if (schema.format === "free" || schema.root === null) {
    return "_free-form output_";
  }
  if (schema.format === "json") {
    return "```json\n" + jsonifySchema(schema.root) + "\n```";
  }
  if (schema.format === "xml") {
    return "```xml\n" + xmlifySchema(schema.root) + "\n```";
  }
  if (schema.format === "yaml") {
    return "```yaml\n" + yamlifySchema(schema.root, 0) + "\n```";
  }
  return "```\n" + JSON.stringify(schema.root, null, 2) + "\n```";
}

/** Best-effort JSON-schema-ish stringification. */
function jsonifySchema(field: SchemaField): string {
  return JSON.stringify(fieldToShape(field), null, 2);
}

function fieldToShape(field: SchemaField): unknown {
  switch (field.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of field.fields ?? []) out[f.name] = fieldToShape(f);
      return out;
    }
    case "array":
      return [field.items ? fieldToShape(field.items) : "..."];
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

function xmlifySchema(field: SchemaField): string {
  if (field.type === "object") {
    const inner = (field.fields ?? []).map((f) => xmlifySchema(f)).join("\n");
    return `<${field.name}>\n${indent(inner, 2)}\n</${field.name}>`;
  }
  return `<${field.name}>${field.type}</${field.name}>`;
}

function yamlifySchema(field: SchemaField, depth: number): string {
  const pad = "  ".repeat(depth);
  if (field.type === "object") {
    const lines = [`${pad}${field.name}:`];
    for (const f of field.fields ?? []) lines.push(yamlifySchema(f, depth + 1));
    return lines.join("\n");
  }
  return `${pad}${field.name}: ${field.type}`;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function titleForKind(kind: SectionKind): string {
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

function resolveRefs<T extends { id: string }>(ids: string[], pool: T[]): T[] {
  const seen = new Set(ids);
  return pool.filter((n) => seen.has(n.id));
}

// Re-export slot serializer for parity with xml/plain codegen utilities.
export function renderSlotPlaceholder(slot: Slot): string {
  return `{{${slot.name}}}`;
}
