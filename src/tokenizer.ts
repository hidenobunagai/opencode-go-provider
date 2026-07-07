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

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2);
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  let total = 0;

  for (const message of messages) {
    for (const part of message.content) {
      const textValue = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (textValue !== undefined) {
        total += Math.ceil(textValue.length / 2);
      }
    }
  }

  return total;
}
