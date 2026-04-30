import * as vscode from "vscode";
import { MODEL_TOKENIZER_MAP } from "./constants";
import { getDataPartTextValue, getTextPartValue, type LegacyPart } from "./message-parts";
import { debugLog } from "./output-channel";

type Encoding = {
  encode(text: string): { length: number } | number[] | Uint32Array;
  free(): void;
};

type TiktokenModule = {
  encoding_for_model(model: string): Encoding;
};

let cachedTiktokenModule: TiktokenModule | null | undefined;
let preloadStarted = false;

/** Cache encoding objects per model name to avoid repeated allocation/free cycles. */
const encodingCache = new Map<string, Encoding>();

function getTiktokenModule(): TiktokenModule | null {
  if (cachedTiktokenModule !== undefined) {
    return cachedTiktokenModule;
  }

  try {
    cachedTiktokenModule = require("@dqbd/tiktoken") as TiktokenModule;
  } catch (error) {
    cachedTiktokenModule = null;
    debugLog("tiktoken", error);
  }

  return cachedTiktokenModule;
}

/**
 * Return a cached (or newly created) tiktoken Encoding for the given model name.
 * The caller MUST NOT call {@link Encoding.free} on the returned object — it is
 * managed by the cache and reused across calls.
 */
function getCachedEncoding(modelName: string): Encoding | undefined {
  const cached = encodingCache.get(modelName);
  if (cached) return cached;

  const tiktoken = getTiktokenModule();
  if (!tiktoken) return undefined;

  let encoding: Encoding;
  try {
    encoding = tiktoken.encoding_for_model(modelName);
  } catch {
    return undefined;
  }

  encodingCache.set(modelName, encoding);
  return encoding;
}

/** Release all cached encodings. Safe to call during extension deactivation. */
export function disposeTokenizerCache(): void {
  for (const encoding of encodingCache.values()) {
    try {
      encoding.free();
    } catch {
      // best-effort cleanup
    }
  }
  encodingCache.clear();
}

export function preloadTiktoken(): void {
  if (preloadStarted) return;
  preloadStarted = true;
  try {
    getTiktokenModule();
  } catch {
    // Module may be unavailable; fallback tokenizer used at runtime
  }
}

export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  try {
    const modelName = modelId ? MODEL_TOKENIZER_MAP[modelId] : undefined;
    const encoding = getCachedEncoding(modelName || "gpt-4o");
    if (!encoding) {
      throw new Error("@dqbd/tiktoken unavailable");
    }
    return estimateTokensWithEncoding(text, encoding);
  } catch {
    return Math.ceil(text.length / 2);
  }
}

function estimateTokensWithEncoding(text: string, encoding: Encoding): number {
  if (!text) return 0;
  const result = encoding.encode(text);
  return Array.isArray(result) ? result.length : "length" in result ? result.length : 0;
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
  modelId?: string,
): number {
  let total = 0;
  const modelName = modelId ? MODEL_TOKENIZER_MAP[modelId] : undefined;
  const encoding = getCachedEncoding(modelName || "gpt-4o");

  if (!encoding) {
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

  for (const message of messages) {
    for (const part of message.content) {
      const textValue = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (textValue !== undefined) {
        total += estimateTokensWithEncoding(textValue, encoding);
      }
    }
  }

  return total;
}
