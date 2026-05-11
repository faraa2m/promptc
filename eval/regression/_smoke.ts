#!/usr/bin/env bun
// eval/regression/_smoke.ts — tiny end-to-end sanity check.
//
// Run: `bun eval/regression/_smoke.ts`
//
// This script exercises the build orchestrator using the fixture runner and
// the fixture optimizer. No network, no @promptc/* imports. Produces a
// summary verdict and exits with code 0 iff the bootstrap CI lands
// inside the default ±delta tolerance.
//
// CI calls this directly; the unit test under `regression.test.ts`
// covers the same path via the test runner.

import {
  DEFAULT_RESULTS_DIR,
  persistResults,
  runRegression,
} from "./runner.ts";
import { buildDefaultCorpus, defaultScorer } from "./corpus.ts";
import { fixtureOptimize, fixtureRunFn } from "./_smoke_helpers.ts";

async function main(): Promise<void> {
  const corpus = buildDefaultCorpus({ size: 12, seed: 42 });
  console.log(
    `regression smoke: corpus=${corpus.length} (qa=${corpus.filter((e) => e.taskClass === "qa").length} ` +
      `classification=${corpus.filter((e) => e.taskClass === "classification").length})`,
  );
  const result = await runRegression({
    corpus,
    runFn: fixtureRunFn(corpus),
    optimizeFn: fixtureOptimize,
    scoreFn: defaultScorer,
    quiet: true,
  });
  const paths = persistResults(`${DEFAULT_RESULTS_DIR}/_smoke`, result);
  const v = result.summary.overall.verdict;
  console.log(`regression smoke: outcomes -> ${paths.outcomePaths.length} files`);
  console.log(`regression smoke: summary  -> ${paths.summaryPath}`);
  console.log(
    `regression smoke: baseline_mean=${result.summary.overall.baselineMean.toFixed(4)} ` +
      `optimized_mean=${result.summary.overall.optimizedMean.toFixed(4)}`,
  );
  console.log(
    `regression smoke: meanDiff=${v.meanDiff.toFixed(4)} CI=[${v.ciLow.toFixed(4)}, ${v.ciHigh.toFixed(4)}] delta=±${v.delta}`,
  );
  if (v.equivalent) {
    console.log(`regression smoke: PASS — ${v.reason}`);
    process.exit(0);
  } else {
    console.error(`regression smoke: FAIL — ${v.reason}`);
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    const meta = import.meta as ImportMeta & { main?: boolean };
    if (typeof meta.main === "boolean") return meta.main;
  } catch {
    /* fall through */
  }
  return process.argv[1]?.endsWith("_smoke.ts") ?? false;
})();

if (isMain) {
  await main();
}
