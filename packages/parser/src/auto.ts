// packages/parser/src/auto.ts
//
// Cheap, deterministic format detection. Order of checks matters: XML is
// detected first (a `<` followed by a name character is unambiguous);
// Markdown is detected by the presence of an ATX heading anywhere in the
// prefix; otherwise the input is treated as plain text.

import type { PromptIR, SourceFormat } from "@promptc/ir";

import { parseMarkdown } from "./markdown.js";
import { parsePlain } from "./plain.js";
import { parseXml } from "./xml.js";

/** Heuristic format detection. Pure, deterministic, no I/O. */
export function detectFormat(source: string): SourceFormat {
  const head = trimLeading(source);
  if (head === "") return "plain";
  // XML: starts with `<` followed by a name character or `?xml`.
  if (head.startsWith("<")) {
    const next = head.charCodeAt(1);
    const isName =
      (next >= 0x61 && next <= 0x7a) /* a-z */ ||
      (next >= 0x41 && next <= 0x5a) /* A-Z */ ||
      next === 0x3f /* ? — `<?xml` prolog */;
    if (isName) return "xml";
  }
  // Markdown: at least one ATX heading line.
  if (/^\s*#{1,6}\s+\S/m.test(source)) return "markdown";
  return "plain";
}

/** Parse using the detected format. */
export function parseAuto(source: string): PromptIR {
  const fmt = detectFormat(source);
  switch (fmt) {
    case "markdown":
      return parseMarkdown(source);
    case "xml":
      return parseXml(source);
    case "plain":
      return parsePlain(source);
  }
}

function trimLeading(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
    else break;
  }
  return s.slice(i);
}
