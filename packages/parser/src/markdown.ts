// packages/parser/src/markdown.ts
//
// A small, dependency-free Markdown parser tailored to prompt-engineering
// idioms. The parser recognises a deliberately narrow subset of CommonMark:
//
//   - ATX headings (`#`, `##`, `###`) start a section. Heading text is the
//     heading line minus the leading `#`s. Heading depth is preserved in
//     the source span but not in the IR's structural shape — promptc uses
//     headings only to delimit sections.
//   - Fenced code blocks (``` or ~~~) are preserved verbatim and treated
//     opaquely (their bodies do not produce slots or instructions).
//   - Unordered/ordered list items prefixed with `- `, `* `, `+ `, or
//     `N. ` inside an `instructions` or `constraints` section are
//     emitted as separate `Instruction` nodes.
//   - The `Examples` section's body is scanned for labeled example pairs
//     of the form `Input: ... / Output: ...` (case-insensitive). Each
//     pair becomes an `Example` node. Code fences attached to an example
//     attach to its `input` or `output` according to position.
//   - `{{ name }}` slot literals are recognised everywhere except inside
//     fenced code blocks.
//
// Section kind is inferred from the heading text via a small synonym
// table (see `inferSectionKind`). Unknown headings map to `"other"`.
//
// The parser never throws on weird-but-parseable input. Truly malformed
// input (unclosed `{{` after a `}}` — which currently the regex tolerates,
// or unclosed code fences which we accept by treating EOF as the closer)
// is recovered gracefully. The only fatal error condition currently is an
// empty input string, which the caller may decide to reject by inspecting
// the returned IR.

import {
  type Example,
  type Instruction,
  type InstructionKind,
  type NodeId,
  type PromptIR,
  type Section,
  type SectionKind,
  type SourceSpan,
} from "@promptc/ir";

import { findSlotOccurrences, reduceSlots, type SlotOccurrence } from "./slots.js";
import { hashSource, IdAllocator, LineMap, makeSpan } from "./util.js";

interface RawBlock {
  /** Heading text without the leading `#`s, trimmed. Empty for the implicit lead block. */
  heading: string;
  /** ATX heading depth (1 for `#`, 2 for `##`, ...). 0 for the implicit lead block. */
  depth: number;
  /** Byte offset of the heading line in the original source (or 0 for lead block). */
  headingOffset: number;
  /** Byte offset of the start of the heading line. */
  startOffset: number;
  /** Byte offset (exclusive) where the section's body ends. */
  endOffset: number;
  /** Raw body text including all subordinate content. */
  body: string;
  /** Byte offset where `body` starts in the original source. */
  bodyOffset: number;
}

/**
 * Parse a Markdown source string into an IR. Pure function of the input.
 */
export function parseMarkdown(source: string): PromptIR {
  const lineMap = new LineMap(source);
  const ids = new IdAllocator();

  const blocks = splitIntoBlocks(source);

  const sections: Section[] = [];
  const instructions: Instruction[] = [];
  const examples: Example[] = [];
  const allSlotOccurrences: SlotOccurrence[] = [];

  for (const block of blocks) {
    const sectionId = ids.next("section");
    const kind = inferSectionKind(block.heading);
    const heading = block.heading || defaultHeadingForKind(kind);

    const span: SourceSpan = makeSpan(block.startOffset, block.endOffset, lineMap);
    const section: Section = {
      id: sectionId,
      kind,
      heading,
      body: block.body,
      source: span,
      slotRefs: [],
      instructionRefs: [],
      exampleRefs: [],
      attrs: { markdownHeadingDepth: String(block.depth) },
    };
    sections.push(section);

    // Slot occurrences inside this section.
    for (const occ of findSlotOccurrencesSkippingCodeBlocks(
      block.body,
      block.bodyOffset,
      sectionId,
      lineMap,
    )) {
      allSlotOccurrences.push(occ);
    }

    // Per-section structural extraction.
    if (kind === "instructions" || kind === "constraints") {
      for (const instr of extractInstructionsFromMarkdownBody(
        block.body,
        block.bodyOffset,
        sectionId,
        lineMap,
        ids,
      )) {
        instructions.push(instr);
        section.instructionRefs.push(instr.id);
      }
    } else if (kind === "examples") {
      for (const ex of extractExamplesFromMarkdownBody(
        block.body,
        block.bodyOffset,
        sectionId,
        lineMap,
        ids,
      )) {
        examples.push(ex);
        section.exampleRefs.push(ex.id);
      }
    }
  }

  const { slots, bySectionId } = reduceSlots(allSlotOccurrences, ids);
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
      sourceFormat: "markdown",
      tags: [],
      sourceHash: hashSource(source),
      rawSource: source,
      passLog: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Block splitting
// ---------------------------------------------------------------------------

/**
 * Split the source into a sequence of (heading, body) blocks. The first
 * block has an empty heading and a depth of 0 if the source starts with
 * non-heading text. Code fences are tracked so headings inside a fenced
 * block do not split.
 */
function splitIntoBlocks(source: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let currentBlock: RawBlock | null = null;
  let inFence: { marker: string; fenceLen: number } | null = null;

  const lines = enumerateLines(source);
  for (const line of lines) {
    const lineText = source.slice(line.start, line.end);
    const stripped = stripLineEnding(lineText);

    // Fence open/close tracking.
    const fenceMatch = stripped.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      const fenceChar = marker[0];
      if (inFence === null) {
        if (fenceChar === "`" || fenceChar === "~") {
          inFence = { marker: fenceChar, fenceLen: marker.length };
        }
      } else if (
        fenceChar !== undefined &&
        fenceChar === inFence.marker &&
        marker.length >= inFence.fenceLen
      ) {
        inFence = null;
      }
    }

    let headingDepth = 0;
    let headingText = "";
    if (inFence === null) {
      const headingMatch = stripped.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        headingDepth = (headingMatch[1] ?? "").length;
        headingText = (headingMatch[2] ?? "").trim();
      }
    }

    if (headingDepth > 0) {
      // Close out previous block.
      if (currentBlock !== null) {
        currentBlock.endOffset = line.start;
        currentBlock.body = source.slice(
          currentBlock.bodyOffset,
          currentBlock.endOffset,
        );
        blocks.push(currentBlock);
      }
      // Begin new heading block.
      currentBlock = {
        heading: headingText,
        depth: headingDepth,
        headingOffset: line.start,
        startOffset: line.start,
        endOffset: source.length,
        body: "",
        bodyOffset: line.end,
      };
    } else {
      if (currentBlock === null) {
        // Implicit lead block before any heading.
        currentBlock = {
          heading: "",
          depth: 0,
          headingOffset: 0,
          startOffset: 0,
          endOffset: source.length,
          body: "",
          bodyOffset: 0,
        };
      }
    }
  }

  if (currentBlock !== null) {
    currentBlock.endOffset = source.length;
    currentBlock.body = source.slice(
      currentBlock.bodyOffset,
      currentBlock.endOffset,
    );
    blocks.push(currentBlock);
  }

  // Suppress an empty leading block (no heading, no body).
  if (
    blocks.length > 0 &&
    blocks[0] !== undefined &&
    blocks[0].depth === 0 &&
    blocks[0].body.trim() === ""
  ) {
    blocks.shift();
  }

  return blocks;
}

interface LineSpan {
  /** Inclusive start offset of the line. */
  start: number;
  /** Exclusive end offset (just past the trailing newline if any). */
  end: number;
}

function enumerateLines(source: string): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 0x0a /* \n */) {
      out.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < source.length) {
    out.push({ start, end: source.length });
  }
  return out;
}

function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

// ---------------------------------------------------------------------------
// Section-kind inference
// ---------------------------------------------------------------------------

/**
 * Heading text -> `SectionKind`. Matching is case-insensitive on the first
 * "word-ish" portion of the heading. Unknown headings map to `"other"`.
 */
export function inferSectionKind(heading: string): SectionKind {
  const norm = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (norm === "") return "other";
  // Look up by both the whole normalised string and the first token, taking
  // the most specific match.
  const direct = HEADING_KIND_MAP.get(norm);
  if (direct) return direct;
  const firstToken = norm.split(" ")[0] ?? "";
  const token = HEADING_KIND_MAP.get(firstToken);
  if (token) return token;
  return "other";
}

const HEADING_KIND_MAP = new Map<string, SectionKind>([
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
  ["demonstrations", "examples"],
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
]);

function defaultHeadingForKind(kind: SectionKind): string {
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
      return "";
  }
}

// ---------------------------------------------------------------------------
// Slot occurrences (code-block-aware)
// ---------------------------------------------------------------------------

/**
 * Walk `body` line-by-line, skipping fenced code blocks, and emit slot
 * occurrences for every `{{ ... }}` token found in non-code text. The
 * offsets reported are relative to the original source.
 */
function findSlotOccurrencesSkippingCodeBlocks(
  body: string,
  bodyOffset: number,
  sectionId: NodeId,
  lineMap: LineMap,
): SlotOccurrence[] {
  const out: SlotOccurrence[] = [];
  let inFence: { marker: string; fenceLen: number } | null = null;
  const lines = enumerateLines(body);
  for (const line of lines) {
    const lineText = body.slice(line.start, line.end);
    const stripped = stripLineEnding(lineText);
    const fenceMatch = stripped.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      const fenceChar = marker[0];
      if (inFence === null) {
        if (fenceChar === "`" || fenceChar === "~") {
          inFence = { marker: fenceChar, fenceLen: marker.length };
        }
      } else if (
        fenceChar !== undefined &&
        fenceChar === inFence.marker &&
        marker.length >= inFence.fenceLen
      ) {
        inFence = null;
      }
      continue;
    }
    if (inFence !== null) continue;
    const lineOccurrences = findSlotOccurrences(
      lineText,
      bodyOffset + line.start,
      sectionId,
      lineMap,
    );
    for (const occ of lineOccurrences) out.push(occ);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instruction extraction (lists in instructions/constraints sections)
// ---------------------------------------------------------------------------

const BULLET_PREFIX = /^\s*(?:[-*+]|\d+\.)\s+/;

function extractInstructionsFromMarkdownBody(
  body: string,
  bodyOffset: number,
  parentSectionId: NodeId,
  lineMap: LineMap,
  ids: IdAllocator,
): Instruction[] {
  const out: Instruction[] = [];
  let inFence: { marker: string; fenceLen: number } | null = null;
  const lines = enumerateLines(body);
  for (const line of lines) {
    const lineText = body.slice(line.start, line.end);
    const stripped = stripLineEnding(lineText);
    const fenceMatch = stripped.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      const fenceChar = marker[0];
      if (inFence === null) {
        if (fenceChar === "`" || fenceChar === "~") {
          inFence = { marker: fenceChar, fenceLen: marker.length };
        }
      } else if (
        fenceChar !== undefined &&
        fenceChar === inFence.marker &&
        marker.length >= inFence.fenceLen
      ) {
        inFence = null;
      }
      continue;
    }
    if (inFence !== null) continue;
    if (stripped.trim() === "") continue;
    const bulletMatch = stripped.match(BULLET_PREFIX);
    if (!bulletMatch) continue;
    const text = stripped.slice(bulletMatch[0].length).trim();
    if (text === "") continue;
    const startOffset = bodyOffset + line.start;
    const endOffset = bodyOffset + line.end;
    const kind = inferInstructionKind(text);
    const verbs = detectVerbs(text);
    out.push({
      id: ids.next("instr"),
      kind,
      text,
      verbs,
      refersToFields: [],
      slotRefs: [],
      parent: parentSectionId,
      source: makeSpan(startOffset, endOffset, lineMap),
    });
  }
  return out;
}

function inferInstructionKind(text: string): InstructionKind {
  const lower = text.toLowerCase();
  if (/^\s*(must|always|never|do not|don't|always|required)\b/.test(lower)) {
    return "required";
  }
  if (/^\s*(may|optionally|prefer|consider|optional)\b/.test(lower)) {
    return "optional";
  }
  if (/(format|output|json|yaml|xml|markdown|schema)/.test(lower)) {
    return "format";
  }
  if (/(tone|voice|style|concise|polite|formal|casual)/.test(lower)) {
    return "style";
  }
  return "required";
}

const COMMON_VERBS = [
  "respond",
  "format",
  "use",
  "avoid",
  "include",
  "exclude",
  "answer",
  "explain",
  "summarise",
  "summarize",
  "classify",
  "extract",
  "rewrite",
  "translate",
  "provide",
  "generate",
];

function detectVerbs(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (COMMON_VERBS.includes(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Example extraction (Input:/Output: pairs)
// ---------------------------------------------------------------------------

interface ExampleScanState {
  current: Partial<{
    label: string;
    input: string;
    output: string;
    rationale: string;
    start: number;
    end: number;
  }> | null;
  field: "input" | "output" | "rationale" | null;
}

function extractExamplesFromMarkdownBody(
  body: string,
  bodyOffset: number,
  parentSectionId: NodeId,
  lineMap: LineMap,
  ids: IdAllocator,
): Example[] {
  const out: Example[] = [];
  const lines = enumerateLines(body);
  const state: ExampleScanState = { current: null, field: null };

  let inFence: { marker: string; fenceLen: number } | null = null;
  let fenceBuffer: string[] = [];

  const flushFenceTo = (field: "input" | "output" | "rationale" | null) => {
    if (!state.current || field === null) {
      fenceBuffer = [];
      return;
    }
    const joined = fenceBuffer.join("\n");
    fenceBuffer = [];
    if (field === "input") {
      state.current.input = appendField(state.current.input, joined);
    } else if (field === "output") {
      state.current.output = appendField(state.current.output, joined);
    } else if (field === "rationale") {
      state.current.rationale = appendField(state.current.rationale, joined);
    }
  };

  const finalize = () => {
    if (!state.current) return;
    const cur = state.current;
    const startOffset = cur.start ?? bodyOffset;
    const endOffset = cur.end ?? bodyOffset;
    out.push({
      id: ids.next("example"),
      label: cur.label ?? null,
      input: (cur.input ?? "").trim(),
      output: (cur.output ?? "").trim(),
      rationale:
        cur.rationale === undefined ? null : cur.rationale.trim() || null,
      slotRefs: [],
      parent: parentSectionId,
      source: makeSpan(startOffset, endOffset, lineMap),
    });
    state.current = null;
    state.field = null;
  };

  for (const line of lines) {
    const lineText = body.slice(line.start, line.end);
    const stripped = stripLineEnding(lineText);
    const fenceMatch = stripped.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      const fenceChar = marker[0];
      if (inFence === null) {
        if (fenceChar === "`" || fenceChar === "~") {
          inFence = { marker: fenceChar, fenceLen: marker.length };
          fenceBuffer = [];
        }
      } else if (
        fenceChar !== undefined &&
        fenceChar === inFence.marker &&
        marker.length >= inFence.fenceLen
      ) {
        inFence = null;
        flushFenceTo(state.field);
      }
      if (state.current && state.current.start === undefined) {
        state.current.start = bodyOffset + line.start;
      }
      if (state.current) {
        state.current.end = bodyOffset + line.end;
      }
      continue;
    }
    if (inFence !== null) {
      fenceBuffer.push(stripped);
      if (state.current) state.current.end = bodyOffset + line.end;
      continue;
    }

    const labelMatch = stripped.match(/^\s*#{0,6}\s*(Example(?:\s*\d+)?)\s*:?\s*$/i);
    const inputMatch = stripped.match(/^\s*(Input|User)\s*:\s*(.*)$/i);
    const outputMatch = stripped.match(
      /^\s*(Output|Assistant|Answer|Expected)\s*:\s*(.*)$/i,
    );
    const reasoningMatch = stripped.match(
      /^\s*(Reasoning|Thought|Rationale)\s*:\s*(.*)$/i,
    );

    if (labelMatch) {
      finalize();
      state.current = {
        label: (labelMatch[1] ?? "").trim(),
        start: bodyOffset + line.start,
        end: bodyOffset + line.end,
      };
      state.field = null;
      continue;
    }
    if (inputMatch) {
      if (!state.current) {
        state.current = {
          start: bodyOffset + line.start,
        };
      }
      state.current.input = appendField(state.current.input, inputMatch[2] ?? "");
      state.current.end = bodyOffset + line.end;
      state.field = "input";
      continue;
    }
    if (outputMatch) {
      if (!state.current) {
        state.current = {
          start: bodyOffset + line.start,
        };
      }
      state.current.output = appendField(
        state.current.output,
        outputMatch[2] ?? "",
      );
      state.current.end = bodyOffset + line.end;
      state.field = "output";
      continue;
    }
    if (reasoningMatch) {
      if (!state.current) {
        state.current = {
          start: bodyOffset + line.start,
        };
      }
      state.current.rationale = appendField(
        state.current.rationale,
        reasoningMatch[2] ?? "",
      );
      state.current.end = bodyOffset + line.end;
      state.field = "rationale";
      continue;
    }

    // Continuation line for the current field.
    if (state.current && state.field) {
      const trimmedContinuation = stripped.trim();
      if (trimmedContinuation !== "") {
        if (state.field === "input") {
          state.current.input = appendField(state.current.input, stripped);
        } else if (state.field === "output") {
          state.current.output = appendField(state.current.output, stripped);
        } else if (state.field === "rationale") {
          state.current.rationale = appendField(state.current.rationale, stripped);
        }
        state.current.end = bodyOffset + line.end;
      }
    }
  }
  finalize();
  return out;
}

function appendField(current: string | undefined, next: string): string {
  const trimmedNext = next;
  if (!current) return trimmedNext;
  if (trimmedNext === "") return current;
  return `${current}\n${trimmedNext}`;
}
