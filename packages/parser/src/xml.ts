// packages/parser/src/xml.ts
//
// A small, dependency-free XML parser tailored to the prompt-engineering
// dialect documented in DESIGN.md §3 (e.g. `<prompt>`, `<role>`, `<task>`,
// `<examples>`, `<example>`, `<input>`, `<output>`).
//
// The parser is intentionally minimal:
//
//   - Recognises start tags `<tag attr="val">`, end tags `</tag>`,
//     self-closing tags `<tag/>`, comments `<!-- ... -->`, and CDATA
//     sections `<![CDATA[ ... ]]>`.
//   - Resolves the five standard entity references in attribute and text
//     content: `&amp; &lt; &gt; &quot; &apos;`. Numeric character
//     references (`&#NN;` / `&#xNN;`) are also resolved.
//   - Strictly rejects DOCTYPE declarations, processing instructions
//     (`<?xml ...?>` is tolerated only at the start), and external entity
//     references — a defense-in-depth posture against XXE attacks.
//   - Ignores XML namespaces: a tag like `<x:role>` is treated as `role`
//     with no namespace tracking.
//
// On malformed input, the parser throws `ParseError` with a precise line
// and column. There is no error recovery — promptc's surface XML dialect
// is small enough that callers can be expected to fix syntax.

import {
  type Example,
  type Instruction,
  type NodeId,
  type PromptIR,
  type Section,
  type SectionKind,
  type SourceSpan,
} from "@promptc/ir";

import { ParseError } from "./errors.js";
import {
  findSlotOccurrences,
  reduceSlots,
  type SlotOccurrence,
} from "./slots.js";
import { hashSource, IdAllocator, LineMap, makeSpan } from "./util.js";

/** Top-level entry: parse an XML source string into an IR. */
export function parseXml(source: string): PromptIR {
  const lineMap = new LineMap(source);
  const ids = new IdAllocator();
  const root = parseDocument(source, lineMap);
  return lowerRootElement(root, source, lineMap, ids);
}

// ---------------------------------------------------------------------------
// Lowering: XmlElement tree -> PromptIR
// ---------------------------------------------------------------------------

function lowerRootElement(
  root: XmlElement,
  source: string,
  lineMap: LineMap,
  ids: IdAllocator,
): PromptIR {
  const sections: Section[] = [];
  const instructions: Instruction[] = [];
  const examples: Example[] = [];
  const slotOccurrences: SlotOccurrence[] = [];

  // If the root tag is `prompt`, descend into its children. Otherwise treat
  // the root itself as a single section.
  const topLevelChildren = isPromptWrapper(root.name)
    ? root.children
    : [root];

  for (const node of topLevelChildren) {
    if (node.kind !== "element") continue;
    const sectionId = ids.next("section");
    const kind = inferSectionKind(node.name);
    const heading = node.name;
    const body = stringifyNodeBody(node);
    const span: SourceSpan = makeSpan(node.span.start, node.span.end, lineMap);
    const section: Section = {
      id: sectionId,
      kind,
      heading,
      body,
      source: span,
      slotRefs: [],
      instructionRefs: [],
      exampleRefs: [],
      attrs: { ...node.attrs, xmlTag: node.name },
    };
    sections.push(section);

    // Slot occurrences in the text content (everything except CDATA-like
    // structural elements — but slot literals inside CDATA are also kept
    // by design, because `{{` is not an XML special character).
    for (const occ of findSlotOccurrencesInElement(
      node,
      sectionId,
      lineMap,
      source,
    )) {
      slotOccurrences.push(occ);
    }

    if (kind === "examples") {
      for (const ex of extractExamplesFromExamplesElement(
        node,
        sectionId,
        ids,
        lineMap,
      )) {
        examples.push(ex);
        section.exampleRefs.push(ex.id);
      }
    }
    if (kind === "instructions" || kind === "constraints") {
      for (const instr of extractInstructionsFromInstructionsElement(
        node,
        sectionId,
        ids,
        lineMap,
      )) {
        instructions.push(instr);
        section.instructionRefs.push(instr.id);
      }
    }
  }

  const { slots, bySectionId } = reduceSlots(slotOccurrences, ids);
  for (const section of sections) {
    const refs = bySectionId.get(section.id);
    if (refs) section.slotRefs = refs;
  }

  return {
    irVersion: 1,
    sections,
    slots,
    examples,
    instructions,
    output_schema: null,
    metadata: {
      sourceFormat: "xml",
      tags: [],
      sourceHash: hashSource(source),
      rawSource: source,
      passLog: [],
    },
  };
}

function isPromptWrapper(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "prompt" || lower === "promptc";
}

function inferSectionKind(tagName: string): SectionKind {
  const lower = tagName.toLowerCase();
  switch (lower) {
    case "role":
    case "system":
    case "persona":
      return "role";
    case "task":
    case "goal":
    case "objective":
      return "task";
    case "context":
    case "background":
      return "context";
    case "examples":
    case "demonstrations":
    case "fewshot":
    case "fewshots":
      return "examples";
    case "instructions":
    case "rules":
    case "guidelines":
      return "instructions";
    case "constraints":
    case "restrictions":
      return "constraints";
    case "output":
    case "output_schema":
    case "outputschema":
    case "schema":
    case "response":
      return "output_schema";
    case "tools":
    case "functions":
      return "tools";
    default:
      return "other";
  }
}

function stringifyNodeBody(node: XmlElement): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.kind === "text") parts.push(child.text);
    else if (child.kind === "element") parts.push(serializeElement(child));
  }
  return parts.join("");
}

function serializeElement(node: XmlElement): string {
  const attrStr = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  if (node.children.length === 0) return `<${node.name}${attrStr}/>`;
  const inner = node.children
    .map((c) => (c.kind === "text" ? c.text : serializeElement(c)))
    .join("");
  return `<${node.name}${attrStr}>${inner}</${node.name}>`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function findSlotOccurrencesInElement(
  node: XmlElement,
  parentSectionId: NodeId,
  lineMap: LineMap,
  source: string,
): SlotOccurrence[] {
  const out: SlotOccurrence[] = [];
  const stack: XmlNode[] = [...node.children];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.kind === "text") {
      // The text node's content is decoded but the raw source positions are
      // recoverable from item.span. We use the SOURCE bytes for slot scans
      // because the slot literal lives in the source, not the decoded form.
      const rawSlice = source.slice(item.span.start, item.span.end);
      const occurrences = findSlotOccurrences(
        rawSlice,
        item.span.start,
        parentSectionId,
        lineMap,
      );
      for (const o of occurrences) out.push(o);
    } else if (item.kind === "element") {
      for (const child of item.children) stack.push(child);
    }
  }
  return out;
}

function extractExamplesFromExamplesElement(
  examplesNode: XmlElement,
  parentSectionId: NodeId,
  ids: IdAllocator,
  lineMap: LineMap,
): Example[] {
  const out: Example[] = [];
  for (const child of examplesNode.children) {
    if (child.kind !== "element") continue;
    if (child.name.toLowerCase() !== "example") continue;
    let input = "";
    let output = "";
    let rationale: string | null = null;
    let label: string | null = child.attrs["label"] ?? null;
    for (const sub of child.children) {
      if (sub.kind !== "element") continue;
      const subName = sub.name.toLowerCase();
      const subText = collectText(sub);
      if (subName === "input" || subName === "user") {
        input = subText;
      } else if (
        subName === "output" ||
        subName === "expected" ||
        subName === "assistant" ||
        subName === "answer"
      ) {
        output = subText;
      } else if (
        subName === "rationale" ||
        subName === "reasoning" ||
        subName === "thought"
      ) {
        rationale = subText;
      } else if (subName === "label") {
        label = subText.trim() || label;
      }
    }
    out.push({
      id: ids.next("example"),
      label,
      input: input.trim(),
      output: output.trim(),
      rationale: rationale === null ? null : rationale.trim() || null,
      slotRefs: [],
      parent: parentSectionId,
      source: makeSpan(child.span.start, child.span.end, lineMap),
    });
  }
  return out;
}

function extractInstructionsFromInstructionsElement(
  node: XmlElement,
  parentSectionId: NodeId,
  ids: IdAllocator,
  lineMap: LineMap,
): Instruction[] {
  const out: Instruction[] = [];
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    const name = child.name.toLowerCase();
    if (name !== "instruction" && name !== "rule" && name !== "constraint") {
      continue;
    }
    const text = collectText(child).trim();
    if (text === "") continue;
    const kindAttr = child.attrs["kind"]?.toLowerCase();
    const kind =
      kindAttr === "optional" ||
      kindAttr === "required" ||
      kindAttr === "style" ||
      kindAttr === "format"
        ? kindAttr
        : "required";
    out.push({
      id: ids.next("instr"),
      kind,
      text,
      verbs: [],
      refersToFields: [],
      slotRefs: [],
      parent: parentSectionId,
      source: makeSpan(child.span.start, child.span.end, lineMap),
    });
  }
  return out;
}

function collectText(node: XmlElement): string {
  const buf: string[] = [];
  const stack: XmlNode[] = [...node.children];
  while (stack.length > 0) {
    const top = stack.shift();
    if (!top) break;
    if (top.kind === "text") buf.push(top.text);
    else if (top.kind === "element") {
      // For nested elements, recursively join with no surrounding tags.
      for (let i = top.children.length - 1; i >= 0; i -= 1) {
        const c = top.children[i];
        if (c) stack.unshift(c);
      }
    }
  }
  return buf.join("");
}

// ---------------------------------------------------------------------------
// Tokeniser / parser
// ---------------------------------------------------------------------------

interface XmlElement {
  kind: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  span: { start: number; end: number };
}

interface XmlText {
  kind: "text";
  text: string;
  span: { start: number; end: number };
}

type XmlNode = XmlElement | XmlText;

function parseDocument(source: string, lineMap: LineMap): XmlElement {
  const ctx: Ctx = { source, pos: 0, lineMap };
  skipProlog(ctx);
  skipWhitespaceAndComments(ctx);
  if (ctx.pos >= ctx.source.length) {
    throw error(ctx, "empty XML document");
  }
  const root = parseElement(ctx);
  skipWhitespaceAndComments(ctx);
  if (ctx.pos < ctx.source.length) {
    // Allow trailing whitespace already consumed; anything else is junk.
    const rest = ctx.source.slice(ctx.pos).trim();
    if (rest !== "") {
      throw error(ctx, "unexpected content after root element");
    }
  }
  return root;
}

interface Ctx {
  readonly source: string;
  pos: number;
  readonly lineMap: LineMap;
}

function error(ctx: Ctx, message: string): ParseError {
  const loc = ctx.lineMap.locate(ctx.pos);
  return new ParseError(
    message,
    { line: loc.line, column: loc.column, offset: ctx.pos },
    "xml",
  );
}

function skipProlog(ctx: Ctx): void {
  skipWhitespace(ctx);
  // Optional `<?xml ... ?>` declaration.
  if (ctx.source.startsWith("<?xml", ctx.pos)) {
    const end = ctx.source.indexOf("?>", ctx.pos);
    if (end < 0) throw error(ctx, "unterminated <?xml ?> declaration");
    ctx.pos = end + 2;
  }
  skipWhitespaceAndComments(ctx);
  // Reject DOCTYPE declarations to harden against XXE.
  if (ctx.source.startsWith("<!DOCTYPE", ctx.pos)) {
    throw error(ctx, "DOCTYPE declarations are not supported");
  }
}

function skipWhitespace(ctx: Ctx): void {
  while (ctx.pos < ctx.source.length) {
    const c = ctx.source.charCodeAt(ctx.pos);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) ctx.pos += 1;
    else break;
  }
}

function skipWhitespaceAndComments(ctx: Ctx): void {
  let progress = true;
  while (progress) {
    progress = false;
    skipWhitespace(ctx);
    if (ctx.source.startsWith("<!--", ctx.pos)) {
      const end = ctx.source.indexOf("-->", ctx.pos + 4);
      if (end < 0) throw error(ctx, "unterminated comment");
      ctx.pos = end + 3;
      progress = true;
    }
  }
}

function parseElement(ctx: Ctx): XmlElement {
  const start = ctx.pos;
  if (ctx.source.charCodeAt(ctx.pos) !== 0x3c /* '<' */) {
    throw error(ctx, "expected '<'");
  }
  ctx.pos += 1;
  // Reject processing instructions and unsupported `<!...` constructs.
  const next = ctx.source.charCodeAt(ctx.pos);
  if (next === 0x3f /* '?' */) {
    throw error(ctx, "processing instructions are not supported");
  }
  if (next === 0x21 /* '!' */) {
    throw error(ctx, "unsupported '<!...' construct");
  }
  const name = readName(ctx);
  if (name === "") throw error(ctx, "expected element name");
  const attrs: Record<string, string> = {};
  while (true) {
    skipWhitespace(ctx);
    const ch = ctx.source.charCodeAt(ctx.pos);
    if (ch === 0x2f /* '/' */) {
      ctx.pos += 1;
      if (ctx.source.charCodeAt(ctx.pos) !== 0x3e /* '>' */) {
        throw error(ctx, "expected '>' after '/'");
      }
      ctx.pos += 1;
      return {
        kind: "element",
        name,
        attrs,
        children: [],
        span: { start, end: ctx.pos },
      };
    }
    if (ch === 0x3e /* '>' */) {
      ctx.pos += 1;
      break;
    }
    if (ctx.pos >= ctx.source.length) {
      throw error(ctx, "unexpected EOF inside start tag");
    }
    const attrName = readName(ctx);
    if (attrName === "") {
      throw error(ctx, "expected attribute name or '>'");
    }
    skipWhitespace(ctx);
    if (ctx.source.charCodeAt(ctx.pos) !== 0x3d /* '=' */) {
      throw error(ctx, `expected '=' after attribute '${attrName}'`);
    }
    ctx.pos += 1;
    skipWhitespace(ctx);
    const attrValue = readAttrValue(ctx);
    attrs[attrName] = attrValue;
  }
  // Element body: read children until matching end tag.
  const children: XmlNode[] = [];
  while (true) {
    if (ctx.pos >= ctx.source.length) {
      throw error(ctx, `unterminated element '${name}'`);
    }
    if (ctx.source.startsWith("</", ctx.pos)) {
      const endTagStart = ctx.pos;
      ctx.pos += 2;
      const endName = readName(ctx);
      skipWhitespace(ctx);
      if (ctx.source.charCodeAt(ctx.pos) !== 0x3e /* '>' */) {
        throw error(ctx, `expected '>' to close end tag '</${endName}>'`);
      }
      ctx.pos += 1;
      if (endName !== name) {
        throw new ParseError(
          `mismatched tag: '<${name}>' closed by '</${endName}>'`,
          {
            line: ctx.lineMap.locate(endTagStart).line,
            column: ctx.lineMap.locate(endTagStart).column,
            offset: endTagStart,
          },
          "xml",
        );
      }
      return {
        kind: "element",
        name,
        attrs,
        children,
        span: { start, end: ctx.pos },
      };
    }
    if (ctx.source.startsWith("<!--", ctx.pos)) {
      const end = ctx.source.indexOf("-->", ctx.pos + 4);
      if (end < 0) throw error(ctx, "unterminated comment");
      ctx.pos = end + 3;
      continue;
    }
    if (ctx.source.startsWith("<![CDATA[", ctx.pos)) {
      const cdataStart = ctx.pos;
      const end = ctx.source.indexOf("]]>", ctx.pos + 9);
      if (end < 0) throw error(ctx, "unterminated CDATA section");
      const text = ctx.source.slice(ctx.pos + 9, end);
      ctx.pos = end + 3;
      children.push({
        kind: "text",
        text,
        span: { start: cdataStart, end: ctx.pos },
      });
      continue;
    }
    if (ctx.source.startsWith("<!", ctx.pos)) {
      throw error(ctx, "unsupported '<!...' construct");
    }
    if (ctx.source.startsWith("<?", ctx.pos)) {
      throw error(ctx, "processing instructions are not supported");
    }
    if (ctx.source.charCodeAt(ctx.pos) === 0x3c /* '<' */) {
      const child = parseElement(ctx);
      children.push(child);
      continue;
    }
    // Text content up to the next '<'.
    const textStart = ctx.pos;
    while (
      ctx.pos < ctx.source.length &&
      ctx.source.charCodeAt(ctx.pos) !== 0x3c
    ) {
      ctx.pos += 1;
    }
    const rawText = ctx.source.slice(textStart, ctx.pos);
    const decoded = decodeEntities(rawText, ctx, textStart);
    children.push({
      kind: "text",
      text: decoded,
      span: { start: textStart, end: ctx.pos },
    });
  }
}

function readName(ctx: Ctx): string {
  const start = ctx.pos;
  while (ctx.pos < ctx.source.length) {
    const c = ctx.source.charCodeAt(ctx.pos);
    const isNameChar =
      (c >= 0x61 && c <= 0x7a) /* a-z */ ||
      (c >= 0x41 && c <= 0x5a) /* A-Z */ ||
      (c >= 0x30 && c <= 0x39) /* 0-9 */ ||
      c === 0x5f /* _ */ ||
      c === 0x2d /* - */ ||
      c === 0x2e /* . */ ||
      c === 0x3a; /* : -- namespace separator, retained but flattened */
    if (!isNameChar) break;
    ctx.pos += 1;
  }
  // Strip namespace prefix `ns:tag` -> `tag` per the design.
  const raw = ctx.source.slice(start, ctx.pos);
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx >= 0) return raw.slice(colonIdx + 1);
  return raw;
}

function readAttrValue(ctx: Ctx): string {
  const quote = ctx.source.charCodeAt(ctx.pos);
  if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
    throw error(ctx, "expected quoted attribute value");
  }
  ctx.pos += 1;
  const start = ctx.pos;
  while (
    ctx.pos < ctx.source.length &&
    ctx.source.charCodeAt(ctx.pos) !== quote
  ) {
    ctx.pos += 1;
  }
  if (ctx.pos >= ctx.source.length) {
    throw error(ctx, "unterminated attribute value");
  }
  const raw = ctx.source.slice(start, ctx.pos);
  ctx.pos += 1;
  return decodeEntities(raw, ctx, start);
}

function decodeEntities(text: string, ctx: Ctx, baseOffset: number): string {
  if (text.indexOf("&") < 0) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x26 /* & */) {
      out += text[i];
      i += 1;
      continue;
    }
    const semi = text.indexOf(";", i);
    if (semi < 0) {
      const absPos = baseOffset + i;
      throw new ParseError(
        "unterminated entity reference",
        {
          line: ctx.lineMap.locate(absPos).line,
          column: ctx.lineMap.locate(absPos).column,
          offset: absPos,
        },
        "xml",
      );
    }
    const entityName = text.slice(i + 1, semi);
    const decoded = resolveEntity(entityName);
    if (decoded === null) {
      const absPos = baseOffset + i;
      throw new ParseError(
        `unknown entity '&${entityName};'`,
        {
          line: ctx.lineMap.locate(absPos).line,
          column: ctx.lineMap.locate(absPos).column,
          offset: absPos,
        },
        "xml",
      );
    }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

function resolveEntity(name: string): string | null {
  switch (name) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }
  if (name.startsWith("#x") || name.startsWith("#X")) {
    const code = parseInt(name.slice(2), 16);
    if (Number.isFinite(code)) return String.fromCodePoint(code);
    return null;
  }
  if (name.startsWith("#")) {
    const code = parseInt(name.slice(1), 10);
    if (Number.isFinite(code)) return String.fromCodePoint(code);
    return null;
  }
  return null;
}
