// packages/cli/src/parse.ts
//
// CLI-side parse adapter. Tries to delegate to `@promptc/parser`'s
// format-specific entry points when available, and falls back to small local
// shims so the CLI works even when the parser package is still landing.
//
// The local shims are deliberately minimal: they recognise heading-style
// section boundaries for markdown, top-level `<tag>...</tag>` blocks for XML,
// and uppercased section headers for plain text. They never throw — the CLI
// uses `validateIR` afterwards to catch any shape problems.

import {
  addExample,
  addInstruction,
  addSection,
  addSlot,
  buildPromptIR,
  setMetadata,
  type PromptIR,
  type SectionKind,
  type SourceFormat,
} from "@promptc/ir";

import * as ParserModule from "@promptc/parser";

const PARSER_MOD: Record<string, unknown> = ParserModule as unknown as Record<
  string,
  unknown
>;

/**
 * Resolve a parse function for the requested surface format.
 * Falls back to the local shim if the parser package doesn't export one.
 */
export function parseSource(source: string, format: SourceFormat): PromptIR {
  const candidates = [
    `parse${capitalize(format)}`, // e.g. parseMarkdown
    `parse_${format}`,
    `parse${capitalize(format)}Source`,
    `${format}Parse`,
  ];
  for (const key of candidates) {
    const fn = PARSER_MOD[key];
    if (typeof fn === "function") {
      const ir = (fn as (src: string) => PromptIR)(source);
      return ir;
    }
  }
  // Optional `parse(source, { format })` style entry point (matches the
  // parser package's actual signature). Also try `{ from }` for an
  // alternate convention used by earlier drafts.
  const generic = PARSER_MOD["parse"];
  if (typeof generic === "function") {
    const fn = generic as (
      src: string,
      opts: { format?: SourceFormat; from?: SourceFormat },
    ) => PromptIR;
    return fn(source, { format, from: format });
  }
  return fallbackParse(source, format);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Fallback parsers — minimal, deterministic, no external deps.
// ---------------------------------------------------------------------------

function fallbackParse(source: string, format: SourceFormat): PromptIR {
  switch (format) {
    case "markdown":
      return fallbackMarkdown(source);
    case "xml":
      return fallbackXml(source);
    case "plain":
      return fallbackPlain(source);
  }
}

function fallbackMarkdown(source: string): PromptIR {
  let ir = buildPromptIR({
    sourceFormat: "markdown",
    rawSource: source,
    sourceHash: hashSync(source),
  });
  ir = setMetadata(ir, { sourceFormat: "markdown" });

  // Split on ATX headings.
  const blocks = splitMarkdownByHeading(source);
  for (const block of blocks) {
    const kind = inferKind(block.heading);
    const body = block.body.trim();
    ir = addSection(ir, kind, body, { heading: block.heading });
    const sid = ir.sections[ir.sections.length - 1]!.id;

    if (kind === "instructions" || kind === "constraints") {
      const items = extractBulletList(body);
      for (const item of items) {
        ir = addInstruction(ir, "required", item, { parent: sid });
      }
    } else if (kind === "examples") {
      const examples = extractExamplePairs(body);
      for (const ex of examples) {
        ir = addExample(ir, ex.input, ex.output, {
          label: ex.label,
          parent: sid,
        });
      }
    }

    // Slot recognition.
    for (const slot of extractSlots(body)) {
      ir = addSlot(ir, slot, "string", { appearsIn: [sid] });
    }
  }
  return ir;
}

function fallbackXml(source: string): PromptIR {
  let ir = buildPromptIR({
    sourceFormat: "xml",
    rawSource: source,
    sourceHash: hashSync(source),
  });
  ir = setMetadata(ir, { sourceFormat: "xml" });

  // Strip optional wrapper.
  const stripped = stripPromptRoot(source);
  const blocks = splitTopLevelTags(stripped);
  for (const b of blocks) {
    const kind = inferKind(b.tag);
    const body = b.body.trim();
    ir = addSection(ir, kind, body, { heading: b.tag });
    const sid = ir.sections[ir.sections.length - 1]!.id;
    if (kind === "instructions") {
      for (const item of extractItemTags(body)) {
        ir = addInstruction(ir, "required", item, { parent: sid });
      }
    } else if (kind === "examples") {
      for (const ex of extractExampleTags(body)) {
        ir = addExample(ir, ex.input, ex.output, {
          label: ex.label,
          parent: sid,
        });
      }
    }
    for (const slot of extractSlots(body)) {
      ir = addSlot(ir, slot, "string", { appearsIn: [sid] });
    }
  }
  return ir;
}

function fallbackPlain(source: string): PromptIR {
  let ir = buildPromptIR({
    sourceFormat: "plain",
    rawSource: source,
    sourceHash: hashSync(source),
  });
  ir = setMetadata(ir, { sourceFormat: "plain" });

  // Split by uppercased section-header lines.
  const blocks = splitPlainByHeader(source);
  for (const b of blocks) {
    const kind = inferKind(b.heading);
    ir = addSection(ir, kind, b.body.trim(), { heading: b.heading });
    const sid = ir.sections[ir.sections.length - 1]!.id;
    if (kind === "instructions" || kind === "constraints") {
      for (const item of extractBulletList(b.body)) {
        ir = addInstruction(ir, "required", item, { parent: sid });
      }
    } else if (kind === "examples") {
      for (const ex of extractExamplePairs(b.body)) {
        ir = addExample(ir, ex.input, ex.output, {
          label: ex.label,
          parent: sid,
        });
      }
    }
    for (const slot of extractSlots(b.body)) {
      ir = addSlot(ir, slot, "string", { appearsIn: [sid] });
    }
  }
  return ir;
}

// ---------------------------------------------------------------------------
// Block + element extractors
// ---------------------------------------------------------------------------

interface MdBlock {
  heading: string;
  body: string;
}

function splitMarkdownByHeading(source: string): MdBlock[] {
  const lines = source.split("\n");
  const out: MdBlock[] = [];
  let current: MdBlock | null = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (current) out.push(current);
      current = { heading: (m[2] ?? "").trim(), body: "" };
      continue;
    }
    if (current === null) {
      current = { heading: "", body: "" };
    }
    current.body += line + "\n";
  }
  if (current) out.push(current);
  // Drop the leading empty-heading block if body is empty.
  if (out.length > 0 && out[0]!.heading === "" && out[0]!.body.trim() === "") {
    out.shift();
  }
  return out;
}

interface XmlBlock {
  tag: string;
  body: string;
}

function stripPromptRoot(src: string): string {
  const m = src.match(/<prompt(?:\s[^>]*)?>([\s\S]*)<\/prompt>/);
  return m ? (m[1] ?? "") : src;
}

function splitTopLevelTags(src: string): XmlBlock[] {
  const out: XmlBlock[] = [];
  let cursor = 0;
  const len = src.length;
  while (cursor < len) {
    // Find next top-level open tag.
    const open = src.indexOf("<", cursor);
    if (open === -1) break;
    if (src[open + 1] === "/" || src[open + 1] === "!") {
      cursor = open + 1;
      continue;
    }
    const tagEnd = src.indexOf(">", open);
    if (tagEnd === -1) break;
    const tagSpec = src.slice(open + 1, tagEnd);
    const tag = (tagSpec.split(/\s/)[0] ?? "").trim();
    if (tag.length === 0 || tagSpec.endsWith("/")) {
      cursor = tagEnd + 1;
      continue;
    }
    // Find matching close tag, naive depth tracking.
    const closeTag = `</${tag}>`;
    const openTagRe = new RegExp(`<${tag}(?:\\s|>)`, "g");
    openTagRe.lastIndex = tagEnd + 1;
    let depth = 1;
    let bodyEnd = -1;
    let scan = tagEnd + 1;
    while (scan < len) {
      const nextClose = src.indexOf(closeTag, scan);
      if (nextClose === -1) break;
      openTagRe.lastIndex = scan;
      let nestedOpens = 0;
      let m: RegExpExecArray | null;
      while ((m = openTagRe.exec(src)) !== null && m.index < nextClose) {
        nestedOpens += 1;
      }
      depth += nestedOpens - 1;
      if (depth === 0) {
        bodyEnd = nextClose;
        break;
      }
      scan = nextClose + closeTag.length;
      depth += 1; // accounting for the nested close we just consumed
    }
    if (bodyEnd === -1) {
      cursor = tagEnd + 1;
      continue;
    }
    const body = src.slice(tagEnd + 1, bodyEnd);
    out.push({ tag, body });
    cursor = bodyEnd + closeTag.length;
  }
  return out;
}

function extractItemTags(body: string): string[] {
  const out: string[] = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const text = (m[1] ?? "").trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

interface ParsedExample {
  label: string | null;
  input: string;
  output: string;
}

function extractExampleTags(body: string): ParsedExample[] {
  const out: ParsedExample[] = [];
  const exRe = /<example(?:\s+label="([^"]*)")?\s*>([\s\S]*?)<\/example>/g;
  let m: RegExpExecArray | null;
  while ((m = exRe.exec(body)) !== null) {
    const label = m[1] ?? null;
    const inner = m[2] ?? "";
    const input = inner.match(/<input>([\s\S]*?)<\/input>/)?.[1]?.trim() ?? "";
    const output = inner.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim() ?? "";
    if (input.length > 0 && output.length > 0) {
      out.push({ label, input, output });
    }
  }
  return out;
}

interface PlainBlock {
  heading: string;
  body: string;
}

function splitPlainByHeader(source: string): PlainBlock[] {
  const lines = source.split("\n");
  const out: PlainBlock[] = [];
  let current: PlainBlock | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isHeaderLine(line)) {
      if (current) out.push(current);
      current = { heading: line.trim(), body: "" };
      continue;
    }
    if (current === null) {
      current = { heading: "", body: "" };
    }
    current.body += raw + "\n";
  }
  if (current) out.push(current);
  if (out.length > 0 && out[0]!.heading === "" && out[0]!.body.trim() === "") {
    out.shift();
  }
  return out;
}

function isHeaderLine(line: string): boolean {
  if (line.length === 0) return false;
  if (line.length > 40) return false;
  if (line.includes(" ")) {
    // Allow multi-word uppercase headers like "OUTPUT SCHEMA".
    return /^[A-Z][A-Z0-9 _]*$/.test(line);
  }
  return /^[A-Z][A-Z0-9_]*$/.test(line);
}

function extractBulletList(body: string): string[] {
  const out: string[] = [];
  const lines = body.split("\n");
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (m && (m[1] ?? "").trim().length > 0) {
      out.push((m[1] ?? "").trim());
    }
  }
  return out;
}

function extractExamplePairs(body: string): ParsedExample[] {
  const out: ParsedExample[] = [];
  const lines = body.split("\n");
  let label: string | null = null;
  let input = "";
  let output = "";
  let current: "input" | "output" | null = null;
  const flush = () => {
    if (input.length > 0 && output.length > 0) {
      out.push({ label, input: input.trim(), output: output.trim() });
    }
    label = null;
    input = "";
    output = "";
    current = null;
  };
  for (const line of lines) {
    const stripped = line.trim();
    const labelMatch = stripped.match(/^(?:#\s*)?Example(?:\s*\d+)?:?\s*$/i);
    if (labelMatch) {
      flush();
      label = stripped.replace(/^#\s*/, "").replace(/:$/, "").trim();
      continue;
    }
    const inputMatch = stripped.match(/^(?:Input|User)\s*:\s*(.*)$/i);
    if (inputMatch) {
      current = "input";
      input = appendLine(input, inputMatch[1] ?? "");
      continue;
    }
    const outputMatch = stripped.match(/^(?:Output|Assistant|Answer|Expected)\s*:\s*(.*)$/i);
    if (outputMatch) {
      current = "output";
      output = appendLine(output, outputMatch[1] ?? "");
      continue;
    }
    if (current === "input" && stripped.length > 0) {
      input = appendLine(input, stripped);
    } else if (current === "output" && stripped.length > 0) {
      output = appendLine(output, stripped);
    }
  }
  flush();
  return out;
}

function appendLine(buf: string, line: string): string {
  if (buf.length === 0) return line;
  return buf + "\n" + line;
}

function extractSlots(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1] ?? "";
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section-kind synonyms — kept consistent with the parser package's table.
// ---------------------------------------------------------------------------

function inferKind(heading: string): SectionKind {
  const norm = heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (norm === "") return "other";
  const direct = SYNONYMS.get(norm);
  if (direct) return direct;
  const first = norm.split(" ")[0] ?? "";
  return SYNONYMS.get(first) ?? "other";
}

const SYNONYMS = new Map<string, SectionKind>([
  ["role", "role"],
  ["system", "role"],
  ["persona", "role"],
  ["task", "task"],
  ["goal", "task"],
  ["objective", "task"],
  ["context", "context"],
  ["background", "context"],
  ["examples", "examples"],
  ["example", "examples"],
  ["fewshot", "examples"],
  ["fewshots", "examples"],
  ["instructions", "instructions"],
  ["instruction", "instructions"],
  ["rules", "instructions"],
  ["guidelines", "instructions"],
  ["constraints", "constraints"],
  ["constraint", "constraints"],
  ["restrictions", "constraints"],
  ["output", "output_schema"],
  ["outputformat", "output_schema"],
  ["outputschema", "output_schema"],
  ["schema", "output_schema"],
  ["response", "output_schema"],
  ["tools", "tools"],
  ["tool", "tools"],
  ["functions", "tools"],
  ["output_schema", "output_schema"],
]);

function hashSync(s: string): string {
  // The crypto SHA-256 used by the parser package's util is the canonical
  // hash; we use a tiny SubtleCrypto-free fallback here that is deterministic
  // but not cryptographic. The CLI uses this only for the source-hash
  // metadata field; pass-level reproducibility is not affected.
  //
  // FNV-1a 64-bit (returned as hex).
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 = (h1 ^ (code & 0xff)) >>> 0;
    // Multiply by FNV prime 0x100000001b3 — implement as two 32-bit limbs.
    const lo = (h1 * 0x1b3) >>> 0;
    const hi = (h2 * 0x1b3 + Math.floor((h1 * 0x1b3) / 0x100000000)) >>> 0;
    h1 = lo;
    h2 = hi;
  }
  return (h2.toString(16).padStart(8, "0") + h1.toString(16).padStart(8, "0"));
}
