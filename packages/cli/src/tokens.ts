// packages/cli/src/tokens.ts
//
// CLI-internal whitespace-based token counter for the optimize summary.
//
// This is a deliberately rough proxy — the canonical token economics in
// promptc are grounded by `llm-tokens-atlas` (DESIGN.md §4 cost evidence).
// The CLI is a developer tool and the summary line is intended to give a
// quick "did this make the prompt shorter?" signal, not provider-accurate
// billing numbers.

const TOKEN_SPLIT = /\s+/;

export function tokenize(source: string): string[] {
  return source.split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

export function tokenCount(source: string): number {
  return tokenize(source).length;
}
