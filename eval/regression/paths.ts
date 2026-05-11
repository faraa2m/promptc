// eval/regression/paths.ts — repo-relative path resolution.
//
// Every absolute path the regression harness needs is computed from
// `import.meta.url` at runtime. No literal home directories (`/Users/...`)
// or organization-specific URLs are allowed in this file or in anything
// it returns. The privacy scrub for this repo depends on this invariant.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the regression harness directory itself.
 * `<promptc>/eval/regression`.
 */
export function regressionRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Absolute path to the promptc repo root. Computed as two `..` from
 * `eval/regression/`.
 */
export function promptcRoot(): string {
  return resolve(regressionRoot(), "..", "..");
}

/**
 * Absolute path to the sibling-workspace root that contains routerlab /
 * atlas / promptc. Computed as one `..` from `promptcRoot()`.
 */
export function repoRootForRegression(): string {
  return resolve(promptcRoot(), "..");
}

/**
 * Resolve the path to the sibling `routerlab` repo. We use this lazily so
 * a missing sibling fails with a clear error at call site rather than at
 * module load.
 */
export function routerlabRoot(): string {
  return resolve(repoRootForRegression(), "routerlab");
}

/**
 * Resolve the path to the sibling `llm-tokens-atlas` repo. Same lazy
 * resolution as `routerlabRoot()`.
 */
export function atlasRoot(): string {
  return resolve(repoRootForRegression(), "llm-tokens-atlas");
}

/**
 * Resolve the path to a routerlab eval task module relative to the
 * sibling-workspace root. Production code imports from here when it
 * needs to render a routerlab task's prompt template; the regression
 * harness uses this only for path provenance (we never `require()`
 * across repo boundaries — we mirror the prompt templates locally to
 * keep the harness self-contained for the privacy-scrubbed repo).
 */
export function routerlabEvalTaskPath(task: string): string {
  return resolve(routerlabRoot(), "eval", "tasks", `${task}.ts`);
}
