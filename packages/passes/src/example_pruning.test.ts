// packages/passes/src/example_pruning.test.ts

import { describe, expect, test } from "bun:test";

import { examplePruningByMutualInfo } from "./example_pruning.js";
import { example, ir, section } from "./_test_fixtures.js";

describe("example_pruning_by_mutual_info", () => {
  test("preconditions reject < 2 examples", () => {
    const single = ir({
      examples: [example({ id: "e-1", input: "x", output: "y" })],
    });
    const pre = examplePruningByMutualInfo.preconditions(single);
    expect(pre.ok).toBe(false);
  });

  test("preconditions accept >= 2 examples", () => {
    const two = ir({
      examples: [
        example({ id: "e-1", input: "x", output: "y" }),
        example({ id: "e-2", input: "z", output: "w" }),
      ],
    });
    const pre = examplePruningByMutualInfo.preconditions(two);
    expect(pre.ok).toBe(true);
  });

  test("prunes 5 near-identical + 2 distinct down to 3 examples", () => {
    // Five inputs that are near-identical (one word differs each time) form
    // one redundancy cluster at Jaccard >= 0.8. Two distinct inputs are
    // their own singletons.
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "examples",
          exampleRefs: [
            "e-1",
            "e-2",
            "e-3",
            "e-4",
            "e-5",
            "e-distinct-1",
            "e-distinct-2",
          ],
        }),
      ],
      examples: [
        // Near-identical cluster: tokens overlap heavily (Jaccard ≈ 0.846
        // between any pair — single differing token in a 12-token sentence).
        example({
          id: "e-1",
          input:
            "classify the sentiment polarity rating score positive review one alpha beta gamma",
          output: "positive",
        }),
        example({
          id: "e-2",
          input:
            "classify the sentiment polarity rating score positive review two alpha beta gamma",
          output: "neg",
        }),
        example({
          id: "e-3",
          input:
            "classify the sentiment polarity rating score positive review three alpha beta gamma",
          output: "positive medium length output here",
        }),
        example({
          id: "e-4",
          input:
            "classify the sentiment polarity rating score positive review four alpha beta gamma",
          output: "neutral",
        }),
        example({
          id: "e-5",
          input:
            "classify the sentiment polarity rating score positive review five alpha beta gamma",
          output: "neg",
        }),
        // Distinct singletons.
        example({
          id: "e-distinct-1",
          input: "summarize the meeting notes attached below",
          output: "summary one",
        }),
        example({
          id: "e-distinct-2",
          input: "translate english phrase into french accurately",
          output: "translation done",
        }),
      ],
    });

    const res = examplePruningByMutualInfo.run(fixture);
    expect(res.applied).toBe(true);
    // 5 near-identical collapse to 1, plus 2 distinct = 3 retained.
    expect(res.ir.examples.length).toBe(3);

    // The kept representative of the cluster should be the one with the
    // longest output (e-3).
    const keptIds = res.ir.examples.map((e) => e.id);
    expect(keptIds).toContain("e-3");
    expect(keptIds).toContain("e-distinct-1");
    expect(keptIds).toContain("e-distinct-2");

    // Section.exampleRefs reflects the removal.
    const sectionRefs = res.ir.sections[0]?.exampleRefs;
    expect(sectionRefs?.length).toBe(3);
    if (sectionRefs) {
      for (const id of sectionRefs) {
        expect(keptIds).toContain(id);
      }
    }

    expect(res.debug?.examples).toBe(7);
    expect(res.debug?.removed).toBe(4);
  });

  test("no-op when no two examples cross the redundancy threshold", () => {
    const fixture = ir({
      examples: [
        example({ id: "e-1", input: "alpha beta gamma", output: "1" }),
        example({ id: "e-2", input: "delta epsilon zeta", output: "2" }),
        example({ id: "e-3", input: "eta theta iota kappa", output: "3" }),
      ],
    });
    const res = examplePruningByMutualInfo.run(fixture);
    expect(res.applied).toBe(false);
    expect(res.ir).toBe(fixture);
  });

  test("threshold knob controls aggressiveness", () => {
    // At threshold=0.9 these two near-but-not-identical inputs are kept.
    // At threshold=0.4 they collapse.
    const fixture = ir({
      examples: [
        example({
          id: "e-1",
          input: "alpha beta gamma delta epsilon",
          output: "x",
        }),
        example({
          id: "e-2",
          input: "alpha beta gamma delta zeta",
          output: "y",
        }),
      ],
    });
    const high = examplePruningByMutualInfo.run(fixture, {
      exampleRedundancyThreshold: 0.9,
    });
    expect(high.applied).toBe(false);
    expect(high.ir.examples.length).toBe(2);

    const low = examplePruningByMutualInfo.run(fixture, {
      exampleRedundancyThreshold: 0.4,
    });
    expect(low.applied).toBe(true);
    expect(low.ir.examples.length).toBe(1);
  });

  test("threshold out of range yields applied=false with reason", () => {
    const fixture = ir({
      examples: [
        example({ id: "e-1", input: "a b c", output: "x" }),
        example({ id: "e-2", input: "a b c", output: "y" }),
      ],
    });
    const res = examplePruningByMutualInfo.run(fixture, {
      exampleRedundancyThreshold: 1.5,
    });
    expect(res.applied).toBe(false);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  test("ties on output length break by lex-min id (determinism)", () => {
    const fixture = ir({
      examples: [
        // Three identical inputs (token set equal → Jaccard = 1.0). Multi-
        // char tokens are required because the tokenizer drops tokens of
        // length < 2.
        example({ id: "e-b", input: "alpha beta gamma", output: "same" }),
        example({ id: "e-a", input: "alpha beta gamma", output: "same" }),
        example({ id: "e-c", input: "alpha beta gamma", output: "same" }),
      ],
    });
    const res = examplePruningByMutualInfo.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.examples.length).toBe(1);
    expect(res.ir.examples[0]?.id).toBe("e-a");
  });

  test("does not mutate input IR", () => {
    const fixture = ir({
      examples: [
        example({ id: "e-1", input: "alpha beta gamma", output: "1" }),
        example({ id: "e-2", input: "alpha beta gamma", output: "longer 2" }),
        example({ id: "e-3", input: "totally different content", output: "3" }),
      ],
    });
    const before = JSON.stringify(fixture);
    const res = examplePruningByMutualInfo.run(fixture);
    expect(res.applied).toBe(true);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(res.ir).not.toBe(fixture);
  });

  test("determinism: same IR produces same result", () => {
    const fixture = ir({
      examples: [
        example({ id: "e-1", input: "alpha beta gamma one", output: "1" }),
        example({ id: "e-2", input: "alpha beta gamma two", output: "22" }),
        example({ id: "e-3", input: "alpha beta gamma three", output: "333" }),
        example({ id: "e-4", input: "zeta eta theta iota", output: "x" }),
      ],
    });
    const a = examplePruningByMutualInfo.run(fixture);
    const b = examplePruningByMutualInfo.run(fixture);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.applied).toBe(b.applied);
    expect(a.reason).toBe(b.reason);
    expect(a.droppedTokens).toBe(b.droppedTokens);
  });

  test("postcondition: distinct retained clusters do not exceed threshold", () => {
    const fixture = ir({
      examples: [
        example({
          id: "e-1",
          input: "cluster one alpha beta gamma delta",
          output: "x",
        }),
        example({
          id: "e-2",
          input: "cluster one alpha beta gamma delta x",
          output: "y",
        }),
        example({
          id: "e-3",
          input: "cluster two zeta eta theta iota kappa",
          output: "x",
        }),
        example({
          id: "e-4",
          input: "cluster two zeta eta theta iota kappa y",
          output: "y",
        }),
      ],
    });
    const res = examplePruningByMutualInfo.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.examples.length).toBe(2);
    // The two cluster reps must not be near-identical.
    const e1 = res.ir.examples[0];
    const e2 = res.ir.examples[1];
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();
    if (e1 && e2) {
      const t1 = new Set(e1.input.toLowerCase().split(/\s+/));
      const t2 = new Set(e2.input.toLowerCase().split(/\s+/));
      let inter = 0;
      for (const t of t1) if (t2.has(t)) inter += 1;
      const union = t1.size + t2.size - inter;
      const j = union === 0 ? 0 : inter / union;
      expect(j).toBeLessThan(0.8);
    }
  });
});
