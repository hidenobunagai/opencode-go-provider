import * as vscode from "vscode";
import {
  extractImageData,
  getDataPartTextValue,
  getTextPartValue,
  getToolCallInfo,
  getToolResultEntries,
  type LegacyPart,
} from "./message-parts";

export const IMAGE_BASELINE_TOKENS = 1000;
export const TOOL_CALL_BASE_TOKENS = 8;

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
  if (!text || text.trim().length === 0) return 0;
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

export function estimatePartTokens(part: vscode.LanguageModelInputPart | LegacyPart): number {
  const textValue = getTextPartValue(part);
  if (textValue !== undefined) {
    return estimateTokens(textValue);
  }

  const dataTextValue = getDataPartTextValue(part);
  if (dataTextValue !== undefined) {
    return estimateTokens(dataTextValue);
  }

  const toolCall = getToolCallInfo(part);
  if (toolCall !== undefined) {
    const nameTokens = toolCall.name ? estimateTokens(toolCall.name) : 0;
    let argsText = "";
    if (toolCall.args !== undefined) {
      try {
        argsText = JSON.stringify(toolCall.args);
      } catch {
        argsText = String(toolCall.args);
      }
    } else {
      argsText = "{}";
    }
    const argsTokens = estimateTokens(argsText);
    return TOOL_CALL_BASE_TOKENS + nameTokens + argsTokens;
  }

  const toolResults = getToolResultEntries([part]);
  if (toolResults.length > 0) {
    return toolResults.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
  }

  const image = extractImageData(part);
  if (image !== undefined) {
    return IMAGE_BASELINE_TOKENS;
  }

  return 0;
}

export function estimateMessageTokens(message: {
  content: readonly (vscode.LanguageModelInputPart | LegacyPart)[];
}): number {
  if (!message || !Array.isArray(message.content)) {
    return 0;
  }
  let total = 0;
  for (const part of message.content) {
    total += estimatePartTokens(part);
  }
  return total;
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
