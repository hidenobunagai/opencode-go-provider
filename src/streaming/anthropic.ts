// streaming/anthropic.ts — Anthropic-format SSE streaming for /messages endpoint
import * as vscode from "vscode";
import { debugLog } from "../output-channel";
import { BASE_URL } from "../constants";
import {
  buildProviderIdentityGuidance,
  sanitizeSystemPromptForModel,
} from "../guidance";
import { AnthropicMessage, AnthropicSSEEvent, OcGoModelInfo, type Json } from "../types";
import { convertMessagesToAnthropic, convertTools, convertToolsToAnthropic } from "../utils";
import { parseTextEmbeddedToolCalls, type ParsedTextToolCall } from "../tool-parser";
import {
  buildToolCallCanonicalKey,
  buildInvalidToolCallFallback,
  extractChatRequestContext,
  getCompletedToolCallKeys,
  getToolSchemaMap,
  hasRequiredToolArguments,
  isToolCallInput,
  repairToolArguments,
} from "../tool-repair";

export interface AnthropicRequestParams {
  modelId: string;
  messages: readonly vscode.LanguageModelChatMessage[];
  options: vscode.ProvideLanguageModelChatResponseOptions;
  apiKey: string;
  requestedMaxTokens: number;
  temperatureVal: number;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abortController: AbortController;
  fallbackModels: readonly OcGoModelInfo[];
  userAgent: string;
}

interface SkippedToolCall {
  name: string;
  required: string[];
}

export async function handleAnthropicRequest(params: AnthropicRequestParams): Promise<void> {
  const {
    modelId,
    messages,
    options,
    apiKey,
    requestedMaxTokens,
    temperatureVal,
    progress,
    token,
    abortController,
    fallbackModels,
    userAgent,
  } = params;

  const isDeepSeek = modelId.startsWith("deepseek-");
  let toolConfig: { tools?: unknown[]; tool_choice?: unknown };
  if (isDeepSeek) {
    const openAiConfig = convertTools(options);
    toolConfig = {
      tools: openAiConfig.tools,
      tool_choice: openAiConfig.tool_choice,
    };
  } else {
    const anthropicConfig = convertToolsToAnthropic(options);
    toolConfig = {
      tools: anthropicConfig.tools,
      tool_choice: anthropicConfig.tool_choice,
    };
  }

  const { messages: apiMessages, system } = convertMessagesToAnthropic(messages, {
    maxToolResultChars: 20000,
    reasoningContentPlaceholderForToolUse: isDeepSeek ? " " : undefined,
  });
  const effectiveSystem = [
    sanitizeSystemPromptForModel(system, modelId),
    buildProviderIdentityGuidance(modelId, fallbackModels),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  if (apiMessages.length === 0) {
    throw new Error("No messages to send to Anthropic API");
  }

  const requestBody: {
    model: string;
    messages: AnthropicMessage[];
    system?: string | Array<{ type: "text"; text: string }>;
    max_tokens: number;
    stream: boolean;
    temperature?: number;
    tools?: unknown[];
    tool_choice?: unknown;
  } = {
    model: modelId,
    messages: apiMessages,
    max_tokens: Math.max(1, requestedMaxTokens),
    stream: true,
  };

  if (effectiveSystem) requestBody.system = effectiveSystem;
  if (typeof temperatureVal === "number" && temperatureVal > 0) {
    requestBody.temperature = temperatureVal;
  }
  if (toolConfig.tools && toolConfig.tools.length > 0) {
    requestBody.tools = toolConfig.tools;
    if (toolConfig.tool_choice && toolConfig.tool_choice !== "auto") {
      requestBody.tool_choice = toolConfig.tool_choice;
    }
  }

  debugLog("Outgoing request messages", {
    system: requestBody.system,
    messages: requestBody.messages,
    tools: requestBody.tools,
    tool_choice: requestBody.tool_choice,
  });

  const response = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    signal: abortController.signal,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenCode Go Anthropic API error: ${response.status} ${response.statusText}\n${errorText}`,
    );
  }

  if (!response.body) {
    throw new Error("No response body from Anthropic API");
  }

  await processAnthropicStreamingResponse(response.body, progress, token, messages, options);
}

async function processAnthropicStreamingResponse(
  body: ReadableStream<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  messages: readonly vscode.LanguageModelChatMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const activeToolCalls = new Map<number, { id: string; name: string; inputJson: string }>();
  const toolSchemas = getToolSchemaMap(options);
  const requestContext = extractChatRequestContext(messages);
  const skippedToolCalls: SkippedToolCall[] = [];
  const emittedTextToolCallKeys = getCompletedToolCallKeys(messages, requestContext, toolSchemas);
  let pendingTextEmbeddedContent = "";
  let pendingText = "";
  let sawToolCall = false;
  let emittedToolCall = false;

  const flushPendingText = (): void => {
    if (!pendingText) return;
    progress.report(new vscode.LanguageModelTextPart(pendingText));
    pendingText = "";
  };

  const emitEmbeddedToolCall = (toolCall: ParsedTextToolCall, toolId?: string): void => {
    sawToolCall = true;
    const schema = toolSchemas.get(toolCall.name);
    const repairedArgs = repairToolArguments(toolCall.name, toolCall.args, requestContext, schema);
    const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
    if (emittedTextToolCallKeys.has(canonicalKey)) return;

    if (hasRequiredToolArguments(repairedArgs, schema) && isToolCallInput(repairedArgs)) {
      flushPendingText();
      progress.report(
        new vscode.LanguageModelToolCallPart(
          toolId ?? `text_tool_${Math.random().toString(36).slice(2, 10)}`,
          toolCall.name,
          repairedArgs,
        ),
      );
      emittedToolCall = true;
      emittedTextToolCallKeys.add(canonicalKey);
      return;
    }

    skippedToolCalls.push({
      name: toolCall.name,
      required: schema?.required ?? [],
    });
    debugLog("Skipped invalid Anthropic embedded tool call", toolCall);
  };

  const handleTextDelta = (text: string): void => {
    const { segments, incompleteText } = parseTextEmbeddedToolCalls(
      pendingTextEmbeddedContent + text,
    );
    pendingTextEmbeddedContent = incompleteText;

    for (const segment of segments) {
      if (segment.type === "text") {
        pendingText += segment.text;
        continue;
      }
      emitEmbeddedToolCall(segment.toolCall);
    }
  };

  try {
    while (!token.isCancellationRequested) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "{}" || trimmed.startsWith("event:")) continue;

        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "{}" || jsonStr === "[DONE]") continue;
        if (!jsonStr.startsWith("{")) continue;

        let event: AnthropicSSEEvent;
        try {
          event = JSON.parse(jsonStr) as AnthropicSSEEvent;
        } catch {
          debugLog(
            "processAnthropicStreamingResponse",
            `Failed to parse event JSON: ${jsonStr.slice(0, 200)}`,
          );
          continue;
        }

        switch (event.type) {
          case "message_start":
            break;

          case "content_block_start": {
            const cb = (
              event as { content_block?: { type?: string; id?: string; name?: string } }
            ).content_block;
            if (cb?.type === "tool_use") {
              sawToolCall = true;
              const idx = (event as { index: number }).index;
              const toolId = cb.id ?? `tu_${Math.random().toString(36).slice(2, 10)}`;
              const toolName = cb.name ?? "unknown_tool";
              activeToolCalls.set(idx, { id: toolId, name: toolName, inputJson: "" });
            }
            break;
          }

          case "content_block_delta": {
            const deltaEvt = event as {
              index: number;
              delta?: { type?: string; text?: string; partial_json?: string };
            };
            if (deltaEvt.delta?.type === "text_delta") {
              const text = deltaEvt.delta.text ?? "";
              if (text) {
                handleTextDelta(text);
              }
            } else if (deltaEvt.delta?.type === "input_json_delta") {
              const partialJson = deltaEvt.delta.partial_json ?? "";
              const tc = activeToolCalls.get(deltaEvt.index);
              if (tc) tc.inputJson += partialJson;
            }
            break;
          }

          case "content_block_stop": {
            const idx = (event as { index: number }).index;
            const tc = activeToolCalls.get(idx);
            if (tc) {
              let input: Record<string, Json> | unknown = {};
              if (tc.inputJson.trim()) {
                try {
                  input = JSON.parse(tc.inputJson) as Record<string, Json>;
                } catch {
                  debugLog("processAnthropicStreamingResponse", "Failed to parse tool call input JSON at block_stop");
                }
              }
              emitEmbeddedToolCall({ name: tc.name, args: input }, tc.id);
              activeToolCalls.delete(idx);
            }
            break;
          }

          case "message_delta":
          case "message_stop":
            break;

          default: {
            const openAiEvt = event as unknown as {
              object?: string;
              choices?: Array<{
                delta?: {
                  role?: string;
                  content?: string | null;
                  tool_calls?: Array<{
                    id?: string;
                    function?: { name?: string; arguments?: string };
                    index?: number;
                  }> | null;
                };
                finish_reason?: string | null;
              }>;
            };
            if (openAiEvt.object === "chat.completion.chunk" && openAiEvt.choices) {
              for (const choice of openAiEvt.choices) {
                const delta = choice.delta;
                if (delta?.content) {
                  handleTextDelta(delta.content);
                }
                if (delta?.tool_calls) {
                  sawToolCall = true;
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const existing = activeToolCalls.get(idx);
                    if (tc.id && tc.function?.name) {
                      activeToolCalls.set(idx, {
                        id: tc.id,
                        name: tc.function.name,
                        inputJson: tc.function.arguments ?? "",
                      });
                    } else if (existing && tc.function?.arguments) {
                      existing.inputJson += tc.function.arguments;
                    }
                  }
                }
                if (choice.finish_reason === "tool_calls") {
                  for (const [, tc] of activeToolCalls) {
                    let input: Record<string, Json> | unknown = {};
                    if (tc.inputJson.trim()) {
                      try {
                        input = JSON.parse(tc.inputJson) as Record<string, Json>;
                      } catch {
                        debugLog("processAnthropicStreamingResponse", "Failed to parse DeepSeek tool call input");
                      }
                    }
                    emitEmbeddedToolCall({ name: tc.name, args: input }, tc.id);
                  }
                  activeToolCalls.clear();
                }
              }
            }
            break;
          }
        }
      }
    }

    if (pendingTextEmbeddedContent) {
      pendingText += pendingTextEmbeddedContent;
    }

    if (pendingText && (!sawToolCall || emittedToolCall || pendingText.trim().length > 0)) {
      flushPendingText();
    }

    if (sawToolCall && !emittedToolCall) {
      const fallbackText = buildInvalidToolCallFallback(skippedToolCalls);
      if (fallbackText) {
        progress.report(new vscode.LanguageModelTextPart(fallbackText));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
