#!/usr/bin/env bun
// @promptc/cli — `promptc` command entrypoint.
//
// Subcommands:
//
//   promptc optimize  --target=<cost|tokens|none> --in=<file> --out=<file>
//                     [--from=<fmt>] [--to=<fmt>] [--passes=<a,b,c>]
//                     [--max-mutations=<n>]
//   promptc parse     --in=<file> [--from=<fmt>] [--pretty]
//   promptc passes
//   promptc explain   --in=<file> --pass=<name> [--from=<fmt>]
//   promptc version
//   promptc help
//
// Input can come from `--in <file>` or stdin (when omitted). The CLI uses
// Bun's `parseArgs` (Node-compatible) for argument parsing. There are no
// runtime dependencies beyond the `@promptc/*` workspace packages.
//
// Exit codes:
//   0  success
//   1  input error (bad path, bad flags, unreadable file, bad bytes)
//   2  IR validation error (parser produced an invalid IR)
//   3  pass precondition failure (an explicitly-requested pass refused to run)

import { parseArgs } from "node:util";

import { validateIR, type SourceFormat } from "@promptc/ir";
import { codegen } from "@promptc/codegen";
import { runPipeline, type PassRecord, listAllPasses } from "./pipeline.js";
import { parseSource } from "./parse.js";
import { tokenCount } from "./tokens.js";

const VERSION = "0.0.1";

interface OptimizeFlags {
  target: "cost" | "tokens" | "none";
  inputPath?: string;
  outputPath?: string;
  from?: SourceFormat;
  to?: SourceFormat;
  passes?: string[];
  maxMutations?: number;
}

interface ParseFlags {
  inputPath?: string;
  from?: SourceFormat;
  pretty: boolean;
}

interface ExplainFlags {
  inputPath?: string;
  from?: SourceFormat;
  pass: string;
}

const EXIT_OK = 0;
const EXIT_INPUT = 1;
const EXIT_IR = 2;
const EXIT_PRECONDITION = 3;

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`promptc: unexpected error: ${msg}\n`);
    process.exit(EXIT_INPUT);
  });

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return EXIT_OK;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    case "passes":
      if (askedForHelp(rest)) {
        printPassesHelp();
        return EXIT_OK;
      }
      return runPasses();
    case "parse":
      if (askedForHelp(rest)) {
        printParseHelp();
        return EXIT_OK;
      }
      return runParse(rest);
    case "optimize":
      if (askedForHelp(rest)) {
        printOptimizeHelp();
        return EXIT_OK;
      }
      return runOptimize(rest);
    case "explain":
      if (askedForHelp(rest)) {
        printExplainHelp();
        return EXIT_OK;
      }
      return runExplain(rest);
    default:
      process.stderr.write(`promptc: unknown subcommand: ${sub}\n`);
      printHelp(process.stderr);
      return EXIT_INPUT;
  }
}

/** Detect `--help` / `-h` anywhere in a subcommand's argv. */
function askedForHelp(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Subcommand: passes
// ---------------------------------------------------------------------------

function runPasses(): number {
  const passes = listAllPasses();
  for (const p of passes) {
    process.stdout.write(`${p.name.padEnd(40)}  ${p.description}\n`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Subcommand: parse
// ---------------------------------------------------------------------------

async function runParse(argv: string[]): Promise<number> {
  let flags: ParseFlags;
  try {
    flags = parseParseFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_INPUT;
  }

  const sourceRead = await readSource(flags.inputPath);
  if (sourceRead.error) {
    process.stderr.write(`${sourceRead.error}\n`);
    return EXIT_INPUT;
  }
  const fmt = flags.from ?? inferFormat(flags.inputPath, sourceRead.source);
  const ir = parseSource(sourceRead.source, fmt);
  const v = validateIR(ir);
  if (!v.valid) {
    process.stderr.write(`promptc: IR validation failed:\n`);
    for (const e of v.errors) process.stderr.write(`  - ${e}\n`);
    return EXIT_IR;
  }
  const indent = flags.pretty ? 2 : 0;
  process.stdout.write(JSON.stringify(ir, null, indent) + "\n");
  return EXIT_OK;
}

function parseParseFlags(argv: string[]): ParseFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      in: { type: "string" },
      from: { type: "string" },
      pretty: { type: "boolean", default: true },
      "no-pretty": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    inputPath: values.in,
    from: values.from ? validateFormat(values.from) : undefined,
    pretty: values["no-pretty"] ? false : Boolean(values.pretty),
  };
}

// ---------------------------------------------------------------------------
// Subcommand: optimize
// ---------------------------------------------------------------------------

async function runOptimize(argv: string[]): Promise<number> {
  let flags: OptimizeFlags;
  try {
    flags = parseOptimizeFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_INPUT;
  }

  const sourceRead = await readSource(flags.inputPath);
  if (sourceRead.error) {
    process.stderr.write(`${sourceRead.error}\n`);
    return EXIT_INPUT;
  }

  const fromFmt = flags.from ?? inferFormat(flags.inputPath, sourceRead.source);
  const toFmt = flags.to ?? fromFmt;

  let ir = parseSource(sourceRead.source, fromFmt);

  const inputValidation = validateIR(ir);
  if (!inputValidation.valid) {
    process.stderr.write(`promptc: parsed IR is invalid:\n`);
    for (const e of inputValidation.errors) process.stderr.write(`  - ${e}\n`);
    return EXIT_IR;
  }

  const beforeTokens = tokenCount(sourceRead.source);

  const { ir: finalIR, records, mutationCap } = runPipeline(ir, {
    target: flags.target,
    passes: flags.passes,
    maxMutations: flags.maxMutations,
  });
  ir = finalIR;

  // Validate after passes too.
  const outputValidation = validateIR(ir);
  if (!outputValidation.valid) {
    process.stderr.write(`promptc: post-pass IR is invalid:\n`);
    for (const e of outputValidation.errors) process.stderr.write(`  - ${e}\n`);
    return EXIT_IR;
  }

  // If any explicitly-requested pass refused to run, exit 3.
  // Two cases count: (a) the pass implementation does not exist (stubbed),
  // (b) the pass's declared preconditions failed for this IR.
  if (flags.passes && flags.passes.length > 0) {
    for (const requested of flags.passes) {
      const rec = records.find((r) => r.name === requested);
      if (!rec) {
        process.stderr.write(`promptc: requested pass not found: ${requested}\n`);
        return EXIT_PRECONDITION;
      }
      if (rec.stubbed) {
        process.stderr.write(
          `promptc: pass ${requested} is not implemented (${rec.skipReason})\n`,
        );
        return EXIT_PRECONDITION;
      }
      if (!rec.applied && rec.preconditionFailure) {
        process.stderr.write(
          `promptc: pass ${requested} skipped: ${rec.skipReason}\n`,
        );
        return EXIT_PRECONDITION;
      }
    }
  }

  const output = codegen(ir, { to: toFmt });
  const afterTokens = tokenCount(output);

  if (flags.outputPath) {
    await writeFile(flags.outputPath, output);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }

  // Report on stderr to keep stdout clean for piped output.
  printOptimizeSummary({
    fromFmt,
    toFmt,
    records,
    beforeTokens,
    afterTokens,
    inputSize: sourceRead.source.length,
    outputSize: output.length,
    mutationCap,
    target: flags.target,
  });

  return EXIT_OK;
}

function parseOptimizeFlags(argv: string[]): OptimizeFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", default: "cost" },
      in: { type: "string" },
      out: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      passes: { type: "string" },
      "max-mutations": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const target = values.target ?? "cost";
  if (target !== "cost" && target !== "tokens" && target !== "none") {
    throw new Error(`promptc: unknown --target: ${target}`);
  }
  const flags: OptimizeFlags = {
    target,
    inputPath: values.in,
    outputPath: values.out,
    from: values.from ? validateFormat(values.from) : undefined,
    to: values.to ? validateFormat(values.to) : undefined,
  };
  if (values.passes) {
    flags.passes = values.passes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (values["max-mutations"]) {
    const n = Number.parseInt(values["max-mutations"], 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`promptc: invalid --max-mutations: ${values["max-mutations"]}`);
    }
    flags.maxMutations = n;
  }
  return flags;
}

interface OptimizeSummaryArgs {
  fromFmt: SourceFormat;
  toFmt: SourceFormat;
  records: PassRecord[];
  beforeTokens: number;
  afterTokens: number;
  inputSize: number;
  outputSize: number;
  mutationCap: number | null;
  target: "cost" | "tokens" | "none";
}

function printOptimizeSummary(args: OptimizeSummaryArgs): void {
  const lines: string[] = [];
  lines.push(`promptc optimize: ${args.fromFmt} -> ${args.toFmt}  (target=${args.target})`);
  for (const r of args.records) {
    const status = r.applied ? "applied" : r.preconditionFailure ? "skipped (precondition)" : "skipped (no-op)";
    const droppedTokens = r.droppedTokens !== undefined ? ` -${r.droppedTokens} tok` : "";
    const reason = r.applied || !r.skipReason ? "" : `  [${r.skipReason}]`;
    lines.push(`  pass ${r.name.padEnd(36)} ${status}${droppedTokens}${reason}`);
  }
  if (args.mutationCap !== null) {
    lines.push(`  (mutation cap=${args.mutationCap})`);
  }
  const tokDelta = args.afterTokens - args.beforeTokens;
  const tokDeltaPct =
    args.beforeTokens > 0
      ? ((tokDelta / args.beforeTokens) * 100).toFixed(1)
      : "0.0";
  lines.push(
    `tokens: ${args.beforeTokens} -> ${args.afterTokens}  (${tokDelta >= 0 ? "+" : ""}${tokDelta}, ${tokDelta >= 0 ? "+" : ""}${tokDeltaPct}%)`,
  );
  lines.push(`bytes:  ${args.inputSize} -> ${args.outputSize}`);
  for (const line of lines) process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Subcommand: explain
// ---------------------------------------------------------------------------

async function runExplain(argv: string[]): Promise<number> {
  let flags: ExplainFlags;
  try {
    flags = parseExplainFlags(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_INPUT;
  }
  const sourceRead = await readSource(flags.inputPath);
  if (sourceRead.error) {
    process.stderr.write(`${sourceRead.error}\n`);
    return EXIT_INPUT;
  }
  const fmt = flags.from ?? inferFormat(flags.inputPath, sourceRead.source);
  const ir = parseSource(sourceRead.source, fmt);

  const all = listAllPasses();
  const passInfo = all.find((p) => p.name === flags.pass);
  if (!passInfo) {
    process.stderr.write(`promptc: unknown pass: ${flags.pass}\n`);
    process.stderr.write(`  available: ${all.map((p) => p.name).join(", ")}\n`);
    return EXIT_INPUT;
  }
  if (passInfo.impl === null) {
    process.stdout.write(`# Pass: ${passInfo.name}\n\n`);
    process.stdout.write(`Description: ${passInfo.description}\n\n`);
    process.stdout.write(
      `Status: STUBBED — pass implementation has not landed yet; cannot dry-run.\n`,
    );
    return EXIT_OK;
  }
  const pre = passInfo.impl.preconditions(ir);
  process.stdout.write(`# Pass: ${passInfo.name}\n\n`);
  process.stdout.write(`Description: ${passInfo.description}\n\n`);
  process.stdout.write(`Preconditions: ${pre.ok ? "ok" : "fail"}\n`);
  if (!pre.ok) {
    const reasons = (pre as { reasons?: string[]; reason?: string }).reasons
      ?? ((pre as { reason?: string }).reason ? [(pre as { reason: string }).reason] : []);
    for (const r of reasons) process.stdout.write(`  - ${r}\n`);
    process.stdout.write(`\nDry-run: would skip.\n`);
    return EXIT_OK;
  }
  // Run the pass against a clone to capture diagnostics + droppedTokens, then
  // discard the result. Passes are pure, so this is safe.
  const result = passInfo.impl.run(ir);
  process.stdout.write(`\nDry-run result:\n`);
  process.stdout.write(`  applied: ${result.applied}\n`);
  if (result.reason && result.reason.length > 0) {
    process.stdout.write(`  reason:  ${result.reason}\n`);
  }
  if (result.droppedTokens !== undefined) {
    process.stdout.write(`  droppedTokens (approx): ${result.droppedTokens}\n`);
  }
  if (result.debug) {
    process.stdout.write(`  debug:\n`);
    for (const [k, v] of Object.entries(result.debug)) {
      process.stdout.write(`    ${k}: ${formatDebugValue(v)}\n`);
    }
  }
  return EXIT_OK;
}

function parseExplainFlags(argv: string[]): ExplainFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      in: { type: "string" },
      from: { type: "string" },
      pass: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.pass) {
    throw new Error("promptc: explain requires --pass=<name>");
  }
  return {
    inputPath: values.in,
    from: values.from ? validateFormat(values.from) : undefined,
    pass: values.pass,
  };
}

function formatDebugValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length <= 6) return JSON.stringify(v);
    return `Array(${v.length}) ${JSON.stringify(v.slice(0, 4))}...`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

interface SourceRead {
  source: string;
  error: string | null;
}

async function readSource(path: string | undefined): Promise<SourceRead> {
  if (path === undefined || path === "-") {
    // Read from stdin.
    const chunks: Buffer[] = [];
    return new Promise<SourceRead>((resolve) => {
      // If stdin is a TTY, do not block forever.
      const isTty = (process.stdin as unknown as { isTTY?: boolean }).isTTY === true;
      if (isTty) {
        resolve({
          source: "",
          error: "promptc: no --in= and stdin is a TTY (nothing to read)",
        });
        return;
      }
      process.stdin.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      process.stdin.on("end", () => {
        resolve({ source: Buffer.concat(chunks).toString("utf8"), error: null });
      });
      process.stdin.on("error", (err) => {
        resolve({ source: "", error: `promptc: stdin error: ${err.message}` });
      });
    });
  }
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { source: "", error: `promptc: input file not found: ${path}` };
    }
    const text = await file.text();
    return { source: text, error: null };
  } catch (err) {
    return {
      source: "",
      error: `promptc: failed to read ${path}: ${(err as Error).message}`,
    };
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function inferFormat(path: string | undefined, source: string): SourceFormat {
  if (path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
    if (lower.endsWith(".xml")) return "xml";
    if (lower.endsWith(".txt") || lower.endsWith(".text") || lower.endsWith(".prompt")) {
      return "plain";
    }
  }
  // Heuristic on content.
  const trimmed = source.trimStart();
  if (trimmed.startsWith("<")) return "xml";
  if (trimmed.startsWith("#") || /^\s*#{1,6}\s+/m.test(trimmed)) return "markdown";
  return "plain";
}

function validateFormat(f: string): SourceFormat {
  if (f === "markdown" || f === "xml" || f === "plain") return f;
  throw new Error(`promptc: unknown format: ${f} (expected markdown|xml|plain)`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`promptc — deterministic, LM-free compiler for prompts (v${VERSION})

Usage:
  promptc <subcommand> [flags]

Subcommands:
  optimize    Parse a prompt, run the pass pipeline, emit optimized output.
  parse       Parse a prompt and print the typed IR as JSON.
  passes      List every optimization pass with its description.
  explain     Dry-run a single pass against a prompt; does not modify input.
  version     Print the CLI version.
  help        Print this message.

Common flags:
  --in <path>     Read prompt from a file. Defaults to stdin when omitted.
  --out <path>    Write output to a file. Defaults to stdout (optimize only).
  --from <fmt>    Input format. One of: markdown, xml, plain. Inferred when omitted.
  --to <fmt>      Output format. One of: markdown, xml, plain. Defaults to --from.

Optimize flags:
  --target <name>       cost | tokens | none. Default: cost.
  --passes <a,b,c>      Restrict pipeline to these passes, in this order.
  --max-mutations <n>   Hard cap on total node mutations across the pipeline.

Examples:
  # Optimize a markdown prompt, write the result to a file:
  promptc optimize --target=cost --in prompt.md --out prompt.opt.md

  # Same prompt, emit as XML instead of markdown:
  promptc optimize --target=cost --in prompt.md --to=xml --out prompt.opt.xml

  # Stream via stdin/stdout (composable in shell pipelines):
  cat prompt.md | promptc optimize --target=cost --from=markdown > out.md

  # Only run dead-instruction + whitespace strip, in that order:
  promptc optimize --target=cost \\
    --passes=dead_instruction_elimination,whitespace_redundancy_strip \\
    --in prompt.md

  # Dry-run a single pass without mutating anything:
  promptc explain --in prompt.md --pass=vocab_simplification

  # Inspect the parsed IR:
  promptc parse --in prompt.md --pretty

Streams:
  stdout    optimized prompt (optimize), IR JSON (parse), explanation (explain),
            pass list (passes), or help text.
  stderr    per-pass summary, diagnostics, and error messages.
  The split makes the CLI safe to compose in shell pipelines.

Exit codes:
  0    success
  1    input or flag error (bad path, bad subcommand, bad --target value)
  2    IR validation error (parser or post-pass IR violates an invariant)
  3    an explicitly-requested pass failed preconditions or is not implemented

Determinism:
  Same input bytes + same pass selection + same compiler version produces
  the same output bytes. No LM call, no RNG, no clock, no network.

Docs:
  Quickstart:  docs/QUICKSTART.md
  Passes:      docs/PASSES.md
  IR types:    docs/IR.md
  Comparison:  docs/COMPARISONS.md
  Full design: DESIGN.md
`);
}

function printOptimizeHelp(): void {
  process.stdout.write(`promptc optimize — parse a prompt, run the pass pipeline, emit optimized output.

Usage:
  promptc optimize --target=<cost|tokens|none> [--in <path>] [--out <path>]
                   [--from <fmt>] [--to <fmt>] [--passes <a,b,c>]
                   [--max-mutations <n>]

Flags:
  --target <name>         cost | tokens | none. Default: cost.
                          Today every pass is unconditionally cost-beneficial;
                          the target affects future pass selection only.
  --in <path>             Input file. Reads stdin when omitted.
  --out <path>            Output file. Writes stdout when omitted.
  --from <fmt>            Input format: markdown | xml | plain.
                          Inferred from file extension or content when omitted.
  --to <fmt>              Output format: markdown | xml | plain.
                          Defaults to --from.
  --passes <list>         Comma-separated pass names, in run order. Restricts
                          the pipeline to these passes only. See \`promptc passes\`.
  --max-mutations <n>     Hard cap on total node mutations across the pipeline.

Behavior:
  stdout carries the optimized prompt. stderr carries the per-pass summary.
  Same input bytes + same pass selection + same compiler version produces
  the same output bytes — no LM, no RNG, no clock.

Exit codes:
  0   success
  1   input or flag error
  2   IR validation error (parser or post-pass IR violates an invariant)
  3   an explicitly-requested pass failed preconditions or is not implemented

Examples:
  promptc optimize --target=cost --in prompt.md --out prompt.opt.md
  promptc optimize --target=cost --in prompt.md --to=xml --out prompt.opt.xml
  cat prompt.md | promptc optimize --target=cost --from=markdown > out.md
  promptc optimize --target=cost \\
    --passes=dead_instruction_elimination,whitespace_redundancy_strip \\
    --in prompt.md
`);
}

function printParseHelp(): void {
  process.stdout.write(`promptc parse — parse a prompt and print the typed IR as JSON.

Usage:
  promptc parse [--in <path>] [--from <fmt>] [--pretty | --no-pretty]

Flags:
  --in <path>     Input file. Reads stdin when omitted.
  --from <fmt>    Input format: markdown | xml | plain. Inferred when omitted.
  --pretty        Pretty-print the JSON (default).
  --no-pretty     Emit single-line JSON (useful for piping).

Behavior:
  stdout carries the IR JSON. stderr carries diagnostics. The IR validates
  before printing; on invariant violation, exits 2.

Exit codes:
  0   success
  1   input or flag error
  2   IR validation error

Examples:
  promptc parse --in prompt.md
  promptc parse --in prompt.md --no-pretty | jq '.instructions'
  cat prompt.md | promptc parse --from=markdown
`);
}

function printExplainHelp(): void {
  process.stdout.write(`promptc explain — dry-run a single pass against a prompt.

Usage:
  promptc explain [--in <path>] [--from <fmt>] --pass <name>

Flags:
  --in <path>     Input file. Reads stdin when omitted.
  --from <fmt>    Input format: markdown | xml | plain. Inferred when omitted.
  --pass <name>   Required. The pass to dry-run. See \`promptc passes\` for names.

Behavior:
  Parses the input, evaluates the named pass's preconditions, and (if it
  would run) reports what it would change. Never modifies the IR or any
  file; safe to use against a working prompt for diagnostics.

  The output is a small Markdown report with:
    - the pass description,
    - precondition status (ok / fail with reasons),
    - droppedTokens (approximate, whitespace-tokenized proxy),
    - the pass's per-pass debug payload.

Exit codes:
  0   success (the pass would either run or skip cleanly)
  1   input or flag error, or unknown pass name

Examples:
  promptc explain --in prompt.md --pass=vocab_simplification
  promptc explain --in prompt.md --pass=dead_instruction_elimination
`);
}

function printPassesHelp(): void {
  process.stdout.write(`promptc passes — list every optimization pass with its description.

Usage:
  promptc passes

Behavior:
  Prints one line per pass to stdout, in the default pipeline order:

    1. dead_instruction_elimination
    2. example_pruning_by_mutual_info
    3. format_collapse
    4. whitespace_redundancy_strip
    5. vocab_simplification

  Use \`promptc explain --pass=<name>\` to inspect what a specific pass
  would do to a given prompt.

See docs/PASSES.md for per-pass preconditions, postconditions, and
behavior-preservation arguments.
`);
}

