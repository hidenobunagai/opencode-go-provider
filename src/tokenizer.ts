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

export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  try {
    const tiktoken = getTiktokenModule();
    if (!tiktoken) {
      throw new Error("@dqbd/tiktoken unavailable");
    }
    const modelName = modelId ? MODEL_TOKENIZER_MAP[modelId] : undefined;
    const encoding = tiktoken.encoding_for_model(modelName || "gpt-4o");
    const tokens = encoding.encode(text).length;
    encoding.free();
    return tokens;
  } catch {
    return Math.ceil(text.length / 2);
  }
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
  modelId?: string,
): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.content) {
      const textValue = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (textValue !== undefined) {
        total += estimateTokens(textValue, modelId);
      }
    }
  }
  return total;
}
