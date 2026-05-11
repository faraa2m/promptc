// packages/passes/src/whitespace_redundancy.ts
//
// Pass: whitespace_redundancy_strip
//
// Three independent rewrites applied (in order) to each section body and
// instruction text:
//
//   1. Strip trailing whitespace on every line.
//   2. Strip leading + trailing whitespace from the body as a whole.
//   3. Collapse runs of 3+ consecutive newlines into 2 (one blank line max).
//
// All three are constrained to *not* touch fenced code blocks (```...```).
// We preserve their interior bytes byte-for-byte because tokenizers + parsers
// rely on exact whitespace inside fences.
//
// ## Preconditions (DESIGN.md §4.4)
//
//   1. At least one section has body OR at least one instruction has text.
//   2. No node has `attrs.preserve_whitespace === "true"` AND the candidate
//      set must contain at least one node *without* that attribute. (Honour
//      the parser-attached opt-out per DESIGN.md §4.4.)
//   3. After scanning, at least one node must carry an actionable whitespace
//      pattern (trailing space, run of 3+ newlines, leading/trailing
//      surrounding whitespace) — otherwise the pass skips with a no-op
//      reason rather than producing a useless pass-log entry.
//
// ## Postconditions
//
//   - For every modified section/instruction:
//       - No line outside a fenced code block ends in whitespace.
//       - The body has no leading or trailing whitespace.
//       - No run of 3+ consecutive newlines remains outside fences.
//   - No Slot, Example, or OutputSchema text changes.
//   - Instruction.id, .kind, .refersToFields, .slotRefs are all preserved.
//
// ## Determinism proof sketch
//
// All rewrites are pure string regex applications over a fixed alphabet of
// patterns (`/[ \t]+$/`, `/\n{3,}/`). The fenced-code preservation is a
// linear scan over backticks. No randomness, no I/O, no clock.
//
// ## Behavior-preservation argument
//
// Whitespace normalisation is the canonical behavior-preserving rewrite in
// modern tokenizers (see `llm-tokens-atlas`'s cross-provider tests). Removing
// trailing whitespace on a line and collapsing 3+ blank lines never changes
// the semantic content visible to a model — it only affects token-count
// economics.

import type { Instruction, PromptIR, Section } from "@promptc/ir";

import type {
  Pass,
  PassOptions,
  PassPreconditionResult,
  PassResult,
} from "./_types.js";

const PASS_NAME = "whitespace_redundancy_strip";

// ---------------------------------------------------------------------------
// Detection helpers (used both by preconditions and the rewriter)
// ---------------------------------------------------------------------------

const TRAILING_WHITESPACE = /[ \t]+$/m;
const TRIPLE_NEWLINE = /\n{3,}/;
const LEADING_WHITESPACE = /^\s+/;
const TRAILING_WHITESPACE_ALL = /\s+$/;

/**
 * Returns true if `text` has at least one actionable whitespace pattern that
 * this pass would normalize.
 */
export function hasActionableWhitespace(text: string): boolean {
  if (text.length === 0) return false;
  if (LEADING_WHITESPACE.test(text)) return true;
  if (TRAILING_WHITESPACE_ALL.test(text)) return true;
  if (TRIPLE_NEWLINE.test(text)) return true;
  // Trailing whitespace on any line (excluding the trailing-of-document case
  // already covered by TRAILING_WHITESPACE_ALL).
  if (TRAILING_WHITESPACE.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Fenced-code-aware splitting
// ---------------------------------------------------------------------------

interface Segment {
  /** "code" = leave verbatim. "prose" = apply rewrites. */
  kind: "code" | "prose";
  text: string;
}

/**
 * Split a string into alternating prose and fenced-code segments. The fence
 * marker (```) is included in the code segment to keep concatenation lossless.
 *
 * The scan is deliberately simple: it pairs opening fences with the next
 * closing fence. An unterminated fence is treated as code from the opener to
 * end-of-string.
 */
function segmentByFence(text: string): Segment[] {
  if (text.length === 0) return [];
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("```", i);
    if (open === -1) {
      out.push({ kind: "prose", text: text.slice(i) });
      break;
    }
    if (open > i) {
      out.push({ kind: "prose", text: text.slice(i, open) });
    }
    const close = text.indexOf("```", open + 3);
    if (close === -1) {
      out.push({ kind: "code", text: text.slice(open) });
      break;
    }
    out.push({ kind: "code", text: text.slice(open, close + 3) });
    i = close + 3;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core rewriter
// ---------------------------------------------------------------------------

/**
 * Rewrite a single prose segment:
 *   - strip trailing whitespace on every line
 *   - collapse \n{3,} -> \n\n
 *
 * Does NOT touch leading/trailing whitespace of the whole text — that is
 * applied once by `rewriteBody` at the body-as-a-whole level so we never
 * incidentally eat whitespace that belongs to a neighbouring code fence.
 */
function rewriteProseSegment(text: string): string {
  if (text.length === 0) return text;
  // Strip trailing whitespace per line. Multiline + global.
  let out = text.replace(/[ \t]+\n/g, "\n");
  // Strip trailing whitespace at end of the segment (without newline).
  out = out.replace(/[ \t]+$/g, "");
  // Collapse 3+ newlines into 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

/**
 * Rewrite a section body or instruction text. Fences are preserved verbatim.
 * Whole-body leading/trailing whitespace is stripped *unless* the first or
 * last segment is a fence — in which case only the prose around the fence is
 * trimmed.
 */
export function rewriteBody(text: string): string {
  if (text.length === 0) return text;
  const segments = segmentByFence(text);
  const rewritten: Segment[] = segments.map((seg) =>
    seg.kind === "prose"
      ? { kind: "prose", text: rewriteProseSegment(seg.text) }
      : seg,
  );
  // Trim the very first prose segment's leading whitespace and the very last
  // prose segment's trailing whitespace, if either exists.
  for (let i = 0; i < rewritten.length; i++) {
    const seg = rewritten[i];
    if (seg && seg.kind === "prose") {
      rewritten[i] = { kind: "prose", text: seg.text.replace(/^\s+/, "") };
      break;
    }
  }
  for (let i = rewritten.length - 1; i >= 0; i--) {
    const seg = rewritten[i];
    if (seg && seg.kind === "prose") {
      rewritten[i] = { kind: "prose", text: seg.text.replace(/\s+$/, "") };
      break;
    }
  }
  return rewritten.map((s) => s.text).join("");
}

// ---------------------------------------------------------------------------
// Pass plumbing
// ---------------------------------------------------------------------------

function preconditions(ir: PromptIR): PassPreconditionResult {
  const reasons: string[] = [];
  const candidateSections = ir.sections.filter(
    (s) => s.attrs["preserve_whitespace"] !== "true",
  );
  const hasCandidate =
    candidateSections.length > 0 || ir.instructions.length > 0;
  if (!hasCandidate) {
    reasons.push(
      "every section opts out via preserve_whitespace and no instructions are present",
    );
    return { ok: false, reasons };
  }
  // Need at least one node with an actionable pattern.
  const actionable =
    candidateSections.some((s) => hasActionableWhitespace(s.body)) ||
    ir.instructions.some((i) => hasActionableWhitespace(i.text));
  if (!actionable) {
    reasons.push("no node has actionable whitespace patterns");
  }
  return { ok: reasons.length === 0, reasons };
}

interface Summary {
  sectionsChanged: number;
  instructionsChanged: number;
  bytesSaved: number;
}

function rewriteSections(
  sections: ReadonlyArray<Section>,
): { next: Section[]; changed: number; bytesSaved: number } {
  const out: Section[] = [];
  let changed = 0;
  let bytesSaved = 0;
  for (const section of sections) {
    if (section.attrs["preserve_whitespace"] === "true") {
      out.push(section);
      continue;
    }
    const newBody = rewriteBody(section.body);
    if (newBody !== section.body) {
      changed += 1;
      bytesSaved += section.body.length - newBody.length;
      out.push({ ...section, body: newBody });
    } else {
      out.push(section);
    }
  }
  return { next: out, changed, bytesSaved };
}

function rewriteInstructions(
  instructions: ReadonlyArray<Instruction>,
): { next: Instruction[]; changed: number; bytesSaved: number } {
  const out: Instruction[] = [];
  let changed = 0;
  let bytesSaved = 0;
  for (const instr of instructions) {
    const newText = rewriteBody(instr.text);
    if (newText !== instr.text) {
      changed += 1;
      bytesSaved += instr.text.length - newText.length;
      out.push({ ...instr, text: newText });
    } else {
      out.push(instr);
    }
  }
  return { next: out, changed, bytesSaved };
}

function run(ir: PromptIR, _opts?: PassOptions): PassResult {
  const pre = preconditions(ir);
  if (!pre.ok) {
    return { ir, applied: false, reason: pre.reasons.join("; ") };
  }

  const rs = rewriteSections(ir.sections);
  const ri = rewriteInstructions(ir.instructions);
  const summary: Summary = {
    sectionsChanged: rs.changed,
    instructionsChanged: ri.changed,
    bytesSaved: rs.bytesSaved + ri.bytesSaved,
  };

  if (summary.sectionsChanged === 0 && summary.instructionsChanged === 0) {
    return {
      ir,
      applied: false,
      reason: "no node required whitespace normalisation",
      debug: { ...summary },
    };
  }

  const nextIR: PromptIR = {
    ...ir,
    sections: rs.next,
    instructions: ri.next,
  };

  return {
    ir: nextIR,
    applied: true,
    reason: "",
    droppedTokens: summary.bytesSaved, // crude byte-proxy
    debug: { ...summary },
  };
}

export const whitespaceRedundancyStrip: Pass = {
  name: PASS_NAME,
  preconditions,
  run,
};

export default whitespaceRedundancyStrip;

export const __internals = {
  rewriteBody,
  rewriteProseSegment,
  hasActionableWhitespace,
  segmentByFence,
};
