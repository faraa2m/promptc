// packages/passes/src/format_collapse.test.ts

import { describe, expect, test } from "bun:test";

import {
  formatCollapse,
  __internals as fc,
} from "./format_collapse.js";
import {
  ir,
  metadata,
  outputSchema,
  schemaField,
  section,
  slot,
} from "./_test_fixtures.js";

describe("format_collapse — preconditions", () => {
  test("rejects an empty IR", () => {
    const pre = formatCollapse.preconditions(ir());
    expect(pre.ok).toBe(false);
    expect(pre.reasons.length).toBeGreaterThan(0);
  });

  test("rejects an IR with only prose sections (no candidate format swap)", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "task",
          body: "do the task to the best of your ability.",
        }),
      ],
    });
    const pre = formatCollapse.preconditions(fixture);
    expect(pre.ok).toBe(false);
  });

  test("accepts an IR with a bulleted instructions section", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: ["- keep responses short", "- cite sources"].join("\n"),
        }),
      ],
    });
    const pre = formatCollapse.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });

  test("accepts an IR with a yaml flat-scalar output schema", () => {
    const fixture = ir({
      output_schema: outputSchema({
        id: "os-1",
        format: "yaml",
        root: schemaField({
          name: "answer",
          type: "object",
          fields: [
            schemaField({ name: "label", type: "string" }),
            schemaField({ name: "confidence", type: "number" }),
          ],
        }),
      }),
    });
    const pre = formatCollapse.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });

  test("accepts an IR with an inline xml-element section", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "context",
          body: "<role>analyst</role>",
        }),
      ],
    });
    const pre = formatCollapse.preconditions(fixture);
    expect(pre.ok).toBe(true);
  });
});

describe("format_collapse — R1 bullet collapse", () => {
  test("collapses three single-line bullets to a comma-separated line", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: [
            "- keep responses short",
            "- cite sources",
            "- avoid speculation",
          ].join("\n"),
        }),
      ],
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe(
      "keep responses short, cite sources, avoid speculation",
    );
  });

  test("refuses to collapse if any bullet item contains a comma", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: [
            "- one item, with a comma",
            "- another item without comma",
          ].join("\n"),
        }),
      ],
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(false);
  });

  test("does not collapse bullets in a non-instruction section", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "context",
          body: ["- alpha", "- beta", "- gamma"].join("\n"),
        }),
      ],
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(false);
  });
});

describe("format_collapse — R2 xml element collapse", () => {
  test("collapses <tag>text</tag> lines to 'tag: text' when target is markdown", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "context",
          body: ["<role>analyst</role>", "<style>concise</style>"].join("\n"),
        }),
      ],
      metadata: metadata({ sourceFormat: "markdown" }),
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.sections[0]?.body).toBe("role: analyst\nstyle: concise");
  });

  test("does not collapse when sourceFormat is xml", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "context",
          body: "<role>analyst</role>",
        }),
      ],
      metadata: metadata({ sourceFormat: "xml" }),
    });
    const res = formatCollapse.run(fixture);
    // The pass should detect the candidate but not collapse.
    expect(res.applied).toBe(false);
  });
});

describe("format_collapse — R3 yaml output schema collapse", () => {
  test("converts flat-scalar yaml schema to plain key=type form", () => {
    const fixture = ir({
      output_schema: outputSchema({
        id: "os-1",
        format: "yaml",
        root: schemaField({
          name: "answer",
          type: "object",
          fields: [
            schemaField({ name: "label", type: "string" }),
            schemaField({ name: "confidence", type: "number" }),
            schemaField({ name: "needs_review", type: "boolean" }),
          ],
        }),
      }),
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(true);
    expect(res.ir.output_schema?.id).toBe("os-1");
    expect(res.ir.output_schema?.format).toBe("free");
  });

  test("does not touch nested-object yaml schemas", () => {
    const fixture = ir({
      output_schema: outputSchema({
        id: "os-1",
        format: "yaml",
        root: schemaField({
          name: "answer",
          type: "object",
          fields: [
            schemaField({
              name: "nested",
              type: "object",
              fields: [schemaField({ name: "v", type: "string" })],
            }),
          ],
        }),
      }),
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(false);
  });

  test("does not touch yaml schemas with array fields", () => {
    const fixture = ir({
      output_schema: outputSchema({
        id: "os-1",
        format: "yaml",
        root: schemaField({
          name: "answer",
          type: "object",
          fields: [
            schemaField({
              name: "tags",
              type: "array",
              items: schemaField({ name: "tag", type: "string" }),
            }),
          ],
        }),
      }),
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(false);
  });
});

describe("format_collapse — slot guard", () => {
  test("skips rewriting a section that mentions a json-typed slot", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: [
            "- pass through the {{payload}} verbatim",
            "- keep the output structured",
          ].join("\n"),
        }),
      ],
      slots: [slot({ id: "sl-1", name: "payload", type: "json" })],
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(false);
  });

  test("rewrites a section that mentions only string-typed slots", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: [
            "- refer to {{topic}} once",
            "- keep responses short",
            "- cite sources",
          ].join("\n"),
        }),
      ],
      slots: [slot({ id: "sl-1", name: "topic", type: "string" })],
    });
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(true);
  });
});

describe("format_collapse — postconditions and determinism", () => {
  test("equivalentUnderFormat is true for the before/after of a bullet collapse", () => {
    const before = ["- alpha bravo", "- charlie delta"].join("\n");
    const after = "alpha bravo, charlie delta";
    expect(fc.equivalentUnderFormat(before, after)).toBe(true);
  });

  test("equivalentUnderFormat is false when items differ", () => {
    const before = ["- alpha", "- bravo"].join("\n");
    const after = "alpha, charlie";
    expect(fc.equivalentUnderFormat(before, after)).toBe(false);
  });

  test("tokenCount is strictly smaller post-collapse for the bullet case", () => {
    const before = ["- alpha", "- bravo", "- charlie"].join("\n");
    const after = "alpha, bravo, charlie";
    expect(fc.tokenCount(after)).toBeLessThan(fc.tokenCount(before));
  });

  test("does not mutate input IR on a successful rewrite", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: ["- alpha", "- bravo"].join("\n"),
        }),
      ],
    });
    const snapshot = JSON.stringify(fixture);
    const res = formatCollapse.run(fixture);
    expect(res.applied).toBe(true);
    expect(JSON.stringify(fixture)).toBe(snapshot);
    expect(res.ir).not.toBe(fixture);
  });

  test("determinism: same IR produces same result on every run", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: ["- one", "- two", "- three"].join("\n"),
        }),
        section({
          id: "s-2",
          kind: "context",
          body: "<env>prod</env>",
        }),
      ],
      output_schema: outputSchema({
        id: "os-1",
        format: "yaml",
        root: schemaField({
          name: "answer",
          type: "object",
          fields: [schemaField({ name: "label", type: "string" })],
        }),
      }),
    });
    const a = formatCollapse.run(fixture);
    const b = formatCollapse.run(fixture);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.applied).toBe(b.applied);
    expect(a.reason).toBe(b.reason);
  });

  test("idempotent: a second run is a no-op", () => {
    const fixture = ir({
      sections: [
        section({
          id: "s-1",
          kind: "instructions",
          body: ["- alpha", "- bravo", "- charlie"].join("\n"),
        }),
      ],
    });
    const first = formatCollapse.run(fixture);
    expect(first.applied).toBe(true);
    const second = formatCollapse.run(first.ir);
    expect(second.applied).toBe(false);
  });
});
