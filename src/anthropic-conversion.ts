import * as vscode from "vscode";
import {
  extractImageData,
  getTextPartValue,
  getToolCallInfo,
  getToolResultEntries,
  type LegacyPart,
} from "./message-parts";
import { AnthropicContentBlock, AnthropicMessage, AnthropicTool, Json, JsonObject } from "./types";

export function tryParseJSONObject<T extends Json = Json>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (!text || !text.trim()) {
    return { ok: false, error: "Empty string" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateRequest(
  messages:
    | readonly vscode.LanguageModelChatMessage[]
    | readonly { role: string; content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): void {
  if (!messages || messages.length === 0) {
    throw new Error("Messages array is empty");
  }
  for (const message of messages) {
    if (!message.content || message.content.length === 0) {
      throw new Error("Message has no content");
    }
  }
}

function mergeConsecutiveAnthropicMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;

  const result: AnthropicMessage[] = [messages[0]];
  for (let index = 1; index < messages.length; index += 1) {
    const previous = result[result.length - 1];
    const current = messages[index];

    if (previous.role === current.role) {
      const previousContent =
        typeof previous.content === "string"
          ? [{ type: "text" as const, text: previous.content }]
          : previous.content;
      const currentContent =
        typeof current.content === "string"
          ? [{ type: "text" as const, text: current.content }]
          : current.content;
      previous.content = [...previousContent, ...currentContent];
      if (!previous.reasoning_content && current.reasoning_content) {
        previous.reasoning_content = current.reasoning_content;
      }
    } else {
      result.push(current);
    }
  }

  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "(start of conversation)" });
  }

  return result;
}

function parseToolUseInput(args: unknown): JsonObject {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as JsonObject;
    } catch {
      return {} as JsonObject;
    }
  }
  return (args as JsonObject) ?? ({} as JsonObject);
}

export function convertMessagesToAnthropic(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number; reasoningContentPlaceholderForToolUse?: string },
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const message of messages) {
    const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
    const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;

    const textParts: string[] = [];
    for (const part of message.content) {
      const textValue = getTextPartValue(part);
      if (textValue !== undefined) {
        textParts.push(textValue);
      }
    }

    const imageBlocks: AnthropicContentBlock[] = [];
    for (const part of message.content) {
      const image = extractImageData(part);
      if (image && image.data.length > 0) {
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          },
        });
      }
    }

    const toolCalls = message.content
      .map((part) => getToolCallInfo(part))
      .filter(
        (toolCall): toolCall is { id?: string; name?: string; args?: Record<string, unknown> } =>
          Boolean(toolCall),
      );

    const toolResults = getToolResultEntries(
      message.content as Array<vscode.LanguageModelInputPart | LegacyPart>,
    ).map((toolResult) =>
      options?.maxToolResultChars && toolResult.content.length > options.maxToolResultChars
        ? { ...toolResult, content: toolResult.content.slice(0, options.maxToolResultChars) + "…" }
        : toolResult,
    );

    if (!isUser && !isAssistant) {
      const text = textParts.join("");
      if (text) systemParts.push(text);
      continue;
    }

    const role: "user" | "assistant" = isUser ? "user" : "assistant";
    const contentBlocks: AnthropicContentBlock[] = [];
    const textContent = textParts.join("");
    if (textContent) contentBlocks.push({ type: "text", text: textContent });
    contentBlocks.push(...imageBlocks);

    if (isAssistant && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        contentBlocks.push({
          type: "tool_use",
          id: toolCall.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: toolCall.name ?? "unknown",
          input: parseToolUseInput(toolCall.args),
        });
      }
    }

    const reasoningContentPlaceholder =
      isAssistant && toolCalls.length > 0
        ? options?.reasoningContentPlaceholderForToolUse
        : undefined;

    if (isUser && toolResults.length > 0) {
      for (const toolResult of toolResults) {
        result.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolResult.callId,
              content: toolResult.content || "",
            },
          ],
        });
      }
      if (contentBlocks.length > 0) {
        result.push({ role: "user", content: contentBlocks });
      }
      continue;
    }

    if (contentBlocks.length > 0) {
      if (
        contentBlocks.length === 1 &&
        contentBlocks[0].type === "text" &&
        imageBlocks.length === 0
      ) {
        result.push({ role, content: textContent, reasoning_content: reasoningContentPlaceholder });
      } else {
        result.push({
          role,
          content: contentBlocks,
          reasoning_content: reasoningContentPlaceholder,
        });
      }
    } else {
      result.push({ role, content: "", reasoning_content: reasoningContentPlaceholder });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: mergeConsecutiveAnthropicMessages(result),
  };
}

export function convertToolsToAnthropic(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: AnthropicTool[];
  tool_choice?: "auto" | "any" | { type: "tool"; name: string };
} {
  const requiredToolMode = (
    vscode as unknown as {
      LanguageModelChatToolMode?: { Required?: number };
    }
  ).LanguageModelChatToolMode?.Required;
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    if (requiredToolMode !== undefined && options.toolMode === requiredToolMode) {
      throw new Error("LanguageModelChatToolMode.Required requires at least one tool.");
    }
    return {};
  }

  const tools: AnthropicTool[] = toolsInput.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema:
      (tool.inputSchema as JsonObject) ?? ({ type: "object", properties: {} } as JsonObject),
  }));

  let toolChoice: "auto" | "any" | { type: "tool"; name: string } = "auto";
  if (requiredToolMode !== undefined && options.toolMode === requiredToolMode) {
    if (tools.length !== 1) {
      throw new Error(
        "LanguageModelChatToolMode.Required is not supported with more than one tool.",
      );
    }
    toolChoice = { type: "tool", name: tools[0].name };
  }

  return { tools, tool_choice: toolChoice };
}
