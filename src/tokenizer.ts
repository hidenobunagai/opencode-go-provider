import * as vscode from "vscode";
import { getDataPartTextValue, getTextPartValue, type LegacyPart } from "./message-parts";

/**
 * Release all cached encodings. Safe to call during extension deactivation.
 *
 * No-op: this project uses a lightweight character-length-based token
 * estimator (approximately 2 chars per token) instead of tiktoken/WASM.
 *
 * @see disposeTokenizerCache in extension.ts deactivate()
 */
export function disposeTokenizerCache(): void {
  // no-op: lightweight fallback tokenizer has no native/WASM cache
}

/**
 * Preload the tokenizer. Safe to call early during extension activation.
 *
 * No-op: this project uses a lightweight character-length-based token
 * estimator (approximately 2 chars per token) instead of tiktoken/WASM.
 * The function signature is preserved for backward compatibility with
 * existing call sites.
 *
 * @see preloadTiktoken in extension.ts activate()
 */
export function preloadTiktoken(): void {
  // no-op: kept for backward compatibility with existing call sites
}

/**
 * CJK and full-width characters.  Modern tokenizers typically encode these at
 * roughly one token per character (or more), so they must not be estimated at
 * the Latin-text rate of ~2 chars per token — doing so undercounts
 * Japanese/Chinese/Korean input by about half and can let over-limit requests
 * slip through to the API.
 */
const CJK_CHAR_PATTERN =
  /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * Estimate tokens for a piece of text.
 * - CJK / full-width characters count as ~1 token each.
 * - All other characters count as ~1/2 token each (the historical behavior of
 *   this estimator for Latin-heavy text).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    if (CJK_CHAR_PATTERN.test(ch)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return cjkCount + Math.ceil(otherCount / 2);
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  let total = 0;

  for (const message of messages) {
    for (const part of message.content) {
      const textValue = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (textValue !== undefined) {
        total += estimateTokens(textValue);
      }
    }
  }

  return total;
}
