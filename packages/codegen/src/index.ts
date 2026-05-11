// @promptc/codegen — IR -> output format (markdown / XML / plain).
//
// Public surface:
//   - `codegen(ir, { to })` — dispatches by surface format.
//   - `toMarkdown`, `toXml`, `toPlain` — direct format-specific entrypoints.
//
// Determinism: every entrypoint is a pure function of its IR argument.
// See DESIGN.md §5 for the round-trip contract.

import type { PromptIR, SourceFormat } from "@promptc/ir";
import { toMarkdown } from "./markdown.js";
import { toXml } from "./xml.js";
import { toPlain } from "./plain.js";

export { toMarkdown } from "./markdown.js";
export { toXml } from "./xml.js";
export { toPlain } from "./plain.js";

export interface CodegenOptions {
  to: SourceFormat;
  /** Optional override for trailing newline behavior. Default: true. */
  trailingNewline?: boolean;
}

/**
 * Top-level codegen entrypoint. Dispatches on `opts.to`.
 *
 * The output is deterministic: same IR + same options -> same output bytes.
 */
export function codegen(ir: PromptIR, opts: CodegenOptions): string {
  switch (opts.to) {
    case "markdown":
      return toMarkdown(ir, { trailingNewline: opts.trailingNewline });
    case "xml":
      return toXml(ir, { trailingNewline: opts.trailingNewline });
    case "plain":
      return toPlain(ir, { trailingNewline: opts.trailingNewline });
  }
}

export const version = "0.0.1";
