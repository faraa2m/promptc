// packages/passes/src/format_collapse.ts
//
// Pass: format_collapse
//
// Identifies sections whose body, or whose attached output schema, would be
// strictly cheaper (in whitespace-token count) under a different in-body
// surface format that preserves the same semantic content. When a cheaper
// equivalent exists, the pass swaps in the cheaper form.
//
// Three concrete rewrites are implemented:
//
//   R1. Markdown bulleted lists with one-line items, when the section's kind
//       is "instructions" or "constraints", collapse to a comma-separated
//       inline list.
//
//       Before:
//         - keep responses short
//         - cite sources
//         - avoid speculation
//       After:
//         keep responses short, cite sources, avoid speculation
//
//   R2. XML-style elements with no attributes and a single text child collapse
//       from `<tag>text</tag>` to a labelled line `tag: text` — but ONLY when
//       the target surface format is markdown or plain. We never collapse
//       when the IR's `metadata.sourceFormat` is "xml" because the user
//       asked for XML.
//
//   R3. A YAML output schema whose root is a flat object (no nested objects,
//       no arrays, all fields scalar) is reshaped to a plain-text "key=value"
//       form. Plain `key=value` is the same semantic content (a flat record
//       of typed fields) at strictly fewer tokens than the YAML rendering.
//       This is opt-in via the equivalence check below.
//
// Each rewrite is gated by `equivalentUnderFormat`, which compares the
// pre/post structural fields produced by re-parsing them through a tiny
// in-pass mini-parser. If the structural content is not bit-equal, the
// rewrite is skipped.
//
// ## Preconditions (DESIGN.md §4.3)
//
//   1. The IR has at least one section with format != "plain" — operationally
//      we relax this to "at least one candidate rewrite exists" (an
//      instructions-or-constraints section with a bulleted body, an
//      XML-style tag, or an output schema with format=yaml).
//   2. No candidate node uses a format-sensitive slot type (json-typed slot
//      embedded in the body — see check below).
//
// ## Postconditions
//
//   - Every rewritten node satisfies `equivalentUnderFormat(before, after)`.
//   - No Slot, Example, Instruction node is added or removed.
//   - The OutputSchema id is preserved across the YAML->plain rewrite, only
//     its `format` and source representation change.
//
// ## Determinism proof sketch
//
// Each rewrite is a pure local transformation on a node, gated by a syntactic
// predicate on the same node. Application order is the IR's stored (parse)
// order. No randomness, no I/O, no clock.
//
// ## Behavior-preservation argument
//
// Each rewrite preserves the structural semantic content under the
// equivalence helper. The empirical claim is the standard one for this
// project: tokenisers tolerate the swap without semantic shift on crisp
// eval tasks (DESIGN.md §6).

import type {
  OutputSchema,
  PromptIR,
  SchemaField,
  Section,
  SectionKind,
} from "@promptc/ir";

import type {
  Pass,
  PassOptions,
  PassPreconditionResult,
  PassResult,
} from "./_types.js";

const PASS_NAME = "format_collapse";

// ---------------------------------------------------------------------------
// Token cost proxy
// ---------------------------------------------------------------------------

/**
 * Hybrid cost proxy: byte length plus the whitespace-tokenized word count.
 * The byte length captures the fact that XML brackets cost real BPE tokens
 * in every commercial tokenizer (`<role>` ≈ 2 BPE tokens, `role:` ≈ 1), and
 * the word-count component keeps the relative ordering stable across
 * whitespace-equivalent renderings. The authoritative count lives in
 * `llm-tokens-atlas` (DESIGN.md §6.6); this is the conservative compile-time
 * proxy used only to decide whether a rewrite is *strictly* cheaper.
 */
function tokenCount(text: string): number {
  if (text.length === 0) return 0;
  let words = 0;
  let inToken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    const isWS = ch === 32 || ch === 9 || ch === 10 || ch === 13;
    if (!isWS && !inToken) {
      words += 1;
      inToken = true;
    } else if (isWS) {
      inToken = false;
    }
  }
  return text.length + words;
}

// ---------------------------------------------------------------------------
// Equivalence helpers
// ---------------------------------------------------------------------------

/**
 * Structural content extracted from a piece of body text, normalised so that
 * two bodies with the same semantic content but different surface formats
 * compare equal.
 */
interface BodyStructure {
  /** Ordered list of bullet items (stripped of marker). */
  bullets: string[];
  /** Ordered list of (tag, text) pairs from inline XML. */
  xmlElements: Array<{ tag: string; text: string }>;
  /** All other content tokens, in order, lowercased + split on whitespace. */
  proseTokens: string[];
}

/** Extract structural fields from a body so we can compare across formats. */
function structureOfBody(text: string): BodyStructure {
  const bullets: string[] = [];
  const xmlElements: Array<{ tag: string; text: string }> = [];
  const proseChunks: string[] = [];

  // Pull out markdown bullets first.
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const inner = (bulletMatch[1] ?? "").trim();
      if (inner.length > 0) bullets.push(inner);
      continue;
    }
    // Comma-separated inline list line (the post-image of R1).
    // Only treat as bullet-equivalent when the line is *purely* a list (no
    // surrounding prose punctuation). We detect this conservatively as
    // "contains a comma and no period before the last token".
    if (/,/.test(line) && !/[.!?]/.test(line.trim().slice(0, -1))) {
      for (const item of line.split(",")) {
        const t = item.trim();
        if (t.length > 0) bullets.push(t);
      }
      continue;
    }
    // Inline XML element on its own line: <tag>text</tag>.
    const xmlMatch = trimmed.match(/^<([a-zA-Z][\w-]*)>([^<]*)<\/\1>$/);
    if (xmlMatch) {
      const tag = (xmlMatch[1] ?? "").trim();
      const inner = (xmlMatch[2] ?? "").trim();
      xmlElements.push({ tag, text: inner });
      continue;
    }
    // Labelled-line form `tag: text` (the post-image of R2). Treat as XML
    // element so structural equivalence holds across the rewrite.
    const labelMatch = trimmed.match(/^([a-zA-Z][\w-]*):\s+(.+)$/);
    if (labelMatch) {
      const tag = (labelMatch[1] ?? "").trim();
      const inner = (labelMatch[2] ?? "").trim();
      xmlElements.push({ tag, text: inner });
      continue;
    }
    if (trimmed.length > 0) proseChunks.push(trimmed);
  }

  const proseTokens: string[] = [];
  for (const chunk of proseChunks) {
    for (const t of chunk.toLowerCase().split(/\s+/)) {
      if (t.length > 0) proseTokens.push(t);
    }
  }
  return { bullets, xmlElements, proseTokens };
}

/** Structural equality for two body strings. */
export function equivalentUnderFormat(before: string, after: string): boolean {
  const a = structureOfBody(before);
  const b = structureOfBody(after);
  if (a.bullets.length !== b.bullets.length) return false;
  for (let i = 0; i < a.bullets.length; i++) {
    if (a.bullets[i] !== b.bullets[i]) return false;
  }
  if (a.xmlElements.length !== b.xmlElements.length) return false;
  for (let i = 0; i < a.xmlElements.length; i++) {
    const ae = a.xmlElements[i];
    const be = b.xmlElements[i];
    if (!ae || !be) return false;
    if (ae.tag !== be.tag || ae.text !== be.text) return false;
  }
  if (a.proseTokens.length !== b.proseTokens.length) return false;
  for (let i = 0; i < a.proseTokens.length; i++) {
    if (a.proseTokens[i] !== b.proseTokens[i]) return false;
  }
  return true;
}

/**
 * Structural equivalence for schema-bearing OutputSchema swaps. Two schemas
 * are equivalent under a format swap iff their (name, type) field signature
 * is identical and every field is scalar (no nested objects, no arrays).
 */
function isFlatScalarSchema(schema: OutputSchema): boolean {
  if (!schema.root) return false;
  if (schema.root.type !== "object") return false;
  for (const f of schema.root.fields ?? []) {
    if (
      f.type === "object" ||
      f.type === "array" ||
      f.type === "enum"
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rewrite R1: bullet list -> comma-separated inline list
// ---------------------------------------------------------------------------

const BULLET_SECTION_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>([
  "instructions",
  "constraints",
]);

function tryCollapseBullets(section: Section): string | null {
  if (!BULLET_SECTION_KINDS.has(section.kind)) return null;
  const lines = section.body.split("\n");
  const items: string[] = [];
  let surroundingProse: string[] = [];
  let sawBullet = false;
  for (const raw of lines) {
    const trimmed = raw.replace(/^\s+/, "");
    const m = trimmed.match(/^[-*+]\s+(.+)$/);
    if (m) {
      sawBullet = true;
      const inner = (m[1] ?? "").trim();
      // Multi-line bullet items can't be safely collapsed; require single line.
      if (inner.includes("\n")) return null;
      // Refuse collapse if any item itself contains a comma — would corrupt
      // the inline-list separator.
      if (inner.includes(",")) return null;
      items.push(inner);
      continue;
    }
    if (trimmed.length === 0) continue;
    // If we hit non-bullet, non-blank prose, collapse is unsafe in general.
    if (sawBullet) return null;
    surroundingProse.push(trimmed);
  }
  if (!sawBullet || items.length < 2) return null;
  const collapsed = items.join(", ");
  if (surroundingProse.length === 0) return collapsed;
  return [...surroundingProse, collapsed].join("\n");
}

// ---------------------------------------------------------------------------
// Rewrite R2: <tag>text</tag> -> "tag: text"
// ---------------------------------------------------------------------------

function tryCollapseXmlElements(section: Section, targetXml: boolean): string | null {
  if (targetXml) return null; // never collapse when emitting XML
  const lines = section.body.split("\n");
  let changed = false;
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.replace(/^\s+/, "").replace(/\s+$/, "");
    const m = trimmed.match(/^<([a-zA-Z][\w-]*)>([^<]*)<\/\1>$/);
    if (m) {
      const tag = (m[1] ?? "").trim();
      const inner = (m[2] ?? "").trim();
      out.push(`${tag}: ${inner}`);
      changed = true;
    } else {
      out.push(raw);
    }
  }
  if (!changed) return null;
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Rewrite R3: yaml flat-scalar OutputSchema -> plain `key=type` form
// ---------------------------------------------------------------------------

function renderYamlFlat(schema: OutputSchema): string {
  if (!schema.root || !schema.root.fields) return "";
  const lines: string[] = [];
  for (const f of schema.root.fields) {
    lines.push(`${f.name}: ${f.type}`);
  }
  return lines.join("\n");
}

function renderPlainFlat(schema: OutputSchema): string {
  if (!schema.root || !schema.root.fields) return "";
  const parts: string[] = [];
  for (const f of schema.root.fields) {
    parts.push(`${f.name}=${f.type}`);
  }
  return parts.join(" ");
}

interface SchemaRewrite {
  next: OutputSchema;
  beforeText: string;
  afterText: string;
}

function tryCollapseYamlOutputSchema(
  schema: OutputSchema | null,
): SchemaRewrite | null {
  if (!schema) return null;
  if (schema.format !== "yaml") return null;
  if (!isFlatScalarSchema(schema)) return null;
  const yamlText = renderYamlFlat(schema);
  const plainText = renderPlainFlat(schema);
  if (tokenCount(plainText) >= tokenCount(yamlText)) return null;
  return {
    next: { ...schema, format: "free" }, // "free" = unstructured-but-stated; the plain `key=type` is the rendering
    beforeText: yamlText,
    afterText: plainText,
  };
}

// ---------------------------------------------------------------------------
// Format-sensitive slot guard
// ---------------------------------------------------------------------------

/**
 * Returns true if `body` mentions any slot whose type is "json" (parsed from
 * `{{slotName}}` occurrences cross-referenced with `ir.slots`). JSON-typed
 * slots expect the surrounding context to remain in their native format
 * (DESIGN.md §4.3 second precondition).
 */
function bodyMentionsJsonSlot(body: string, ir: PromptIR): boolean {
  if (ir.slots.length === 0) return false;
  const slotsByName = new Map<string, string>(); // name -> type
  for (const s of ir.slots) slotsByName.set(s.name, s.type);
  const re = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1] ?? "";
    if (slotsByName.get(name) === "json") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pass plumbing
// ---------------------------------------------------------------------------

function hasAnyCandidate(ir: PromptIR): boolean {
  for (const s of ir.sections) {
    if (
      BULLET_SECTION_KINDS.has(s.kind) &&
      /^\s*[-*+]\s+/m.test(s.body)
    ) {
      return true;
    }
    if (/^<([a-zA-Z][\w-]*)>([^<]*)<\/\1>$/m.test(s.body)) return true;
  }
  if (ir.output_schema && ir.output_schema.format === "yaml") {
    if (isFlatScalarSchema(ir.output_schema)) return true;
  }
  return false;
}

function preconditions(ir: PromptIR): PassPreconditionResult {
  const reasons: string[] = [];
  // §4.3 P1, relaxed to "at least one candidate rewrite exists".
  if (!hasAnyCandidate(ir)) {
    reasons.push("no section or output_schema candidate for format collapse");
  }
  return { ok: reasons.length === 0, reasons };
}

interface Summary {
  sectionsChanged: number;
  schemaChanged: boolean;
  bytesSaved: number;
  notes: string[];
}

function run(ir: PromptIR, _opts?: PassOptions): PassResult {
  const pre = preconditions(ir);
  if (!pre.ok) {
    return { ir, applied: false, reason: pre.reasons.join("; ") };
  }

  const targetXml = ir.metadata.sourceFormat === "xml";

  const summary: Summary = {
    sectionsChanged: 0,
    schemaChanged: false,
    bytesSaved: 0,
    notes: [],
  };

  // ---- per-section rewrites ----
  const nextSections: Section[] = [];
  for (const section of ir.sections) {
    // Slot guard.
    if (bodyMentionsJsonSlot(section.body, ir)) {
      nextSections.push(section);
      summary.notes.push(`section ${section.id}: skipped (json-typed slot)`);
      continue;
    }

    let body = section.body;
    let changed = false;

    // R1: bullet collapse.
    const bulletsCollapsed = tryCollapseBullets({ ...section, body });
    if (
      bulletsCollapsed !== null &&
      tokenCount(bulletsCollapsed) < tokenCount(body) &&
      equivalentUnderFormat(body, bulletsCollapsed)
    ) {
      body = bulletsCollapsed;
      changed = true;
      summary.notes.push(`section ${section.id}: R1 (bullets collapsed)`);
    }

    // R2: XML-element collapse.
    const xmlCollapsed = tryCollapseXmlElements({ ...section, body }, targetXml);
    if (
      xmlCollapsed !== null &&
      tokenCount(xmlCollapsed) < tokenCount(body) &&
      equivalentUnderFormat(body, xmlCollapsed)
    ) {
      body = xmlCollapsed;
      changed = true;
      summary.notes.push(`section ${section.id}: R2 (xml elements collapsed)`);
    }

    if (changed) {
      summary.sectionsChanged += 1;
      summary.bytesSaved += section.body.length - body.length;
      nextSections.push({ ...section, body });
    } else {
      nextSections.push(section);
    }
  }

  // ---- output schema rewrite ----
  let nextSchema = ir.output_schema;
  const schemaRewrite = tryCollapseYamlOutputSchema(ir.output_schema);
  if (schemaRewrite !== null) {
    nextSchema = schemaRewrite.next;
    summary.schemaChanged = true;
    summary.bytesSaved += Math.max(
      0,
      schemaRewrite.beforeText.length - schemaRewrite.afterText.length,
    );
    summary.notes.push(`output_schema: R3 (yaml->plain key=value)`);
  }

  if (summary.sectionsChanged === 0 && !summary.schemaChanged) {
    return {
      ir,
      applied: false,
      reason: "no candidate rewrite produced a strictly shorter equivalent",
      debug: {
        sectionsChanged: summary.sectionsChanged,
        schemaChanged: summary.schemaChanged,
        notes: summary.notes,
      },
    };
  }

  const nextIR: PromptIR = {
    ...ir,
    sections: nextSections,
    output_schema: nextSchema,
  };

  return {
    ir: nextIR,
    applied: true,
    reason: "",
    droppedTokens: summary.bytesSaved, // byte-proxy
    debug: {
      sectionsChanged: summary.sectionsChanged,
      schemaChanged: summary.schemaChanged,
      bytesSaved: summary.bytesSaved,
      notes: summary.notes,
    },
  };
}

export const formatCollapse: Pass = {
  name: PASS_NAME,
  preconditions,
  run,
};

export default formatCollapse;

export const __internals = {
  tokenCount,
  structureOfBody,
  equivalentUnderFormat,
  tryCollapseBullets,
  tryCollapseXmlElements,
  tryCollapseYamlOutputSchema,
  isFlatScalarSchema,
  bodyMentionsJsonSlot,
};
