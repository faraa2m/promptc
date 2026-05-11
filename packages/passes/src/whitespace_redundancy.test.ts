// packages/passes/src/whitespace_redundancy.test.ts

import { describe, expect, test } from "bun:test";

import {
  whitespaceRedundancyStrip,
  __internals as ws,
} from "./whitespace_redundancy.js";
import { instruction, ir, section } from "./_test_fixtures.js";

describe("whitespace_redundancy_strip — preconditions", () => {
  test("rejects an empty IR", () => {
    const pre = whitespaceRedundancyStrip.preconditions(ir());
    expect(pre.ok).toBe(false);
  });

  test("rejects an IR whose sections all have clean whitespace", () => {
    const fixture = ir({
      sections: [
        section({ id: "s-1", kind: "task", body: "do the thing" }),
      ],
    });
    const pre = whitespaceRedundancyStrip.preconditions(fixture);
    expect(pre.ok).toBe(false);
  });

  test("rejects an IR where every section opts out via preserve_whitespace", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "  trailing space   \n\n\nmore",
          attrs: { preserve_whitespace: "true" },
        }),
      ],
    });
    const pre = whitespaceRedundancyStrip.preconditions(fixture);
    expect(pre.ok).toBe(false);
  });

  test("accepts an IR with trailing whitespace on lines", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "line one   \nline two",
        }),
      ],
    });
    const pre = whitespaceRedundancyStrip.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });

  test("accepts an IR with 3+ consecutive newlines", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha\n\n\nbravo",
        }),
      ],
    });
    const pre = whitespaceRedundancyStrip.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });
});

describe("whitespace_redundancy_strip — rewrite behaviour", () => {
  test("strips trailing whitespace on every line", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha   \nbravo\t\ncharlie",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("alpha\nbravo\ncharlie");
  });

  test("collapses 3+ consecutive newlines into 2 (single blank line)", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha\n\n\n\nbravo",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("alpha\n\nbravo");
  });

  test("strips leading and trailing whitespace from the whole body", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "\n\n  alpha bravo  \n\n",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("alpha bravo");
  });

  test("preserves whitespace inside fenced code blocks", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "context",
          body:
            "alpha   \n\n\n```\nfunction f() {\n    return 1;   \n}\n```\n\n\ndone   ",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    // Inside the fence: trailing whitespace preserved.
    expect(res.ir.sections[0]?.body).toContain("    return 1;   ");
    // Outside the fence: trailing space stripped, 3+ newlines collapsed.
    expect(res.ir.sections[0]?.body).toContain("alpha\n\n```");
    expect(res.ir.sections[0]?.body).toContain("```\n\ndone");
    expect(res.ir.sections[0]?.body.endsWith("done")).toBe(true);
  });

  test("honours preserve_whitespace=true attribute", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "trailing   \n\n\nblanks",
          attrs: { preserve_whitespace: "true" },
        }),
        section({
          id: "s-2",
          kind: "task",
          body: "trailing   ",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("trailing   \n\n\nblanks");
    expect(res.ir.sections[1]?.body).toBe("trailing");
  });

  test("rewrites instruction text the same way as section bodies", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          text: "  respond clearly   \n\n\n   ",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.instructions[0]?.text).toBe("respond clearly");
  });

  test("preserves instruction id, kind, refersToFields, slotRefs", () => {
    const fixture = ir({
      instructions: [
        instruction({
          id: "i-1",
          kind: "required",
          text: "  answer   ",
          refersToFields: ["answer"],
          slotRefs: ["sl-1"],
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    const out = res.ir.instructions[0];
    expect(out?.id).toBe("i-1");
    expect(out?.kind).toBe("required");
    expect(out?.refersToFields).toEqual(["answer"]);
    expect(out?.slotRefs).toEqual(["sl-1"]);
  });
});

describe("whitespace_redundancy_strip — postconditions", () => {
  test("output body has no leading or trailing whitespace", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "\n\n  body  \n\n",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    const body = res.ir.sections[0]?.body ?? "";
    expect(/^\s/.test(body)).toBe(false);
    expect(/\s$/.test(body)).toBe(false);
  });

  test("output body has no 3+ consecutive newlines (outside fences)", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha\n\n\n\n\nbravo",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    const body = res.ir.sections[0]?.body ?? "";
    expect(/\n{3,}/.test(body)).toBe(false);
  });

  test("output body has no trailing whitespace per line (outside fences)", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha   \nbravo\t\ncharlie  ",
        }),
      ],
    });
    const res = whitespaceRedundancyStrip.run(fixture);
    expect(res.applied).toBe(true);
    const body = res.ir.sections[0]?.body ?? "";
    for (const line of body.split("\n")) {
      expect(/[ \t]+$/.test(line)).toBe(false);
    }
  });
});

describe("whitespace_redundancy_strip — determinism + purity", () => {
  test("does not mutate the input IR", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha   \n\n\nbravo  ",
        }),
      ],
    });
    const snapshot = JSON.stringify(fixture);
    whitespaceRedundancyStrip.run(fixture);
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });

  test("determinism: same IR produces same result", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha   \n\n\nbravo  ",
        }),
      ],
      instructions: [
        instruction({ id: "i-1", text: "respond   \n\n\nclearly" }),
      ],
    });
    const a = whitespaceRedundancyStrip.run(fixture);
    const b = whitespaceRedundancyStrip.run(fixture);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.applied).toBe(b.applied);
    expect(a.droppedTokens).toBe(b.droppedTokens);
  });

  test("idempotent: a second run is a no-op", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "alpha   \n\n\nbravo  ",
        }),
      ],
    });
    const first = whitespaceRedundancyStrip.run(fixture);
    expect(first.applied).toBe(true);
    const second = whitespaceRedundancyStrip.run(first.ir);
    expect(second.applied).toBe(false);
  });
});

describe("whitespace_redundancy_strip — internal helpers", () => {
  test("hasActionableWhitespace detects each pattern", () => {
    expect(ws.hasActionableWhitespace("")).toBe(false);
    expect(ws.hasActionableWhitespace("clean")).toBe(false);
    expect(ws.hasActionableWhitespace("trailing   ")).toBe(true);
    expect(ws.hasActionableWhitespace("   leading")).toBe(true);
    expect(ws.hasActionableWhitespace("triple\n\n\nnewlines")).toBe(true);
    expect(ws.hasActionableWhitespace("a   \nb")).toBe(true);
  });

  test("segmentByFence preserves the round-trip concatenation", () => {
    const text = "alpha\n```\ncode\n```\nbravo";
    const segs = ws.segmentByFence(text);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.some((s) => s.kind === "code")).toBe(true);
  });
});
