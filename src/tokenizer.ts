import * as vscode from "vscode";
import { getDataPartTextValue, getTextPartValue, type LegacyPart } from "./message-parts";

/** Release all cached encodings. Safe to call during extension deactivation. */
export function disposeTokenizerCache(): void {
  // no-op: lightweight fallback tokenizer has no native/WASM cache
}

export function preloadTiktoken(): void {
  // no-op: kept for backward compatibility with existing call sites
}

export function estimateTokens(text: string, modelId?: string): number {
  void modelId;
  if (!text) return 0;
  return Math.ceil(text.length / 2);
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
  modelId?: string,
): number {
  let total = 0;
  void modelId;

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
