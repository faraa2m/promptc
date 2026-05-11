// eval/regression/regression.test.ts — unit tests for the regression harness.
//
// Coverage:
//   1. paired bootstrap correctness on synthetic diff distributions
//   2. equivalence verdict logic (within / above / below tolerance)
//   3. determinism: same seed -> same bootstrap CI bounds
//   4. end-to-end smoke completes via fixture runners
//   5. persistence round-trip
//   6. corpus determinism
//
// All tests use bun:test and run in-process. No network. No
// @promptc/* imports — the harness module under test is itself
// workspace-import-free; the production optimizer is only wired up in
// `optimize.ts` and is exercised by a separate file when present.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DELTA,
  declareEquivalence,
  digest,
  mulberry32,
  pairedBootstrapCI,
  persistResults,
  readPersistedOutcomes,
  runRegression,
  type CorpusExample,
  type OptimizeFn,
  type RegressionSummary,
  type RunFn,
} from "./runner.ts";
import {
  buildDefaultCorpus,
  defaultScorer,
  renderClassificationPrompt,
  renderQaPrompt,
  tokenF1,
} from "./corpus.ts";
import { fixtureOptimize, fixtureRunFn } from "./_smoke_helpers.ts";

// ---------------------------------------------------------------------------
// Bootstrap correctness
// ---------------------------------------------------------------------------

describe("pairedBootstrapCI", () => {
  test("returns 0/0 on empty input", () => {
    const r = pairedBootstrapCI([]);
    expect(r.n).toBe(0);
    expect(r.meanDiff).toBe(0);
    expect(r.ciLow).toBe(0);
    expect(r.ciHigh).toBe(0);
  });

  test("returns degenerate CI on n=1", () => {
    const r = pairedBootstrapCI([0.5]);
    expect(r.n).toBe(1);
    expect(r.meanDiff).toBeCloseTo(0.5, 10);
    expect(r.ciLow).toBeCloseTo(0.5, 10);
    expect(r.ciHigh).toBeCloseTo(0.5, 10);
  });

  test("CI contains the mean for a unimodal distribution", () => {
    // Symmetric small-spread distribution centered at 0.005.
    const diffs = [-0.01, 0, 0.005, 0.01, 0.015, 0, 0.005, -0.005, 0.01, 0];
    const r = pairedBootstrapCI(diffs, { seed: 7, resamples: 2000 });
    expect(r.meanDiff).toBeGreaterThan(-0.02);
    expect(r.meanDiff).toBeLessThan(0.02);
    expect(r.ciLow).toBeLessThan(r.meanDiff + 1e-9);
    expect(r.ciHigh).toBeGreaterThan(r.meanDiff - 1e-9);
  });

  test("CI widens with larger spread", () => {
    const tight = [0.001, -0.001, 0.002, -0.002, 0.001, -0.001, 0.002, -0.002];
    const wide = [0.2, -0.2, 0.3, -0.3, 0.2, -0.2, 0.3, -0.3];
    const a = pairedBootstrapCI(tight, { seed: 1, resamples: 1500 });
    const b = pairedBootstrapCI(wide, { seed: 1, resamples: 1500 });
    expect(b.ciHigh - b.ciLow).toBeGreaterThan(a.ciHigh - a.ciLow);
  });

  test("deterministic: same seed -> identical CI bounds", () => {
    const diffs = [
      0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, -0.02, 0.03, -0.01,
    ];
    const a = pairedBootstrapCI(diffs, { seed: 123, resamples: 500 });
    const b = pairedBootstrapCI(diffs, { seed: 123, resamples: 500 });
    expect(a.meanDiff).toBe(b.meanDiff);
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
  });

  test("different seed -> different CI bounds (typically)", () => {
    const diffs = [
      0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, -0.02, 0.03, -0.01,
    ];
    const a = pairedBootstrapCI(diffs, { seed: 1, resamples: 500 });
    const b = pairedBootstrapCI(diffs, { seed: 2, resamples: 500 });
    // The bounds should be close but not identical for n=10.
    expect(a.ciLow !== b.ciLow || a.ciHigh !== b.ciHigh).toBe(true);
  });
});

describe("mulberry32", () => {
  test("identical seed -> identical sequence", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 10; i++) {
      expect(r1()).toBe(r2());
    }
  });
});

// ---------------------------------------------------------------------------
// Equivalence verdict
// ---------------------------------------------------------------------------

describe("declareEquivalence", () => {
  test("declares equivalence when CI is inside +/- delta", () => {
    const r = pairedBootstrapCI([0.0, 0.005, -0.005, 0.01], {
      seed: 1,
      resamples: 500,
    });
    const v = declareEquivalence(r, 0.05);
    expect(v.equivalent).toBe(true);
    expect(v.reason).toContain("within ±0.05");
  });

  test("rejects equivalence when CI clearly above +delta", () => {
    const r = pairedBootstrapCI([0.5, 0.6, 0.55, 0.45], {
      seed: 1,
      resamples: 500,
    });
    const v = declareEquivalence(r, 0.02);
    expect(v.equivalent).toBe(false);
    expect(v.reason).toContain("above +delta");
  });

  test("rejects equivalence when CI clearly below -delta", () => {
    const r = pairedBootstrapCI([-0.5, -0.6, -0.55, -0.45], {
      seed: 1,
      resamples: 500,
    });
    const v = declareEquivalence(r, 0.02);
    expect(v.equivalent).toBe(false);
    expect(v.reason).toContain("below -delta");
  });

  test("rejects equivalence when CI straddles the boundary", () => {
    const r = pairedBootstrapCI([-0.05, 0.05, -0.04, 0.04, -0.05, 0.05], {
      seed: 1,
      resamples: 1000,
    });
    const v = declareEquivalence(r, 0.02);
    expect(v.equivalent).toBe(false);
    expect(v.reason).toContain("straddles");
  });

  test("default delta is 0.02", () => {
    expect(DEFAULT_DELTA).toBe(0.02);
  });
});

// ---------------------------------------------------------------------------
// Corpus determinism
// ---------------------------------------------------------------------------

describe("buildDefaultCorpus", () => {
  test("same seed + size produces the same ordering", () => {
    const a = buildDefaultCorpus({ size: 10, seed: 1 });
    const b = buildDefaultCorpus({ size: 10, seed: 1 });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  test("different seeds produce different orderings", () => {
    const a = buildDefaultCorpus({ size: 10, seed: 1 });
    const b = buildDefaultCorpus({ size: 10, seed: 2 });
    // Should not be identical for a pool size > 10 (we have 50).
    const aIds = a.map((e) => e.id).join(",");
    const bIds = b.map((e) => e.id).join(",");
    expect(aIds).not.toEqual(bIds);
  });

  test("size larger than pool returns the full pool", () => {
    const all = buildDefaultCorpus({ size: 1000, seed: 1 });
    expect(all.length).toBeGreaterThanOrEqual(50);
  });

  test("respects taskClass filter", () => {
    const qaOnly = buildDefaultCorpus({ size: 50, seed: 1, taskClass: "qa" });
    for (const ex of qaOnly) expect(ex.taskClass).toBe("qa");
    const clsOnly = buildDefaultCorpus({
      size: 50,
      seed: 1,
      taskClass: "classification",
    });
    for (const ex of clsOnly) expect(ex.taskClass).toBe("classification");
  });

  test("prompt templates are routerlab-equivalent", () => {
    // Ensure the prompt templates mirror routerlab's templates by
    // checking the anchor strings the routerlab parsers look for.
    expect(renderQaPrompt({ context: "C", question: "Q" })).toContain(
      "Read this passage and answer the question.",
    );
    expect(renderQaPrompt({ context: "C", question: "Q" })).toContain("Passage: C");
    expect(renderQaPrompt({ context: "C", question: "Q" })).toContain("Question: Q");
    expect(renderClassificationPrompt({ text: "t" })).toContain(
      "Classify this tweet's sentiment as exactly one of: negative, neutral, positive.",
    );
  });
});

// ---------------------------------------------------------------------------
// Default scorer
// ---------------------------------------------------------------------------

describe("defaultScorer", () => {
  test("classification: exact match returns 1, mismatch 0", async () => {
    const ref = "positive" as const;
    expect(await defaultScorer("classification", "positive", ref)).toBe(1);
    expect(await defaultScorer("classification", "negative", ref)).toBe(0);
    expect(await defaultScorer("classification", "neg", ref)).toBe(0);
    expect(await defaultScorer("classification", "pos", ref)).toBe(1);
  });

  test("qa: token F1 over the gold list", async () => {
    const ref = { goldAnswers: ["Gustave Eiffel"], isImpossible: false };
    expect(await defaultScorer("qa", "Gustave Eiffel", ref)).toBeCloseTo(1, 6);
    expect(await defaultScorer("qa", "eiffel", ref)).toBeGreaterThan(0);
    expect(await defaultScorer("qa", "wrong answer", ref)).toBe(0);
  });

  test("qa: impossible question with abstain phrase scores 1", async () => {
    const ref = { goldAnswers: [], isImpossible: true };
    expect(await defaultScorer("qa", "no answer", ref)).toBe(1);
    expect(await defaultScorer("qa", "definitely yes", ref)).toBe(0);
  });

  test("tokenF1 boundary cases", () => {
    expect(tokenF1("", "")).toBe(1);
    expect(tokenF1("", "x")).toBe(0);
    expect(tokenF1("x", "")).toBe(0);
    expect(tokenF1("foo bar baz", "foo bar baz")).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// digest stability
// ---------------------------------------------------------------------------

describe("digest", () => {
  test("same input -> same hex", () => {
    expect(digest("hello world")).toEqual(digest("hello world"));
  });
  test("differs on different input", () => {
    expect(digest("hello world")).not.toEqual(digest("hello world!"));
  });
  test("hex length is 16", () => {
    expect(digest("anything").length).toBe(16);
    expect(/^[0-9a-f]+$/.test(digest("anything"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke
// ---------------------------------------------------------------------------

describe("runRegression — fixture smoke", () => {
  test("zero-diff fixture runner declares equivalence", async () => {
    const corpus = buildDefaultCorpus({ size: 12, seed: 42 });
    const result = await runRegression({
      corpus,
      runFn: fixtureRunFn(corpus),
      optimizeFn: fixtureOptimize,
      scoreFn: defaultScorer,
      quiet: true,
    });
    // The fixture runner returns gold answers verbatim for baseline AND
    // optimized variants, so per-prompt deltas should be exactly 0.
    for (const o of result.outcomes) {
      expect(o.scoreDelta).toBe(0);
    }
    expect(result.summary.overall.verdict.equivalent).toBe(true);
    expect(result.summary.overall.n).toBe(corpus.length);
    expect(result.summary.errors).toBe(0);
    // byTask blocks should exist for both task classes given a 12-row corpus.
    const tasks = result.summary.byTask.map((b) => b.taskClass).sort();
    expect(tasks).toContain("classification");
    expect(tasks).toContain("qa");
    for (const block of result.summary.byTask) {
      expect(block.verdict.equivalent).toBe(true);
    }
  });

  test("biased optimizer that always returns gold answer fails equivalence high side", async () => {
    // Construct a scenario where the optimized output is always correct
    // but the baseline output is always wrong — the harness should NOT
    // declare equivalence (the optimized prompt is better, not just
    // equivalent).
    const corpus = buildDefaultCorpus({
      size: 12,
      seed: 1,
      taskClass: "classification",
    });
    const biasedRun: RunFn = async (req) => {
      // Baseline: always returns "neutral" (wrong roughly 2/3 of the time).
      if (req.tag === "baseline") return { output: "neutral" };
      // Optimized: cheats and returns the right label.
      const ex = corpus.find((e) => e.prompt.includes(extractTweet(req.prompt)));
      return { output: (ex?.reference as string) ?? "neutral" };
    };
    const optimizeFn: OptimizeFn = async ({ source }) => ({
      optimized: source + "\n",
      passesApplied: [],
    });
    const result = await runRegression({
      corpus,
      runFn: biasedRun,
      optimizeFn,
      scoreFn: defaultScorer,
      quiet: true,
    });
    expect(result.summary.overall.verdict.equivalent).toBe(false);
  });

  test("biased optimizer that drops information fails equivalence low side", async () => {
    const corpus = buildDefaultCorpus({
      size: 12,
      seed: 1,
      taskClass: "classification",
    });
    const biasedRun: RunFn = async (req) => {
      // Baseline: returns the correct label.
      const ex = corpus.find((e) =>
        req.prompt.includes(extractTweet(req.prompt)),
      );
      const correct = (ex?.reference as string) ?? "neutral";
      if (req.tag === "baseline") return { output: correct };
      // Optimized: always returns "neutral" (wrong most of the time).
      return { output: "neutral" };
    };
    const optimizeFn: OptimizeFn = async ({ source }) => ({
      optimized: source + "\n",
      passesApplied: [],
    });
    const result = await runRegression({
      corpus,
      runFn: biasedRun,
      optimizeFn,
      scoreFn: defaultScorer,
      quiet: true,
    });
    expect(result.summary.overall.verdict.equivalent).toBe(false);
  });

  test("captures per-prompt errors without aborting", async () => {
    const corpus = buildDefaultCorpus({ size: 6, seed: 7 });
    let calls = 0;
    const flakyRun: RunFn = async (req) => {
      calls++;
      if (calls === 2) throw new Error("simulated runner error");
      // Mirror the fixture runner's oracle behavior.
      const proxy = fixtureRunFn(corpus);
      return proxy(req);
    };
    const result = await runRegression({
      corpus,
      runFn: flakyRun,
      optimizeFn: fixtureOptimize,
      scoreFn: defaultScorer,
      quiet: true,
    });
    expect(result.summary.errors).toBe(1);
    expect(result.outcomes.find((o) => o.error !== undefined)).toBeDefined();
  });
});

function extractTweet(prompt: string): string {
  const m = prompt.match(/Tweet:\s*([^\n]+)/);
  return m && m[1] ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence", () => {
  test("persist + read round-trip", async () => {
    const corpus = buildDefaultCorpus({ size: 6, seed: 42 });
    const result = await runRegression({
      corpus,
      runFn: fixtureRunFn(corpus),
      optimizeFn: fixtureOptimize,
      scoreFn: defaultScorer,
      quiet: true,
    });
    const dir = mkdtempSync(join(tmpdir(), "promptc-regression-"));
    try {
      const paths = persistResults(dir, result);
      expect(paths.outcomePaths.length).toBe(corpus.length);
      const summary = JSON.parse(readFileSync(paths.summaryPath, "utf8")) as RegressionSummary;
      expect(summary.schemaVersion).toBe(1);
      expect(summary.corpusSize).toBe(corpus.length);
      expect(summary.overall.verdict.equivalent).toBe(true);

      const reloaded = readPersistedOutcomes(dir);
      expect(reloaded.length).toBe(corpus.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
