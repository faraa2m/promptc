#!/usr/bin/env bun
// eval/regression/cli.ts — full sweep CLI for the regression harness.
//
// Usage:
//   bun eval/regression/cli.ts run [--size=50] [--seed=42] [--delta=0.02]
//                                  [--alpha=0.05] [--resamples=1000]
//                                  [--task=qa|classification]
//                                  [--results-dir=<path>]
//                                  [--runner=fixture|env]
//   bun eval/regression/cli.ts smoke
//   bun eval/regression/cli.ts help
//
// `--runner=fixture` (default for the regression sweep without API keys)
// uses a deterministic synthetic model that returns ground-truth-shaped
// outputs — the score delta on a fixture runner is by construction 0,
// which validates the harness wiring end-to-end without burning credits.
//
// `--runner=env` looks for the `PROMPTC_REGRESSION_RUNNER` env var which
// selects a routerlab runner; if unset, falls back to fixture.

import { existsSync, readFileSync } from "node:fs";

import {
  DEFAULT_ALPHA,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_CORPUS_SIZE,
  DEFAULT_DELTA,
  DEFAULT_RESULTS_DIR,
  DEFAULT_SEED,
  persistResults,
  runRegression,
  type CorpusExample,
  type OptimizeFn,
  type RegressionTaskClass,
  type RunFn,
} from "./runner.ts";
import { buildDefaultCorpus, defaultScorer } from "./corpus.ts";
import { fixtureOptimize, fixtureRunFn } from "./_smoke_helpers.ts";

// We import the production optimizer lazily so the CLI loads even in
// environments where `@promptc/parser` etc are not yet linked.
async function loadPromptcOptimizer(): Promise<OptimizeFn> {
  // Dynamic import keeps the smoke path independent of @promptc/* deps.
  const mod = (await import("./optimize.ts")) as { promptcOptimize: OptimizeFn };
  return mod.promptcOptimize;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[2] ?? "";
  const flags = new Map<string, string | boolean>();
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags.set(arg.slice(2), true);
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }
  return { command, flags };
}

function strFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return "";
  return v;
}

function numFlag(flags: Map<string, string | boolean>, key: string): number | undefined {
  const v = strFlag(flags, key);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function taskFlag(
  flags: Map<string, string | boolean>,
): RegressionTaskClass | undefined {
  const v = strFlag(flags, "task");
  if (v === undefined || v === "") return undefined;
  if (v === "qa" || v === "classification") return v;
  throw new Error(`unknown --task: ${v} (expected qa|classification)`);
}

// ---------------------------------------------------------------------------
// Runner / optimizer selection
// ---------------------------------------------------------------------------

interface RunSelection {
  runFn: RunFn;
  optimizeFn: OptimizeFn;
  description: string;
}

async function selectRunners(
  mode: string,
  corpus: readonly CorpusExample[],
): Promise<RunSelection> {
  if (mode === "fixture") {
    return {
      runFn: fixtureRunFn(corpus),
      optimizeFn: fixtureOptimize,
      description: "fixture (deterministic, no network)",
    };
  }
  if (mode === "promptc-only") {
    // Real optimizer + fixture model. Useful for checking the optimizer
    // path end-to-end without an API call.
    const optimizeFn = await loadPromptcOptimizer();
    return {
      runFn: fixtureRunFn(corpus),
      optimizeFn,
      description: "real optimizer + fixture model",
    };
  }
  if (mode === "env") {
    const optimizeFn = await loadPromptcOptimizer();
    const envName = process.env["PROMPTC_REGRESSION_RUNNER"] ?? "fixture";
    if (envName === "fixture") {
      return {
        runFn: fixtureRunFn(corpus),
        optimizeFn,
        description: "PROMPTC_REGRESSION_RUNNER=fixture (no env runner selected)",
      };
    }
    throw new Error(
      `runner mode "env" requested but the only supported PROMPTC_REGRESSION_RUNNER value in this build is "fixture"`,
    );
  }
  throw new Error(`unknown --runner: ${mode} (expected fixture|promptc-only|env)`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function helpText(): string {
  return [
    "promptc regression harness",
    "",
    "usage:",
    "  bun eval/regression/cli.ts run [--size=50] [--seed=42]",
    "                                 [--delta=0.02] [--alpha=0.05] [--resamples=1000]",
    "                                 [--task=qa|classification]",
    "                                 [--results-dir=<path>]",
    "                                 [--runner=fixture|promptc-only|env]",
    "  bun eval/regression/cli.ts smoke",
    "  bun eval/regression/cli.ts help",
    "",
    "Runners:",
    "  fixture      — synthetic deterministic model, no network. Default.",
    "  promptc-only — real optimizer + fixture model.",
    "  env          — read PROMPTC_REGRESSION_RUNNER (currently only 'fixture').",
    "",
    "Outputs (under --results-dir):",
    "  outcomes/{taskClass}/{id}.json   — per-prompt outcome",
    "  summary.json                      — paired-bootstrap aggregate + verdict",
  ].join("\n");
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const size = numFlag(args.flags, "size") ?? DEFAULT_CORPUS_SIZE;
  const seed = numFlag(args.flags, "seed") ?? DEFAULT_SEED;
  const delta = numFlag(args.flags, "delta") ?? DEFAULT_DELTA;
  const alpha = numFlag(args.flags, "alpha") ?? DEFAULT_ALPHA;
  const resamples =
    numFlag(args.flags, "resamples") ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const task = taskFlag(args.flags);
  const resultsDir = strFlag(args.flags, "results-dir") ?? DEFAULT_RESULTS_DIR;
  const runnerMode = strFlag(args.flags, "runner") ?? "promptc-only";

  const corpus = buildDefaultCorpus({
    size,
    seed,
    ...(task !== undefined ? { taskClass: task } : {}),
  });
  if (corpus.length === 0) {
    process.stderr.write("regression: empty corpus — check --size / --task\n");
    return 2;
  }
  const selection = await selectRunners(runnerMode, corpus);
  process.stdout.write(`regression: corpus=${corpus.length} runner=${selection.description}\n`);

  const result = await runRegression({
    corpus,
    runFn: selection.runFn,
    optimizeFn: selection.optimizeFn,
    scoreFn: defaultScorer,
    delta,
    alpha,
    resamples,
    seed,
  });

  const paths = persistResults(resultsDir, result);
  process.stdout.write(`regression: wrote ${paths.outcomePaths.length} outcome files\n`);
  process.stdout.write(`regression: wrote ${paths.summaryPath}\n`);
  printSummary(paths.summaryPath);
  return result.summary.overall.verdict.equivalent ? 0 : 1;
}

async function cmdSmoke(args: ParsedArgs): Promise<number> {
  // Force the smaller, fully-fixtured path. Useful as a CI sanity check.
  args.flags.set("runner", "fixture");
  if (!args.flags.has("size")) args.flags.set("size", "8");
  if (!args.flags.has("results-dir")) {
    args.flags.set(
      "results-dir",
      `${DEFAULT_RESULTS_DIR}/_smoke`,
    );
  }
  return cmdRun(args);
}

function printSummary(summaryPath: string): void {
  if (!existsSync(summaryPath)) return;
  try {
    const raw = readFileSync(summaryPath, "utf8");
    const parsed = JSON.parse(raw) as {
      overall: {
        n: number;
        baselineMean: number;
        optimizedMean: number;
        bootstrap: { ciLow: number; ciHigh: number; meanDiff: number };
        verdict: { equivalent: boolean; delta: number; reason: string };
      };
      byTask: Array<{
        taskClass: string;
        n: number;
        verdict: { equivalent: boolean; reason: string };
      }>;
    };
    const o = parsed.overall;
    process.stdout.write(
      [
        "",
        "overall:",
        `  n=${o.n}  baseline=${o.baselineMean.toFixed(4)}  optimized=${o.optimizedMean.toFixed(4)}`,
        `  meanDiff=${o.bootstrap.meanDiff.toFixed(4)}  CI=[${o.bootstrap.ciLow.toFixed(4)}, ${o.bootstrap.ciHigh.toFixed(4)}]  delta=±${o.verdict.delta}`,
        `  equivalent=${o.verdict.equivalent ? "YES" : "NO"}  (${o.verdict.reason})`,
        "",
        "by task:",
      ].join("\n") + "\n",
    );
    for (const b of parsed.byTask) {
      process.stdout.write(
        `  ${b.taskClass.padEnd(16)} n=${String(b.n).padStart(3)}  equivalent=${b.verdict.equivalent ? "YES" : "NO"}  (${b.verdict.reason})\n`,
      );
    }
  } catch (e) {
    process.stderr.write(
      `regression: could not parse summary: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "run":
      return cmdRun(args);
    case "smoke":
      return cmdSmoke(args);
    case "":
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(helpText() + "\n");
      return 0;
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n`);
      process.stderr.write(helpText() + "\n");
      return 2;
  }
}

const isMain = (() => {
  try {
    const meta = import.meta as ImportMeta & { main?: boolean };
    if (typeof meta.main === "boolean") return meta.main;
  } catch {
    /* fall through */
  }
  return process.argv[1]?.endsWith("cli.ts") ?? false;
})();

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `regression: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
