// packages/passes/src/vocab_simplification.test.ts

import { describe, expect, test } from "bun:test";

import {
  vocabSimplification,
  __internals as vs,
} from "./vocab_simplification.js";
import { example, instruction, ir, section } from "./_test_fixtures.js";

describe("vocab_simplification — table integrity", () => {
  test("table has at least 50 entries", () => {
    expect(vs.VOCAB.length).toBeGreaterThanOrEqual(50);
  });

  test("table has fewer than 200 entries (kept conservative)", () => {
    expect(vs.VOCAB.length).toBeLessThan(200);
  });

  test("every entry's short form is strictly shorter than its long form", () => {
    for (const e of vs.VOCAB) {
      expect(e.short.length).toBeLessThan(e.long.length);
    }
  });

  test("every entry's long form is stored in lowercase", () => {
    for (const e of vs.VOCAB) {
      expect(e.long).toBe(e.long.toLowerCase());
    }
  });

  test("table is sorted by descending long-form length", () => {
    for (let i = 1; i < vs.VOCAB.length; i++) {
      const prev = vs.VOCAB[i - 1];
      const curr = vs.VOCAB[i];
      if (!prev || !curr) continue;
      expect(prev.long.length).toBeGreaterThanOrEqual(curr.long.length);
    }
  });

  test("TABLE_HASH is a stable 8-hex-digit fingerprint", () => {
    expect(vs.TABLE_HASH.length).toBe(8);
    expect(/^[0-9a-f]{8}$/.test(vs.TABLE_HASH)).toBe(true);
  });
});

describe("vocab_simplification — preconditions", () => {
  test("rejects an empty IR", () => {
    const pre = vocabSimplification.preconditions(ir());
    expect(pre.ok).toBe(false);
  });

  test("accepts an IR with at least one instruction", () => {
    const fixture = ir({
      instructions: [instruction({ id: "i-1", text: "in order to start" })],
    });
    const pre = vocabSimplification.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });

  test("accepts an IR with at least one non-empty section body", () => {
    const fixture = ir({
      sections: [
        section({ id: "s-1", kind: "task", body: "due to the fact that" }),
      ],
    });
    const pre = vocabSimplification.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });
});

describe("vocab_simplification — replacement behaviour", () => {
  test("'in order to' -> 'to'", () => {
    const { text, count } = vs.rewriteText("we use a tool in order to ship.");
    expect(text).toBe("we use a tool to ship.");
    expect(count).toBe(1);
  });

  test("'In order to' -> 'To' (case-preserving)", () => {
    const { text } = vs.rewriteText("In order to ship, do X.");
    expect(text.startsWith("To ")).toBe(true);
  });

  test("'due to the fact that' -> 'because'", () => {
    const { text } = vs.rewriteText("we ship due to the fact that we must.");
    expect(text).toBe("we ship because we must.");
  });

  test("'at this point in time' -> 'now'", () => {
    const { text } = vs.rewriteText("at this point in time we ship.");
    expect(text).toBe("now we ship.");
  });

  test("longest-match-at-position is preferred over shorter alternatives", () => {
    // "in addition" (-> "also") is shorter than "in addition to" (-> "and").
    // At position 0 of "in addition to X", the longer phrase must win.
    const { text } = vs.rewriteText("in addition to X we ship");
    expect(text).toBe("and X we ship");
  });

  test("multiple non-overlapping matches in one string", () => {
    const { text, count } = vs.rewriteText(
      "in order to ship, due to the fact that it is essential that we move.",
    );
    expect(text).toBe("to ship, because you must we move.");
    expect(count).toBe(3);
  });

  test("does not match across word boundaries (no partial-word swaps)", () => {
    // The token "to" appears inside "tomorrow" — must not be rewritten.
    const { text, count } = vs.rewriteText("tomorrow we ship");
    expect(text).toBe("tomorrow we ship");
    expect(count).toBe(0);
  });

  test("does not touch text inside fenced code blocks", () => {
    const src = "use this in order to:\n```\nin order to // sample\n```\ndone";
    const { text } = vs.rewriteText(src);
    expect(text).toContain("in order to // sample"); // unchanged inside fence
    expect(text).toContain("use this to:"); // changed outside fence
  });

  test("does not touch text inside inline backtick code spans", () => {
    const { text } = vs.rewriteText(
      "the variable `in order to` is literal, but in order to compute, do X",
    );
    expect(text).toContain("`in order to`");
    expect(text).toContain("but to compute");
  });

  test("does not touch text inside {{slot}} placeholders", () => {
    const { text } = vs.rewriteText(
      "render {{in order to}} verbatim; in order to ship, do X",
    );
    expect(text).toContain("{{in order to}}");
    expect(text).toContain("to ship");
  });

  test("does not touch text inside <slot .../> XML tags", () => {
    const { text } = vs.rewriteText(
      'pass <slot name="payload"/> through; in order to ship, do X',
    );
    expect(text).toContain('<slot name="payload"/>');
    expect(text).toContain("to ship");
  });

  test("empty-replacement phrases delete the phrase + one trailing space", () => {
    const { text, count } = vs.rewriteText(
      "needless to say we ship every day",
    );
    expect(text).toBe("we ship every day");
    expect(count).toBe(1);
  });
});

describe("vocab_simplification — pass orchestration", () => {
  test("rewrites Instruction.text but not Example.input/output", () => {
    const fixture = ir({
      instructions: [
        instruction({ id: "i-1", text: "in order to ship, click the button" }),
      ],
      examples: [
        example({
          id: "e-1",
          input: "due to the fact that the user typed X",
          output: "in order to do Y",
        }),
      ],
    });
    const res = vocabSimplification.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.instructions[0]?.text).toBe("to ship, click the button");
    // Examples must not be touched.
    expect(res.ir.examples[0]?.input).toBe("due to the fact that the user typed X");
    expect(res.ir.examples[0]?.output).toBe("in order to do Y");
  });

  test("rewrites Section.body", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "we make a decision in order to proceed",
        }),
      ],
    });
    const res = vocabSimplification.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("we decide to proceed");
  });

  test("honours preserve_text=true on a section", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "in order to ship",
          attrs: { preserve_text: "true" },
        }),
        section({
          id: "s-2",
          kind: "task",
          body: "in order to ship",
        }),
      ],
    });
    const res = vocabSimplification.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("in order to ship");
    expect(res.ir.sections[1]?.body).toBe("to ship");
  });

  test("preserves instruction id, kind, refersToFields, slotRefs", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          kind: "required",
          text: "in order to answer, do X",
          refersToFields: ["answer"],
          slotRefs: ["sl-1"],
        }),
      ],
    });
    const res = vocabSimplification.run(fixture);
    const out = res.ir.instructions[0];
    expect(out?.id).toBe("i-1");
    expect(out?.kind).toBe("required");
    expect(out?.refersToFields).toEqual(["answer"]);
    expect(out?.slotRefs).toEqual(["sl-1"]);
  });

  test("attaches tableHash and tableSize to debug payload", () => {
    const fixture = ir({
      instructions: [instruction({ id: "i-1", text: "in order to" })],
    });
    const res = vocabSimplification.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.debug).toBeDefined();
    expect(res.debug?.tableHash).toBe(vs.TABLE_HASH);
    expect(res.debug?.tableSize).toBe(vs.VOCAB.length);
  });
});

describe("vocab_simplification — postconditions", () => {
  test("no instruction or section retains any 'long' phrase from the table", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "in order to ship due to the fact that we must",
        }),
      ],
      instructions: [
        instruction({
          id: "i-1",
          text: "at this point in time, make a decision",
        }),
      ],
    });
    const res = vocabSimplification.run(fixture);
    expect(res.applied).toBe(true);
    for (const s of res.ir.sections) {
      for (const e of vs.VOCAB) {
        // Word-boundary aware regex per the rewriter contract.
        const re = new RegExp(`(^|\\W)${escapeRe(e.long)}(\\W|$)`, "i");
        expect(re.test(s.body)).toBe(false);
      }
    }
    for (const instr of res.ir.instructions) {
      for (const e of vs.VOCAB) {
        const re = new RegExp(`(^|\\W)${escapeRe(e.long)}(\\W|$)`, "i");
        expect(re.test(instr.text)).toBe(false);
      }
    }
  });
});

describe("vocab_simplification — determinism + purity", () => {
  test("does not mutate the input IR", () => {
    const fixture = ir({
      instructions: [
        instruction({ id: "i-1", text: "in order to ship verbatim" }),
      ],
    });
    const snapshot = JSON.stringify(fixture);
    const res = vocabSimplification.run(fixture);
    expect(JSON.stringify(fixture)).toBe(snapshot);
    expect(res.ir).not.toBe(fixture);
  });

  test("determinism: same IR produces same result on every run", () => {
    const fixture = ir({
      instructions: [
        instruction({ id: "i-1", text: "in order to ship" }),
        instruction({ id: "i-2", text: "due to the fact that we must" }),
      ],
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "at this point in time, we make a decision",
        }),
      ],
    });
    const a = vocabSimplification.run(fixture);
    const b = vocabSimplification.run(fixture);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.applied).toBe(b.applied);
    expect(a.droppedTokens).toBe(b.droppedTokens);
  });

  test("idempotent: a second run is a no-op", () => {
    const fixture = ir({
      instructions: [
        instruction({ id: "i-1", text: "in order to ship" }),
      ],
    });
    const first = vocabSimplification.run(fixture);
    expect(first.applied).toBe(true);
    const second = vocabSimplification.run(first.ir);
    expect(second.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Local helper used by the postcondition test
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
