// incremental-json.ts — lightweight structural checks for streaming JSON assembly
//
// During streaming tool-call assembly, argument fragments arrive as string
// deltas.  Calling JSON.parse on every delta is wasteful because the string
// is almost always incomplete.  Instead we check for *structural completeness*
// first: balanced braces, no unterminated strings, etc.
//
// This module is intentionally minimalist — it does NOT implement a full JSON
// validator.  False positives are acceptable (JSON.parse is still the final
// arbiter); the goal is to avoid JSON.parse on fragments that are almost
// certainly incomplete.

/**
 * Return true when `json` looks *structurally* complete enough that a
 * {@link JSON.parse} attempt is worthwhile.
 *
 * Checks performed:
 * 1. Leading `{` or `[` — rejects strings that don't look like JSON.
 * 2. Balanced braces / brackets.
 * 3. No unterminated string (odd number of unescaped quotes inside a string).
 *
 * Deliberately NOT checked (handled by JSON.parse itself):
 * - Valid key/value structure
 * - Number/boolean/null literal syntax
 * - Trailing commas
 * - Unicode escape validity
 */
export function isProbablyCompleteJson(json: string): boolean {
  const trimmed = json.trim();
  if (!trimmed) return false;

  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;

  let inString = false;
  let depth = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
      case "[":
        depth++;
        break;
      case "}":
      case "]":
        depth--;
        if (depth < 0) return false; // unbalanced
        break;
    }
  }

  // Must be balanced AND not inside a string
  return depth === 0 && !inString;
}
