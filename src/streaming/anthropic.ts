// streaming/anthropic.ts — Anthropic-format SSE streaming for /messages endpoint
import * as vscode from "vscode";
import { convertMessagesToAnthropic, convertToolsToAnthropic } from "../anthropic-conversion";
import { fetchWithRetry } from "../api";
import { BASE_URL, REQUEST_TIMEOUT_MS } from "../constants";
import { buildProviderIdentityGuidance, sanitizeSystemPromptForModel } from "../guidance";
import { isProbablyCompleteJson } from "../incremental-json";
import { convertTools } from "../openai-conversion";
import { debugLog } from "../output-channel";
import { extractChatRequestContext, getToolSchemaMap, isToolCallInput } from "../tool-repair";
import { AnthropicMessage, AnthropicSSEEvent, OcGoModelInfo, type Json } from "../types";
import { setupStreamState, type StreamState } from "./shared";

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

  const MAX_RETRIES = 1;
  let currentMaxTokens = requestedMaxTokens;
  let prevEmittedKeys: Set<string> | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();

    if (attempt > 0) {
      // Reasoning-only retry: model produced thinking but no text/tool calls.
      // Increase output tokens so the model has room to reason AND respond.
      // For thinking models the maxOutput cap is skipped on retry because
      // the budget must cover both reasoning and visible output; doubling
      // against the cap would be a no-op when already at limit.
      currentMaxTokens = isDeepSeek
        ? currentMaxTokens * 2
        : Math.min(
            currentMaxTokens * 2,
            fallbackModels.find((m) => m.id === modelId)?.maxOutput ?? currentMaxTokens * 2,
          );
      progress.report(
        new vscode.LanguageModelTextPart(
          "\n\n(Retrying with increased output token budget...)\n\n",
        ),
      );
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
      max_tokens: Math.max(1, currentMaxTokens),
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

    if (process.env.OPENCODE_GO_DEBUG === "1" && attempt === 0) {
      debugLog("Outgoing request messages", {
        system: requestBody.system,
        messages: requestBody.messages,
        tools: requestBody.tools,
        tool_choice: requestBody.tool_choice,
      });
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([abortController.signal, timeoutController.signal]);

    const response = await fetchWithRetry(
      `${BASE_URL}/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        signal: combinedSignal,
        body: JSON.stringify(requestBody),
      },
      5,
    ).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      const rawBody = await response.text();
      let detail = "";
      try {
        const body = JSON.parse(rawBody) as {
          error?: { message?: string; type?: string };
        };
        if (body.error?.message) {
          detail = body.error.message;
        }
      } catch {
        if (rawBody.trim().length > 0) {
          detail = rawBody.trim().slice(0, 500);
        }
      }

      if (response.status === 401 || response.status === 403) {
        const guide =
          'Run "OpenCode Go: Manage OpenCode Go API Key" from the Command Palette to update your API key.';
        throw new Error(
          `OpenCode Go API authentication failed (${response.status}). Your API key may be invalid or expired.\n${guide}\n${detail}`,
        );
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryInfo = retryAfter ? `Retry after ${retryAfter}. ` : "";
        throw new Error(
          `OpenCode Go rate limit reached (429). ${retryInfo}The request will be retried automatically.\n${detail}`,
        );
      }

      throw new Error(
        `OpenCode Go Anthropic API error (${response.status} ${response.statusText})\n${detail || rawBody.trim().slice(0, 500)}`,
      );
    }

    if (!response.body) {
      throw new Error("No response body from Anthropic API");
    }

    const streamState = await processAnthropicStreamingResponse(
      response.body,
      progress,
      token,
      messages,
      options,
      prevEmittedKeys,
    );

    // Check if retry is needed: reasoning was produced but no visible output
    if (
      !streamState.hasEmittedOutput &&
      streamState.reasoningContent &&
      attempt < MAX_RETRIES &&
      !token.isCancellationRequested
    ) {
      prevEmittedKeys = streamState.snapshotEmittedKeys();
      continue;
    }

    // Finalize on last attempt (successful or all retries exhausted)
    streamState.finalize("processAnthropicStreamingResponse");
    return;
  }
}

async function processAnthropicStreamingResponse(
  body: ReadableStream<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  messages: readonly vscode.LanguageModelChatMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  prevEmittedKeys?: Set<string>,
): Promise<StreamState> {
  const toolSchemas = getToolSchemaMap(options);
  const requestContext = extractChatRequestContext(messages);
  const state = setupStreamState(progress, toolSchemas, requestContext, messages);
  if (prevEmittedKeys) {
    for (const key of prevEmittedKeys) {
      state.emittedCanonicalKeys.add(key);
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
            const cb = (event as { content_block?: { type?: string; id?: string; name?: string } })
              .content_block;
            if (cb?.type === "tool_use") {
              const idx = (event as { index: number }).index;
              const toolId = cb.id ?? `tu_${Math.random().toString(36).slice(2, 10)}`;
              const toolName = cb.name ?? "unknown_tool";
              state.nativeToolCalls.set(String(idx), {
                id: toolId,
                name: toolName,
                args: "",
              });
            }
            break;
          }

          case "content_block_delta": {
            const deltaEvt = event as {
              index: number;
              delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
            };
            if (deltaEvt.delta?.type === "text_delta") {
              const text = deltaEvt.delta.text ?? "";
              if (text) {
                state.handleTextDelta(text);
              }
            } else if (deltaEvt.delta?.type === "input_json_delta") {
              const partialJson = deltaEvt.delta.partial_json ?? "";
              const tc = state.nativeToolCalls.get(String(deltaEvt.index));
              if (tc) tc.args += partialJson;
            } else if (deltaEvt.delta?.type === "thinking_delta") {
              const thinking = deltaEvt.delta.thinking ?? "";
              if (thinking) {
                state.reasoningContent += thinking;
              }
            }
            break;
          }

          case "content_block_stop": {
            const idx = String((event as { index: number }).index);
            const tc = state.nativeToolCalls.get(idx);
            if (tc) {
              let input: unknown = {};
              if (tc.args.trim() && isProbablyCompleteJson(tc.args)) {
                try {
                  input = JSON.parse(tc.args) as Record<string, Json>;
                } catch {
                  debugLog(
                    "processAnthropicStreamingResponse",
                    "Failed to parse tool call input JSON at block_stop",
                  );
                }
              }
              if (tc.id && tc.name && isToolCallInput(input)) {
                state.tryEmitNativeToolCall(tc.id, tc.name, input);
              }
              state.nativeToolCalls.delete(idx);
            }
            break;
          }

          case "message_delta":
          case "message_stop":
            break;

          default:
            // Unknown event type — skip silently.  The Anthropic endpoint only
            // emits the event types handled above; anything else is either a
            // protocol extension or noise.
            break;
        }
      }
    }

    return state;
  } catch (err) {
    if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
      throw new vscode.CancellationError();
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}
