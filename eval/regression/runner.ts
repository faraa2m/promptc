// eval/regression/runner.ts — behavior-preservation regression harness.
//
// This module is promptc's load-bearing empirical claim:
//   "Running the default promptc pipeline on a prompt does NOT shift its
//    downstream task quality (statistical equivalence, within tolerance)."
//
// It is the eval that backs DESIGN.md §6. The flow per prompt is:
//
//   baseline_output  = run_model(original_prompt)
//   optimized_prompt = promptc.optimize(original_prompt)
//   optimized_output = run_model(optimized_prompt)
//   diff_i           = score(optimized_output) - score(baseline_output)
//
// We then perform a paired bootstrap on `diff_i` and emit an equivalence
// verdict at tolerance ±delta (default 0.02), confidence 1-alpha (default
// 0.95). Equivalence is **declared** only when the bootstrap CI for the
// mean difference is entirely inside [-delta, +delta].
//
// Everything in this file is strict TS, no `any`, no `@ts-ignore`. The
// orchestrator never embeds absolute home paths; sibling repos are
// referenced via `import.meta.url` + `fileURLToPath` + `resolve`.
//
// Determinism:
//   - Corpus selection is seeded (default seed=42).
//   - The paired bootstrap is seeded with the same RNG family used by
//     routerlab tasks (mulberry32). Same seed -> same CI bounds.
//   - The `runFn` is injected; production wires it to a routerlab runner.

import { promptcRoot, repoRootForRegression } from "./paths.ts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Tolerance for behavior preservation. ±delta on the bootstrap CI. */
export const DEFAULT_DELTA = 0.02;

/** Default confidence level (1 - alpha). 0.95 -> alpha = 0.05. */
export const DEFAULT_ALPHA = 0.05;

/** Default bootstrap resample count. 1000 is a standard regression value. */
export const DEFAULT_BOOTSTRAP_RESAMPLES = 1000;

/** Default RNG seed for reproducibility. Matches routerlab convention. */
export const DEFAULT_SEED = 42;

/** Default corpus size — per the brief, 50 prompts. */
export const DEFAULT_CORPUS_SIZE = 50;

// ---------------------------------------------------------------------------
// Task class union — narrowed to the crisp eval tasks promptc validates on.
// ---------------------------------------------------------------------------

/**
 * Task classes the regression harness scores against. We deliberately
 * restrict to crisp classes (DESIGN.md §6) — classification (exact-match)
 * and extractive QA (token-F1). Generative tasks are out of scope.
 */
export type RegressionTaskClass = "classification" | "qa";

/**
 * Anchor pointing back to the repo a corpus example came from. We don't
 * leak full task definitions across the workspace boundary — we just need
 * enough to render the prompt, run a scorer, and trace provenance.
 */
export interface CorpusExample {
  /** Stable identifier (carries the task class + index). */
  id: string;
  taskClass: RegressionTaskClass;
  /** The rendered "original" prompt (what the model sees pre-optimization). */
  prompt: string;
  /** Ground truth — opaque to the build orchestrator; passed to the scorer. */
  reference: unknown;
}

// ---------------------------------------------------------------------------
// Pluggable injection points
// ---------------------------------------------------------------------------

/** Signature of a model-runner abstraction. Pure async function. */
export type RunFn = (req: { prompt: string; tag: "baseline" | "optimized" }) => Promise<{
  output: string;
}>;

/**
 * Signature of a per-task scorer. Returns a value in [0, 1].
 * The harness clamps anything out of range defensively.
 */
export type ScoreFn = (
  taskClass: RegressionTaskClass,
  rawOutput: string,
  reference: unknown,
) => number | Promise<number>;

/**
 * Signature of the optimizer-under-test. Wraps `promptc.optimize` so the
 * orchestrator stays decoupled from the pipeline implementation (and so
 * tests can inject deterministic mocks that do not exercise the parser).
 */
export type OptimizeFn = (input: { source: string; taskClass: RegressionTaskClass }) => Promise<{
  optimized: string;
  /** Names of passes that actually applied (for the audit log). */
  passesApplied: string[];
}>;

// ---------------------------------------------------------------------------
// Bootstrap statistics
// ---------------------------------------------------------------------------

/**
 * Seedable mulberry32 PRNG. Mirrors routerlab's `eval/tasks/_types.ts`
 * implementation so corpus selection (driven by routerlab loaders) and
 * the paired bootstrap can share an RNG family without cross-importing.
 *
 * Determinism: same seed -> same sequence on all platforms (we never
 * touch `Math.random`).
 *
 * Reference: https://stackoverflow.com/a/47593316 (public domain).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One-sided percentile (linear interpolation) over a sorted-in-place
 * array. Caller passes an array they no longer need; we sort in place to
 * avoid an extra allocation in the hot path.
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (p <= 0) return sortedValues[0]!;
  if (p >= 1) return sortedValues[sortedValues.length - 1]!;
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  const a = sortedValues[lo]!;
  const b = sortedValues[hi]!;
  return a + (b - a) * frac;
}

/** Plain mean. Returns 0 on empty input — caller treats that as "no data". */
function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export interface PairedBootstrapResult {
  /** Mean of the observed paired differences. */
  meanDiff: number;
  /** Lower bound of the (1 - alpha) CI on the mean difference. */
  ciLow: number;
  /** Upper bound of the (1 - alpha) CI on the mean difference. */
  ciHigh: number;
  /** Alpha used (e.g. 0.05). */
  alpha: number;
  /** Number of bootstrap resamples used. */
  resamples: number;
  /** Sample size (number of paired observations). */
  n: number;
}

/**
 * Paired bootstrap percentile CI for the mean of `diffs`. Pure function of
 * (diffs, alpha, resamples, seed). No allocations of bootstrap matrices —
 * each resample reuses a single scratch array to keep memory bounded for
 * large corpora.
 *
 * Behavior on edge cases:
 *   - n=0   : returns ciLow=ciHigh=meanDiff=0 (sample size is reported).
 *   - n=1   : returns meanDiff=diffs[0]; CI bounds equal meanDiff (degenerate).
 */
export function pairedBootstrapCI(
  diffs: readonly number[],
  opts: { alpha?: number; resamples?: number; seed?: number } = {},
): PairedBootstrapResult {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const resamples = opts.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = opts.seed ?? DEFAULT_SEED;
  const n = diffs.length;
  if (n === 0) {
    return { meanDiff: 0, ciLow: 0, ciHigh: 0, alpha, resamples, n: 0 };
  }
  const meanDiff = mean(diffs);
  if (n === 1) {
    return { meanDiff, ciLow: meanDiff, ciHigh: meanDiff, alpha, resamples, n };
  }
  const rng = mulberry32(seed);
  const samples = new Array<number>(resamples);
  const scratch = new Array<number>(n);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      const v = diffs[idx]!;
      scratch[i] = v;
      s += v;
    }
    samples[b] = s / n;
  }
  samples.sort((a, b) => a - b);
  const lowPct = alpha / 2;
  const highPct = 1 - alpha / 2;
  const ciLow = percentile(samples, lowPct);
  const ciHigh = percentile(samples, highPct);
  return { meanDiff, ciLow, ciHigh, alpha, resamples, n };
}

/**
 * Verdict shape: equivalent when the entire CI sits inside [-delta, +delta].
 *
 * Why this is the right test: TOST (two one-sided tests for equivalence)
 * under the paired bootstrap reduces to checking that both CI bounds
 * fall within the equivalence margin. We report the bounds verbatim so
 * readers can verify (and tighten / loosen delta) without re-running.
 */
export interface EquivalenceVerdict {
  equivalent: boolean;
  delta: number;
  ciLow: number;
  ciHigh: number;
  meanDiff: number;
  reason: string;
}

export function declareEquivalence(
  result: PairedBootstrapResult,
  delta: number = DEFAULT_DELTA,
): EquivalenceVerdict {
  const lo = result.ciLow;
  const hi = result.ciHigh;
  const within = lo >= -delta && hi <= delta;
  let reason: string;
  if (within) {
    reason = `CI [${lo.toFixed(4)}, ${hi.toFixed(4)}] within ±${delta}`;
  } else if (hi < -delta) {
    reason = `CI upper ${hi.toFixed(4)} below -delta (-${delta}) — optimized is worse`;
  } else if (lo > delta) {
    reason = `CI lower ${lo.toFixed(4)} above +delta (+${delta}) — optimized is better (uncertain equivalence)`;
  } else {
    reason = `CI [${lo.toFixed(4)}, ${hi.toFixed(4)}] straddles ±${delta}; cannot declare equivalence`;
  }
  return {
    equivalent: within,
    delta,
    ciLow: lo,
    ciHigh: hi,
    meanDiff: result.meanDiff,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Per-prompt outcome
// ---------------------------------------------------------------------------

export interface PromptOutcome {
  id: string;
  taskClass: RegressionTaskClass;
  /** SHA-256-truncated digest of the original prompt (for audit). */
  baselineHash: string;
  /** SHA-256-truncated digest of the optimized prompt (for audit). */
  optimizedHash: string;
  baselineOutput: string;
  optimizedOutput: string;
  baselineScore: number;
  optimizedScore: number;
  /** optimizedScore - baselineScore. The harness statistic. */
  scoreDelta: number;
  passesApplied: string[];
  /** Per-prompt error message, if any. Sets baseline/optimized to "". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Sweep driver
// ---------------------------------------------------------------------------

export interface RegressionSweepOptions {
  corpus: readonly CorpusExample[];
  runFn: RunFn;
  scoreFn: ScoreFn;
  optimizeFn: OptimizeFn;
  /** Equivalence margin. Default 0.02. */
  delta?: number;
  /** Bootstrap alpha. Default 0.05. */
  alpha?: number;
  /** Bootstrap resamples. Default 1000. */
  resamples?: number;
  /** RNG seed. Default 42. */
  seed?: number;
  /** Suppress per-prompt console logging (tests set this). */
  quiet?: boolean;
}

export interface SummaryByTaskBlock {
  taskClass: RegressionTaskClass;
  n: number;
  baselineMean: number;
  optimizedMean: number;
  bootstrap: PairedBootstrapResult;
  verdict: EquivalenceVerdict;
}

export interface RegressionSummary {
  schemaVersion: 1;
  generatedAt: string;
  delta: number;
  alpha: number;
  resamples: number;
  seed: number;
  corpusSize: number;
  errors: number;
  /** Per-task-class blocks. */
  byTask: SummaryByTaskBlock[];
  /** Overall block across all task classes. */
  overall: {
    n: number;
    baselineMean: number;
    optimizedMean: number;
    bootstrap: PairedBootstrapResult;
    verdict: EquivalenceVerdict;
  };
}

export interface RunRegressionResult {
  outcomes: PromptOutcome[];
  summary: RegressionSummary;
}

const safeClamp01 = (x: number): number => {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
};

/**
 * Cheap, dependency-free hash for prompt provenance. Not cryptographic;
 * good enough to detect drift between two runs that ought to produce
 * identical prompts. FNV-1a-style 32x2 limbs returned as hex.
 */
export function digest(s: string): string {
  let h1 = 0xcbf29ce4 >>> 0;
  let h2 = 0x84222325 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h1 = (h1 ^ (code & 0xff)) >>> 0;
    const m1 = Math.imul(h1, 0x1b3) >>> 0;
    const m2 = (Math.imul(h2, 0x1b3) + Math.floor((h1 * 0x1b3) / 0x100000000)) >>> 0;
    h1 = m1;
    h2 = m2;
  }
  return (
    h2.toString(16).padStart(8, "0") + h1.toString(16).padStart(8, "0")
  );
}

/**
 * Run the regression sweep. Returns per-prompt outcomes plus the
 * aggregate summary. Side-effect-free: the caller decides what to
 * persist (the CLI writes `summary.json` and per-prompt JSON files).
 */
export async function runRegression(
  opts: RegressionSweepOptions,
): Promise<RunRegressionResult> {
  const delta = opts.delta ?? DEFAULT_DELTA;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const resamples = opts.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = opts.seed ?? DEFAULT_SEED;
  const quiet = opts.quiet ?? false;

  const outcomes: PromptOutcome[] = [];

  for (const example of opts.corpus) {
    const baselineHash = digest(example.prompt);
    let optimized = "";
    let passesApplied: readonly string[] = [];
    let error: string | undefined;
    let baselineOutput = "";
    let optimizedOutput = "";
    let baselineScore = 0;
    let optimizedScore = 0;
    try {
      const optimizeResult = await opts.optimizeFn({
        source: example.prompt,
        taskClass: example.taskClass,
      });
      optimized = optimizeResult.optimized;
      passesApplied = optimizeResult.passesApplied;

      const baselineRun = await opts.runFn({
        prompt: example.prompt,
        tag: "baseline",
      });
      const optimizedRun = await opts.runFn({
        prompt: optimized,
        tag: "optimized",
      });
      baselineOutput = baselineRun.output;
      optimizedOutput = optimizedRun.output;
      baselineScore = safeClamp01(
        await opts.scoreFn(example.taskClass, baselineOutput, example.reference),
      );
      optimizedScore = safeClamp01(
        await opts.scoreFn(example.taskClass, optimizedOutput, example.reference),
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const outcome: PromptOutcome = {
      id: example.id,
      taskClass: example.taskClass,
      baselineHash,
      optimizedHash: optimized.length > 0 ? digest(optimized) : baselineHash,
      baselineOutput,
      optimizedOutput,
      baselineScore,
      optimizedScore,
      scoreDelta: optimizedScore - baselineScore,
      passesApplied: [...passesApplied],
    };
    if (error !== undefined) outcome.error = error;
    outcomes.push(outcome);
    if (!quiet) {
      const tag = error !== undefined ? "ERR" : "OK ";
      const passList =
        outcome.passesApplied.length === 0 ? "—" : outcome.passesApplied.join(",");
      process.stdout.write(
        `[regression] ${tag} ${example.taskClass.padEnd(14)} ${example.id.padEnd(40)} ` +
          `b=${baselineScore.toFixed(3)} o=${optimizedScore.toFixed(3)} ` +
          `d=${outcome.scoreDelta.toFixed(3)} passes=[${passList}]` +
          (error !== undefined ? ` err=${error.slice(0, 80)}` : "") +
          "\n",
      );
    }
  }

  // ---------------------------------------------------------------------
  // Aggregation
  // ---------------------------------------------------------------------

  const errors = outcomes.filter((o) => o.error !== undefined).length;
  const ok = outcomes.filter((o) => o.error === undefined);

  const byTask: SummaryByTaskBlock[] = [];
  for (const tc of ["classification", "qa"] as RegressionTaskClass[]) {
    const bucket = ok.filter((o) => o.taskClass === tc);
    if (bucket.length === 0) continue;
    const diffs = bucket.map((o) => o.scoreDelta);
    const bootstrap = pairedBootstrapCI(diffs, { alpha, resamples, seed });
    const verdict = declareEquivalence(bootstrap, delta);
    byTask.push({
      taskClass: tc,
      n: bucket.length,
      baselineMean: mean(bucket.map((o) => o.baselineScore)),
      optimizedMean: mean(bucket.map((o) => o.optimizedScore)),
      bootstrap,
      verdict,
    });
  }

  const allDiffs = ok.map((o) => o.scoreDelta);
  const overallBootstrap = pairedBootstrapCI(allDiffs, { alpha, resamples, seed });
  const overallVerdict = declareEquivalence(overallBootstrap, delta);

  const summary: RegressionSummary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    delta,
    alpha,
    resamples,
    seed,
    corpusSize: opts.corpus.length,
    errors,
    byTask,
    overall: {
      n: ok.length,
      baselineMean: mean(ok.map((o) => o.baselineScore)),
      optimizedMean: mean(ok.map((o) => o.optimizedScore)),
      bootstrap: overallBootstrap,
      verdict: overallVerdict,
    },
  };

  return { outcomes, summary };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Default results directory: `<promptc-root>/eval/regression/results/`.
 * Resolved via `import.meta.url` so we never embed an absolute home path.
 */
export const DEFAULT_RESULTS_DIR: string = (() => {
  const root = promptcRoot();
  return join(root, "eval", "regression", "results");
})();

/** Anchor used by smoke + CLI when they want the sibling-workspace root. */
export const SIBLING_WORKSPACE_ROOT: string = repoRootForRegression();

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Write the per-prompt outcome JSONs and the summary file. Returns the
 * paths written so the CLI can echo them.
 *
 * Layout:
 *   {resultsDir}/outcomes/{taskClass}/{id}.json
 *   {resultsDir}/summary.json
 */
export function persistResults(
  resultsDir: string,
  result: RunRegressionResult,
): { outcomePaths: string[]; summaryPath: string } {
  const outcomePaths: string[] = [];
  for (const o of result.outcomes) {
    const safeId = o.id.replace(/[^A-Za-z0-9_.-]/g, "_");
    const p = join(resultsDir, "outcomes", o.taskClass, `${safeId}.json`);
    ensureDir(p);
    writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8");
    outcomePaths.push(p);
  }
  const summaryPath = join(resultsDir, "summary.json");
  ensureDir(summaryPath);
  writeFileSync(
    summaryPath,
    JSON.stringify(result.summary, null, 2) + "\n",
    "utf8",
  );
  return { outcomePaths, summaryPath };
}

/**
 * Read previously-persisted outcomes from disk. Returns `[]` when the
 * directory doesn't exist (callers decide whether to rerun the sweep).
 */
export function readPersistedOutcomes(resultsDir: string): PromptOutcome[] {
  const dir = join(resultsDir, "outcomes");
  const out: PromptOutcome[] = [];
  let topLevel: string[];
  try {
    topLevel = readdirSync(dir);
  } catch {
    return out;
  }
  for (const tc of topLevel) {
    let inner: string[];
    try {
      inner = readdirSync(join(dir, tc));
    } catch {
      continue;
    }
    for (const f of inner) {
      if (!f.endsWith(".json")) continue;
      const raw = readFileSync(join(dir, tc, f), "utf8");
      out.push(JSON.parse(raw) as PromptOutcome);
    }
  }
  return out;
}
