// packages/codegen/src/xml.ts
//
// IR -> XML surface text. Inverse of `@promptc/parser`'s xml reader.
//
// XML schema (per DESIGN.md §3 and parser conventions):
//
//   <prompt>
//     <role>...</role>
//     <task>...</task>
//     <context>...</context>
//     <constraints>...</constraints>
//     <instructions>
//       <item kind="required">text</item>
//       ...
//     </instructions>
//     <examples>
//       <example label="Example 1">
//         <input>...</input>
//         <output>...</output>
//         <rationale>...</rationale>
//       </example>
//     </examples>
//     <output_schema format="json"><![CDATA[...]]></output_schema>
//   </prompt>
//
// Slots are emitted as `<slot name="foo"/>`.

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

export interface XmlCodegenOptions {
  /** Two-space indent by default. */
  indent?: string;
  /** Whether to emit a trailing newline. Default: true. */
  trailingNewline?: boolean;
}

export function toXml(ir: PromptIR, opts: XmlCodegenOptions = {}): string {
  const pad = opts.indent ?? "  ";
  const trailingNewline = opts.trailingNewline ?? true;

  const ordered = orderSections(ir.sections);
  const lines: string[] = ["<prompt>"];

  for (const section of ordered) {
    lines.push(...renderSection(section, ir, pad).map((l) => pad + l));
  }

  if (ir.output_schema && !ordered.some((s) => s.kind === "output_schema")) {
    lines.push(...renderOutputSchema(ir.output_schema, pad).map((l) => pad + l));
  }

  lines.push("</prompt>");
  let out = lines.join("\n");
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

function renderSection(section: Section, ir: PromptIR, pad: string): string[] {
  const tag = tagForKind(section.kind, section.heading);
  const attrs = renderAttrs(section.attrs);
  const open = attrs.length > 0 ? `<${tag}${attrs}>` : `<${tag}>`;
  const close = `</${tag}>`;

  const body = section.body.trim();
  const instr = resolveRefs(section.instructionRefs, ir.instructions);
  const examples = resolveRefs(section.exampleRefs, ir.examples);
  const hasStructured = instr.length > 0 || examples.length > 0;

  // Output schema lives in its own tag inside the section.
  if (section.kind === "output_schema" && ir.output_schema) {
    return renderOutputSchema(ir.output_schema, pad);
  }

  const inner: string[] = [];
  if (!hasStructured && body.length > 0) {
    const escaped = escapeText(body)
      .split("\n")
      .map((l) => (l.length > 0 ? pad + l : ""))
      .join("\n");
    inner.push(...escaped.split("\n"));
  }
  for (const i of instr) {
    inner.push(`${pad}<instruction kind="${escapeAttr(i.kind)}">${escapeText(i.text.trim())}</instruction>`);
  }
  for (const ex of examples) {
    inner.push(...renderExample(ex, pad).map((l) => pad + l));
  }
  if (inner.length === 0) {
    return [open, close];
  }
  return [open, ...inner, close];
}

function renderExample(ex: Example, pad: string): string[] {
  const label = ex.label ? ` label="${escapeAttr(ex.label)}"` : "";
  const out: string[] = [`<example${label}>`];
  out.push(`${pad}<input>${escapeText(ex.input.trim())}</input>`);
  out.push(`${pad}<output>${escapeText(ex.output.trim())}</output>`);
  if (ex.rationale && ex.rationale.trim().length > 0) {
    out.push(`${pad}<rationale>${escapeText(ex.rationale.trim())}</rationale>`);
  }
  out.push("</example>");
  return out;
}

function renderOutputSchema(schema: OutputSchema, pad: string): string[] {
  const open = `<output_schema format="${escapeAttr(schema.format)}">`;
  if (schema.format === "free" || schema.root === null) {
    return [open, "</output_schema>"];
  }
  if (schema.format === "xml") {
    return [open, `${pad}${schemaToXmlTag(schema.root, pad)}`, "</output_schema>"];
  }
  // JSON, YAML, anything else: dump via CDATA to keep XML valid.
  const payload = schema.format === "yaml" ? schemaToYaml(schema.root, 0) : schemaToJson(schema.root);
  return [open, `${pad}<![CDATA[`, payload, `${pad}]]>`, "</output_schema>"];
}

function schemaToJson(field: SchemaField): string {
  return JSON.stringify(shapeOf(field), null, 2);
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

function schemaToXmlTag(field: SchemaField, pad: string): string {
  if (field.type === "object") {
    const inner = (field.fields ?? []).map((f) => schemaToXmlTag(f, pad)).join("\n");
    return `<${field.name}>\n${inner}\n</${field.name}>`;
  }
  return `<${field.name}>${field.type}</${field.name}>`;
}

function schemaToYaml(field: SchemaField, depth: number): string {
  const indent = "  ".repeat(depth);
  if (field.type === "object") {
    const lines = [`${indent}${field.name}:`];
    for (const f of field.fields ?? []) lines.push(schemaToYaml(f, depth + 1));
    return lines.join("\n");
  }
  return `${indent}${field.name}: ${field.type}`;
}

function tagForKind(kind: SectionKind, heading: string): string {
  // For "other" sections, fall back to the heading-derived tag name. We normalize
  // by lower-casing + replacing whitespace with underscores. If still empty, use "section".
  if (kind === "other") {
    const safe = heading.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    return safe.length > 0 ? safe : "section";
  }
  return kind;
}

function renderAttrs(attrs: Record<string, string>): string {
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => ` ${k}="${escapeAttr(attrs[k] ?? "")}"`).join("");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resolveRefs<T extends { id: string }>(ids: string[], pool: T[]): T[] {
  const seen = new Set(ids);
  return pool.filter((n) => seen.has(n.id));
}
