// packages/parser/src/util.ts
//
// Internal-only helpers shared by every format-specific parser:
//
//   - `hashSource`        — SHA-256 of the source bytes, used for the
//                           `metadata.sourceHash` field of every IR.
//   - `IdAllocator`       — deterministic, parser-scoped node-id generator.
//                           Ids are content-bearing: `${kind}-${index}` where
//                           index is monotone over parse order, so the same
//                           bytes always produce the same ids.
//   - `LineMap`           — byte-offset -> { line, column } resolver. Built
//                           once per parse so each `SourceSpan` lookup is
//                           O(log n).
//   - `makeSpan`          — wraps `LineMap.locate` for the common case of
//                           computing the span over a [start, end) byte range.

import { createHash } from "node:crypto";

import type { NodeId, SourceSpan } from "@promptc/ir";

/** Compute the lowercase-hex SHA-256 of a UTF-8 string. Deterministic. */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Stateful, parse-scoped id generator. Ids are deterministic for a given
 * sequence of `next(kind)` calls; the same parser invocation on the same
 * bytes therefore produces the same ids on every run.
 *
 * The generated form is `${kind}-${counter}` with a per-kind zero-padded
 * 6-character hex counter, e.g. `section-000001`, `slot-00000a`.
 */
export class IdAllocator {
  private readonly counters = new Map<string, number>();

  next(kind: string): NodeId {
    const current = this.counters.get(kind) ?? 0;
    const nextValue = current + 1;
    this.counters.set(kind, nextValue);
    return `${kind}-${nextValue.toString(16).padStart(6, "0")}`;
  }
}

/**
 * Byte-offset -> 1-indexed (line, column) resolver. Built in O(n) at parse
 * time; each `locate(offset)` query runs in O(log n) via binary search of
 * line-start offsets.
 */
export class LineMap {
  private readonly lineStarts: number[];

  constructor(source: string) {
    const starts: number[] = [0];
    for (let i = 0; i < source.length; i += 1) {
      if (source.charCodeAt(i) === 0x0a /* \n */) {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  /** Resolve a byte offset to a 1-indexed (line, column). */
  locate(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, Number.MAX_SAFE_INTEGER));
    // Binary search for the largest lineStart <= clamped.
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const candidate = this.lineStarts[mid];
      if (candidate === undefined) {
        // Defensive: shouldn't happen because hi is in range.
        break;
      }
      if (candidate <= clamped) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const start = this.lineStarts[lo] ?? 0;
    return { line: lo + 1, column: clamped - start + 1 };
  }
}

/**
 * Build a `SourceSpan` for a half-open byte interval. `end` should be the
 * exclusive end offset; the line/column fields refer to the *start*
 * position, matching the convention in DESIGN.md §3.1.
 */
export function makeSpan(start: number, end: number, map: LineMap): SourceSpan {
  const { line, column } = map.locate(start);
  return { start, end, line, column };
}
