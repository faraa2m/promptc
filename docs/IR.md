# `PromptIR` — the typed prompt intermediate representation

`PromptIR` is `promptc`'s in-memory representation of a parsed prompt. It is
a typed tree with explicit nodes for sections, slots, examples,
instructions, and an optional output schema. Optimization passes operate on
this tree, not on raw bytes. The IR is the load-bearing distinction between
`promptc` and string-based prompt rewriters.

This document is a reader-facing summary for library consumers. The formal
contract — full TypeScript types, invariants, the round-trip property —
lives in [`DESIGN.md`](../DESIGN.md) §3.

## At a glance

```
PromptIR
  ├── irVersion: 1
  ├── sections: Section[]            // role, task, context, examples, ...
  ├── slots: Slot[]                  // {{var}} placeholders, typed
  ├── examples: Example[]            // few-shot input/output pairs
  ├── instructions: Instruction[]    // imperative directives, typed
  ├── output_schema: OutputSchema | null
  └── metadata: Metadata             // sourceFormat, sourceHash, passLog
```

The IR is **content-level**, not execution-level. One `PromptIR` represents
one prompt — not a pipeline of LM calls. This is the load-bearing
distinction from SAMMO's `Component` graph (which represents a prompt
program with multiple LM invocations).

## Five guarantees

1. **Pure data.** Every node is a plain object — no class instances, no
   bound methods. Trivially serializable to JSON.
2. **Immutable in transit.** Passes return a new `PromptIR`. They never
   mutate their input. (Internally a pass may use mutation for efficiency;
   the boundary is pure.)
3. **Stable identifiers.** Every node has an `id`. A pass that does not
   remove a node preserves its id. A pass that removes a node never
   re-uses the id.
4. **Round-trippable.** Codegen of a freshly-parsed IR (no passes applied)
   re-parses to a structurally identical IR, modulo source spans and
   trivial whitespace normalisation.
5. **Acyclic.** The IR is a tree. No cycles, no shared subtrees.

## Node types

### `Section`

A top-level division of the prompt: a Markdown `# Heading`, an XML `<role>`
element, or an inferred logical block in plain text.

```ts
interface Section {
  id: NodeId;
  kind: SectionKind;      // "role" | "task" | "context" | "examples" |
                          // "instructions" | "output_schema" |
                          // "constraints" | "tools" | "other"
  heading: string;        // raw heading text (Markdown) or tag name (XML)
  body: string;           // raw body text; passes may rewrite
  source: SourceSpan;
  slotRefs: NodeId[];
  instructionRefs: NodeId[];
  exampleRefs: NodeId[];
  attrs: Record<string, string>;
}
```

Section kind is inferred from the heading text. The parser ships a small
synonym table:

| heading | kind |
|---|---|
| `Role`, `System`, `Persona` | `role` |
| `Task`, `Goal`, `Objective` | `task` |
| `Context`, `Background` | `context` |
| `Examples`, `Example`, `Few-shot`, `Demonstrations` | `examples` |
| `Instructions`, `Instruction`, `Rules`, `Guidelines` | `instructions` |
| `Constraints`, `Constraint`, `Restrictions` | `constraints` |
| `Output`, `Output Format`, `Output Schema`, `Schema`, `Response` | `output_schema` |
| `Tools`, `Tool`, `Functions` | `tools` |
| anything else | `other` |

### `Slot`

A typed placeholder for runtime substitution. Slots are written as `{{name}}`
in markdown or `<slot name="name"/>` in XML.

```ts
interface Slot {
  id: NodeId;
  name: string;
  type: SlotType;          // "string" | "number" | "boolean" | "json" | "enum"
  enumValues: string[] | null;
  default: string | null;
  required: boolean;
  occurrences: SourceSpan[];
  appearsIn: NodeId[];     // section ids
}
```

Slots are deduplicated across the IR: two `{{user_query}}` occurrences in
different sections share one `Slot` node, but each occurrence is recorded
in `occurrences[]` for round-trip codegen.

### `Example`

A few-shot example pair.

```ts
interface Example {
  id: NodeId;
  label: string | null;        // "Example 1", etc.
  input: string;
  output: string;
  rationale: string | null;    // chain-of-thought / "Reasoning:" — optional
  slotRefs: NodeId[];
  parent: NodeId;              // section id
  source: SourceSpan;
}
```

The markdown parser scans the `Examples` section's body for the canonical
form:

```
Example 1
Input: ...
Output: ...
```

`Reasoning:` / `Rationale:` / `Thought:` lines attach to `rationale`. Code
fences inside an example body are preserved verbatim.

### `Instruction`

An imperative directive — one bullet in an `instructions` or `constraints`
section, or one inline command line in plain text.

```ts
interface Instruction {
  id: NodeId;
  kind: InstructionKind;       // "required" | "optional" | "style" | "format"
  text: string;                // canonicalised
  verbs: string[];             // e.g. ["respond", "format"]
  refersToFields: string[];    // output-schema field names the parser
                               // detected; passes use this for
                               // dead-instruction analysis
  slotRefs: NodeId[];
  parent: NodeId;              // section id
  source: SourceSpan;
}
```

Kind is inferred from the leading verb / phrase:

| leading text | kind |
|---|---|
| `must`, `always`, `never`, `do not`, `don't`, `required` | `required` |
| `may`, `optionally`, `prefer`, `consider`, `optional` | `optional` |
| mentions `format`, `output`, `json`, `yaml`, `xml`, `markdown`, `schema` | `format` |
| mentions `tone`, `voice`, `style`, `concise`, `polite`, `formal`, `casual` | `style` |
| anything else | `required` (conservative default) |

### `OutputSchema`

JSON-schema-like declared output. The parsers in v0.0.1 do not yet populate
this field (the parser keeps `output_schema = null`); it is well-defined for
library consumers building IRs programmatically.

```ts
interface OutputSchema {
  id: NodeId;
  format: "json" | "xml" | "yaml" | "free";
  root: SchemaField | null;
  source: SourceSpan;
}

interface SchemaField {
  name: string;
  type: SchemaFieldType;     // "string" | "number" | "integer" |
                             // "boolean" | "array" | "object" |
                             // "enum" | "null"
  required: boolean;
  items?: SchemaField;       // for arrays
  fields?: SchemaField[];    // for objects
  enumValues?: string[];
  description?: string;
}
```

### `Metadata`

Bookkeeping attached to the IR.

```ts
interface Metadata {
  sourceFormat: SourceFormat;     // "markdown" | "xml" | "plain"
  tags: string[];                  // free-form caller tags
  sourceHash: string;              // SHA-256 of original bytes
  rawSource: string;               // kept for round-tripping
  passLog: PassLogEntry[];         // applied / skipped passes, in order
}

interface PassLogEntry {
  pass: string;
  applied: boolean;
  skipReason: string | null;
  nodesChanged: number;
  durationMs: number;
}
```

The `passLog` lets you trace the exact sequence of passes that produced a
final IR. Useful for debugging, for reproducing a compiled prompt, and for
internal empirical evidence corpora.

## Consuming the IR

### Reading

```ts
import { parseMarkdown } from "@promptc/parser";

const source = await Bun.file("prompt.md").text();
const ir = parseMarkdown(source);

console.log(`sections: ${ir.sections.length}`);
console.log(`instructions: ${ir.instructions.length}`);
console.log(`examples: ${ir.examples.length}`);
console.log(`slots: ${ir.slots.map(s => s.name).join(", ")}`);
```

### Validating

```ts
import { validateIR } from "@promptc/ir";

const v = validateIR(ir);
if (!v.valid) {
  for (const err of v.errors) console.error(err);
  process.exit(1);
}
```

`validateIR` catches the invariants you cannot easily check by type alone:
unique node ids, parse-order monotonicity, slot-id consistency, and the
acyclicity property.

### Running a pass

```ts
import { deadInstructionElimination } from "@promptc/passes";

const pre = deadInstructionElimination.preconditions(ir);
if (!pre.ok) {
  console.warn("skipping:", pre.reasons.join("; "));
} else {
  const result = deadInstructionElimination.run(ir);
  if (result.applied) {
    ir = result.ir;
    console.log(`dropped ${result.debug?.removed} instructions`);
  }
}
```

Every pass implements the same shape:

```ts
interface Pass {
  readonly name: string;
  preconditions(ir: PromptIR): PassPreconditionResult;
  run(ir: PromptIR, opts?: PassOptions): PassResult;
}
```

### Emitting

```ts
import { codegen } from "@promptc/codegen";

const md = codegen(ir, { to: "markdown" });
const xml = codegen(ir, { to: "xml" });
const txt = codegen(ir, { to: "plain" });
```

`codegen` is a pure function of the IR. Two IRs that are bit-equal produce
bit-equal output.

### Serializing

```ts
import { serializeIR, deserializeIR } from "@promptc/ir";

const json = serializeIR(ir);     // stable JSON string
const restored = deserializeIR(json);
```

The serialization is canonical: same IR -> same JSON bytes, regardless of
the order keys were inserted. This is the property that makes IR comparison
(in tests, in CI, in the empirical evidence corpus) tractable.

## The `Pass` contract

Every pass is a value satisfying:

```ts
interface Pass {
  readonly name: string;                                        // kebab-case
  preconditions(ir: PromptIR): { ok: boolean; reasons: string[] };
  run(ir: PromptIR, opts?: PassOptions): {
    ir: PromptIR;          // new IR (or input by reference if applied=false)
    applied: boolean;
    reason: string;
    droppedTokens?: number;
    debug?: Record<string, unknown>;
  };
}
```

Three rules:

- `preconditions` must be a pure function of `ir`. No I/O, no clock.
- `run` must be a pure function of `(ir, opts)`. No clock, no RNG, no LM,
  no network.
- If `applied === false`, `run` must return the input IR by reference (no
  defensive clone). This lets the pipeline reason cheaply about no-op
  passes.

If you write a custom pass, point it at this contract directly — there is
nothing else to satisfy. The pipeline driver doesn't care which package
your pass lives in.

## Why typed IR (and not strings)?

Three forces pushed `promptc` to a typed IR rather than regex-on-strings:

1. **Determinism beyond the model.** A pass that operates on `Instruction.refersToFields`
   instead of on regex matches over raw text is robust against minor
   surface-form drift. The same IR property either holds or doesn't,
   independent of whether the author wrote `output` or `Output:` or
   `**output**`.
2. **Per-pass preconditions you can actually defend.** When the precondition
   is "the IR has an OutputSchema whose `root.fields[].name` overlap with
   `Instruction.refersToFields`," the pass can prove its safety. When the
   precondition is "the text matches /output:/i," the pass can't.
3. **Roundtrip across surface formats.** The IR is the pivot. Authoring in
   Markdown, emitting to XML for Anthropic-style chat templates, emitting
   to plain for token-bound completions — same IR, different codegen.

## Next

- [`PASSES.md`](./PASSES.md) — per-pass deep dive.
- [`QUICKSTART.md`](./QUICKSTART.md) — 5-minute tutorial.
- [`COMPARISONS.md`](./COMPARISONS.md) — placement vs SAMMO / DSPy /
  LLMLingua / ctxray.
- [`../DESIGN.md`](../DESIGN.md) §3 — the formal IR type definitions and
  invariants.
