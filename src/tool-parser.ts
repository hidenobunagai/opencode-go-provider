// tool-parser.ts — parse text-embedded and XML-style tool calls from model output

interface ParsedTextToolCall {
  name: string;
  args: unknown;
}

interface ParsedTextSegmentText {
  type: "text";
  text: string;
}

interface ParsedTextSegmentToolCall {
  type: "toolCall";
  toolCall: ParsedTextToolCall;
}

type ParsedTextSegment = ParsedTextSegmentText | ParsedTextSegmentToolCall;

interface ParsedTextToolCallResult {
  segments: ParsedTextSegment[];
  incompleteText: string;
}

interface ParsedXmlStyleToolCallResult {
  consumed: number;
  incomplete: boolean;
  rawText?: string;
  toolCall?: ParsedTextToolCall;
}

export function findTrailingTokenPrefixStart(text: string, token: string): number {
  const maxPrefixLength = Math.min(text.length, token.length - 1);
  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (text.endsWith(token.slice(0, prefixLength))) {
      return text.length - prefixLength;
    }
  }
  return -1;
}

export function findTrailingTokenPrefixStartAny(text: string, tokens: readonly string[]): number {
  let earliestStart = -1;
  for (const token of tokens) {
    const start = findTrailingTokenPrefixStart(text, token);
    if (start !== -1 && (earliestStart === -1 || start < earliestStart)) {
      earliestStart = start;
    }
  }
  return earliestStart;
}

function parseEmbeddedToolParameterValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if (
    /^[\[{\"]/.test(trimmed) ||
    /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return trimmed;
}

export function parseXmlStyleToolCall(text: string): ParsedXmlStyleToolCallResult {
  const toolCallsStartToken = "<tool_calls>";
  const toolCallStartToken = "<tool_call ";
  const toolCallEndToken = "</tool_call>";
  const toolCallsEndPattern = /^\s*<\/tool_calls>/;

  let cursor = 0;
  let wrapped = false;

  if (text.startsWith(toolCallsStartToken)) {
    wrapped = true;
    cursor = toolCallsStartToken.length;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  if (!text.startsWith(toolCallStartToken, cursor)) {
    return { consumed: 0, incomplete: true };
  }

  const openTagEnd = text.indexOf(">", cursor);
  if (openTagEnd === -1) {
    return { consumed: 0, incomplete: true };
  }

  const openTag = text.slice(cursor, openTagEnd + 1);
  const closeTagIndex = text.indexOf(toolCallEndToken, openTagEnd + 1);
  if (closeTagIndex === -1) {
    return { consumed: 0, incomplete: true };
  }

  let consumed = closeTagIndex + toolCallEndToken.length;
  if (wrapped) {
    const wrapperCloseMatch = text.slice(consumed).match(toolCallsEndPattern);
    if (!wrapperCloseMatch) {
      return { consumed: 0, incomplete: true };
    }
    consumed += wrapperCloseMatch[0].length;
  }

  const toolName = openTag.match(/\bname\s*=\s*"([^"]+)"/)?.[1]?.trim();
  if (!toolName) {
    return { consumed, incomplete: false, rawText: text.slice(0, consumed) };
  }

  const innerContent = text.slice(openTagEnd + 1, closeTagIndex);
  const args: Record<string, unknown> = {};
  const parameterPattern = /<tool_parameter\s+name="([^"]+)">([\s\S]*?)<\/tool_parameter>/g;
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterPattern.exec(innerContent)) !== null) {
    const parameterName = parameterMatch[1]?.trim();
    if (!parameterName) continue;
    args[parameterName] = parseEmbeddedToolParameterValue(parameterMatch[2] ?? "");
  }

  return { consumed, incomplete: false, toolCall: { name: toolName, args } };
}

export function parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
  const beginToken = "<|tool_call_begin|>";
  const argBeginToken = "<|tool_call_argument_begin|>";
  const endToken = "<|tool_call_end|>";
  const xmlStartTokens = ["<tool_calls>", "<tool_call "] as const;

  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const appendText = (value: string): void => {
    if (!value) return;
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text") {
      lastSegment.text += value;
      return;
    }
    segments.push({ type: "text", text: value });
  };

  while (remaining.length > 0) {
    const candidateStarts = [
      { kind: "legacy" as const, index: remaining.indexOf(beginToken) },
      ...xmlStartTokens.map((token) => ({ kind: "xml" as const, index: remaining.indexOf(token) })),
    ].filter((candidate) => candidate.index !== -1);

    const nextStart = candidateStarts.reduce<{ kind: "legacy" | "xml"; index: number } | undefined>(
      (earliest, candidate) => {
        if (!earliest || candidate.index < earliest.index) return candidate;
        return earliest;
      },
      undefined,
    );

    if (!nextStart) {
      const partialStart = findTrailingTokenPrefixStartAny(remaining, [
        beginToken,
        ...xmlStartTokens,
      ]);
      if (partialStart === -1) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialStart));
        incompleteText = remaining.slice(partialStart);
      }
      break;
    }

    appendText(remaining.slice(0, nextStart.index));
    remaining = remaining.slice(nextStart.index);

    if (nextStart.kind === "xml") {
      const xmlToolCall = parseXmlStyleToolCall(remaining);
      if (xmlToolCall.incomplete) {
        incompleteText = remaining;
        break;
      }
      remaining = remaining.slice(xmlToolCall.consumed);
      if (xmlToolCall.rawText) {
        appendText(xmlToolCall.rawText);
      } else if (xmlToolCall.toolCall) {
        segments.push({ type: "toolCall", toolCall: xmlToolCall.toolCall });
      }
      continue;
    }

    remaining = remaining.slice(beginToken.length);
    const argBeginIndex = remaining.indexOf(argBeginToken);
    const endIndex = remaining.indexOf(endToken);
    if (argBeginIndex === -1 || endIndex === -1 || argBeginIndex > endIndex) {
      incompleteText = beginToken + remaining;
      break;
    }

    const name = remaining.slice(0, argBeginIndex).trim();
    const argsText = remaining.slice(argBeginIndex + argBeginToken.length, endIndex).trim();
    remaining = remaining.slice(endIndex + endToken.length);

    if (!name) continue;

    try {
      segments.push({
        type: "toolCall",
        toolCall: { name, args: argsText ? JSON.parse(argsText) : {} },
      });
    } catch {
      appendText(`${beginToken}${name}${argBeginToken}${argsText}${endToken}`);
    }
  }

  return { segments, incompleteText };
}

export type { ParsedTextToolCall, ParsedTextSegment, ParsedTextToolCallResult };
