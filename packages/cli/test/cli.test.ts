// packages/cli/test/cli.test.ts
//
// End-to-end tests for the `promptc` CLI. Spawn the CLI as a subprocess via
// `Bun.spawn` so we exercise the exit-code surface too.
//
// Tests cover:
//   - `optimize` end-to-end on a markdown fixture (exit 0, output non-empty,
//     summary printed to stderr).
//   - `parse` emits JSON IR.
//   - `passes` lists all 5 passes.
//   - `explain` runs a per-pass dry-run.
//   - Bad flag combos exit with the right code.
//   - Stdin streaming works (`cat file | promptc optimize`).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
const FIXTURE_MD = new URL("./fixtures/sentiment.md", import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  options: { stdin?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin !== undefined ? "pipe" : "inherit",
  });
  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("promptc CLI — version + help", () => {
  test("version prints the package version", async () => {
    const r = await runCli(["version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test("help prints usage", async () => {
    const r = await runCli(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("optimize");
    expect(r.stdout).toContain("parse");
    expect(r.stdout).toContain("passes");
    expect(r.stdout).toContain("explain");
  });
  test("unknown subcommand exits 1", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown subcommand");
  });
});

describe("promptc CLI — passes", () => {
  test("lists all 5 passes", async () => {
    const r = await runCli(["passes"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toEqual(5);
    expect(r.stdout).toContain("dead_instruction_elimination");
    expect(r.stdout).toContain("example_pruning_by_mutual_info");
    expect(r.stdout).toContain("format_collapse");
    expect(r.stdout).toContain("whitespace_redundancy_strip");
    expect(r.stdout).toContain("vocab_simplification");
  });
});

describe("promptc CLI — parse", () => {
  test("parses a markdown fixture and emits IR JSON", async () => {
    const r = await runCli(["parse", "--in", FIXTURE_MD]);
    expect(r.exitCode).toBe(0);
    const ir = JSON.parse(r.stdout) as {
      irVersion: number;
      sections: unknown[];
      instructions: unknown[];
      examples: unknown[];
      metadata: { sourceFormat: string };
    };
    expect(ir.irVersion).toEqual(1);
    expect(Array.isArray(ir.sections)).toBe(true);
    expect(ir.sections.length).toBeGreaterThan(0);
    expect(ir.metadata.sourceFormat).toEqual("markdown");
    // There should be at least 5 instructions and 5 examples from the fixture.
    expect(ir.instructions.length).toBeGreaterThanOrEqual(5);
    expect(ir.examples.length).toBeGreaterThanOrEqual(5);
  });
  test("parse reads from stdin when no --in", async () => {
    const fixture = await Bun.file(FIXTURE_MD).text();
    const r = await runCli(["parse", "--from", "markdown"], { stdin: fixture });
    expect(r.exitCode).toBe(0);
    const ir = JSON.parse(r.stdout) as { irVersion: number };
    expect(ir.irVersion).toEqual(1);
  });
  test("parse exits 1 on missing file", async () => {
    const r = await runCli(["parse", "--in", "/tmp/does-not-exist-promptc-cli.md"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

describe("promptc CLI — optimize", () => {
  test("optimize runs the full pipeline and prints output + summary", async () => {
    const r = await runCli([
      "optimize",
      "--target=cost",
      "--in",
      FIXTURE_MD,
    ]);
    expect(r.exitCode).toBe(0);
    // stdout = optimized prompt.
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toContain("Role");
    // stderr = per-pass summary.
    expect(r.stderr).toContain("dead_instruction_elimination");
    expect(r.stderr).toContain("example_pruning_by_mutual_info");
    expect(r.stderr).toContain("format_collapse");
    expect(r.stderr).toContain("whitespace_redundancy_strip");
    expect(r.stderr).toContain("vocab_simplification");
    expect(r.stderr).toContain("tokens:");
  });
  test("optimize honors --to override (xml output)", async () => {
    const r = await runCli([
      "optimize",
      "--target=cost",
      "--in",
      FIXTURE_MD,
      "--to=xml",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith("<prompt>")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("</prompt>")).toBe(true);
  });
  test("optimize writes to --out file", async () => {
    const outPath = join(
      "/tmp",
      `promptc-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    );
    const r = await runCli([
      "optimize",
      "--target=cost",
      "--in",
      FIXTURE_MD,
      "--out",
      outPath,
    ]);
    expect(r.exitCode).toBe(0);
    const written = await Bun.file(outPath).text();
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("Role");
  });
  test("optimize reads from stdin", async () => {
    const fixture = await Bun.file(FIXTURE_MD).text();
    const r = await runCli(
      ["optimize", "--target=cost", "--from=markdown"],
      { stdin: fixture },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
  test("optimize exits 1 on bad --target", async () => {
    const r = await runCli([
      "optimize",
      "--target=invalid",
      "--in",
      FIXTURE_MD,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--target");
  });
  test("optimize exits 1 on bad --to value", async () => {
    const r = await runCli([
      "optimize",
      "--target=cost",
      "--in",
      FIXTURE_MD,
      "--to=yaml",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown format");
  });
});

describe("promptc CLI — explain", () => {
  test("explain runs a dry-run for a known pass", async () => {
    const r = await runCli([
      "explain",
      "--in",
      FIXTURE_MD,
      "--pass=whitespace_redundancy_strip",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("# Pass: whitespace_redundancy_strip");
    expect(r.stdout).toContain("Preconditions:");
    expect(r.stdout).toContain("Dry-run result:");
  });
  test("explain rejects unknown pass with exit 1", async () => {
    const r = await runCli([
      "explain",
      "--in",
      FIXTURE_MD,
      "--pass=does_not_exist",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown pass");
  });
  test("explain requires --pass", async () => {
    const r = await runCli(["explain", "--in", FIXTURE_MD]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--pass");
  });
});

describe("promptc CLI — pass precondition exit code", () => {
  test("optimize with explicit pass that fails preconditions exits 3", async () => {
    // example_pruning needs >=2 examples. Feed it a minimal prompt.
    const minimalPrompt = "# Role\n\nYou are helpful.\n";
    const r = await runCli(
      ["optimize", "--target=cost", "--from=markdown", "--passes=example_pruning_by_mutual_info"],
      { stdin: minimalPrompt },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("example_pruning_by_mutual_info");
  });
  test("optimize with unknown pass exits 3", async () => {
    const fixture = await Bun.file(FIXTURE_MD).text();
    const r = await runCli(
      ["optimize", "--target=cost", "--from=markdown", "--passes=not_a_real_pass"],
      { stdin: fixture },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("not_a_real_pass");
  });
});
