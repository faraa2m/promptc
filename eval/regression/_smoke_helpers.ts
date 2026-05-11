// eval/regression/_smoke_helpers.ts — fixture wiring for smoke + tests.
//
// The fixture runner returns ground-truth-shaped outputs for every
// corpus example. The fixture optimizer applies a trivial whitespace
// transform that does not change any quality score. Together they let
// the harness run end-to-end with zero network and zero workspace
// imports — useful for CI and for testing the bootstrap math in
// isolation from the real optimizer.

import type { CorpusExample, OptimizeFn, RunFn } from "./runner.ts";
import type { ClassificationReference, QaReference } from "./corpus.ts";

/**
 * Build a deterministic fixture runner over the given corpus. The runner
 * looks the example up by prompt and returns a ground-truth-shaped
 * output. This means baseline and optimized outputs score identically
 * by construction, so the harness's empirical claim ("score delta ~ 0")
 * is testable without a real LLM.
 *
 * Notably, this also tests the harness's behavior in the *ideal* case:
 * a zero-difference scenario should always pass the equivalence test at
 * the default delta. If a future change to `runRegression` accidentally
 * breaks the bootstrap, this smoke run will fail.
 */
export function fixtureRunFn(corpus: readonly CorpusExample[]): RunFn {
  // Index by prompt prefix for the baseline run; the optimized prompt
  // may differ, so we additionally index by a "logical" key derived
  // from a substring of the original prompt.
  const lookupByPrompt = new Map<string, CorpusExample>();
  for (const ex of corpus) {
    lookupByPrompt.set(ex.prompt, ex);
  }
  // Light substring index for optimized prompts so the runner can still
  // emit the right gold answer after passes mutate whitespace.
  return async (req) => {
    let example = lookupByPrompt.get(req.prompt);
    if (example === undefined) {
      // Try a more lenient lookup: normalize whitespace and match by
      // a stable substring. The QA prompts include a "Passage:" line
      // we can use as a discriminator; classification prompts include
      // a "Tweet:" line.
      example = findByDiscriminator(req.prompt, corpus);
    }
    if (example === undefined) {
      return { output: "" };
    }
    return { output: oracleOutputFor(example) };
  };
}

function findByDiscriminator(
  prompt: string,
  corpus: readonly CorpusExample[],
): CorpusExample | undefined {
  for (const ex of corpus) {
    // Use the discriminator line that appears in both baseline and
    // optimized variants. The classification template has `Tweet:`,
    // the QA template has `Question:`.
    const discrim = extractDiscriminator(ex.prompt);
    if (discrim.length > 0 && prompt.includes(discrim)) {
      return ex;
    }
  }
  return undefined;
}

function extractDiscriminator(prompt: string): string {
  // QA: take the question line ("Question: ...").
  const qMatch = prompt.match(/Question:\s*([^\n]+)/);
  if (qMatch && qMatch[1]) return qMatch[1].trim();
  // Classification: take the tweet line ("Tweet: ...").
  const tMatch = prompt.match(/Tweet:\s*([^\n]+)/);
  if (tMatch && tMatch[1]) return tMatch[1].trim();
  return "";
}

function oracleOutputFor(ex: CorpusExample): string {
  if (ex.taskClass === "qa") {
    const ref = ex.reference as QaReference;
    if (ref.isImpossible) return "no answer";
    return ref.goldAnswers[0] ?? "";
  }
  // Classification.
  return ex.reference as ClassificationReference;
}

/**
 * Trivial fixture optimizer — applies a single whitespace normalization
 * pass to the source so the optimized prompt differs from the baseline
 * (the fixture runner's substring matcher handles it) without changing
 * the semantics that the scorer sees.
 *
 * This intentionally does NOT call the real promptc passes — the smoke
 * harness wants to be runnable in isolation.
 */
export const fixtureOptimize: OptimizeFn = async ({ source }) => {
  // Collapse runs of 3+ newlines to 2, trim trailing whitespace per line.
  const lines = source.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/g, ""));
  const collapsed = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return { optimized: collapsed, passesApplied: ["fixture_whitespace_strip"] };
};
