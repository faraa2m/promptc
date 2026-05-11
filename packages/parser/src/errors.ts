// packages/parser/src/errors.ts
//
// `ParseError` is thrown by the parser entry points when the input is
// syntactically malformed in a way the parser cannot recover from
// (e.g. unclosed XML tag, missing matching brace in `{{ ... }}`).
//
// Soft, recoverable issues are surfaced via `ParseDiagnostic` (defined in
// `@promptc/ir`) and attached to the returned IR's `metadata.passLog`-style
// channel — but the parser is in a critical path and currently does not
// produce diagnostics; that hook is reserved for future work.
//
// The error message always points at the failing 1-indexed line:column to
// help the CLI render a useful pointer.

export interface ParseErrorLocation {
  /** 1-indexed line number in the original source. */
  line: number;
  /** 1-indexed column number in the original source. */
  column: number;
  /** Byte offset into the original source. */
  offset: number;
}

export class ParseError extends Error {
  public readonly location: ParseErrorLocation;
  public readonly format: "markdown" | "xml" | "plain" | "auto";

  constructor(
    message: string,
    location: ParseErrorLocation,
    format: "markdown" | "xml" | "plain" | "auto",
  ) {
    super(`${format}:${location.line}:${location.column}: ${message}`);
    this.name = "ParseError";
    this.location = location;
    this.format = format;
  }
}
