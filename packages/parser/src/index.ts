// @promptc/parser — input formats (markdown / XML / plain) -> PromptIR.
//
// The parser layer is the front end of the promptc compile pipeline. Given a
// surface-format source string it produces a typed PromptIR (see
// `@promptc/ir`) on which passes operate.
//
// Top-level API:
//
//   parse(text, { format: "markdown" | "xml" | "plain" | "auto" }): PromptIR
//   parseAuto(text): PromptIR
//   parseMarkdown(text): PromptIR
//   parseXml(text): PromptIR        // throws ParseError on malformed input
//   parsePlain(text): PromptIR
//
// All parser entry points are pure functions of the input string: same bytes
// in → same IR out. No I/O, no RNG. This is the basis for the compile path's
// determinism guarantee (DESIGN.md §5).

import type { PromptIR } from "@promptc/ir";

import { detectFormat, parseAuto } from "./auto.js";
import { ParseError } from "./errors.js";
import { parseMarkdown } from "./markdown.js";
import { parsePlain } from "./plain.js";
import { parseXml } from "./xml.js";

export type ParseFormat = "markdown" | "xml" | "plain" | "auto";

export interface ParseOptions {
  /** Which surface format the input is in. `"auto"` runs the detector. */
  format: ParseFormat;
}

/** Top-level parse entrypoint. */
export function parse(source: string, opts: ParseOptions): PromptIR {
  switch (opts.format) {
    case "markdown":
      return parseMarkdown(source);
    case "xml":
      return parseXml(source);
    case "plain":
      return parsePlain(source);
    case "auto":
      return parseAuto(source);
  }
}

export { parseAuto, parseMarkdown, parsePlain, parseXml, detectFormat };
export { ParseError } from "./errors.js";
export type { ParseErrorLocation } from "./errors.js";

export const version = "0.0.1";

// Re-export the IR `PromptIR` type for ergonomic consumption by CLI.
export type { PromptIR } from "@promptc/ir";

// Keep the synthetic name binding alive when downstream tools tree-shake.
// (Pure-types-only re-export above is erased by TS — having the value
// imports here ensures the implementation modules are reachable.)
void ParseError;
