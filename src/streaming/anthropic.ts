// streaming/anthropic.ts — Anthropic-format SSE streaming for /messages endpoint
import * as vscode from "vscode";
import { buildMissingToolCallNudge, looksLikeActionAnnouncement } from "../announcement";
import { convertMessagesToAnthropic, convertToolsToAnthropic } from "../anthropic-conversion";
import { fetchWithRetry } from "../api";
import { BASE_URL, REQUEST_TIMEOUT_MS } from "../constants";
import { buildProviderIdentityGuidance, sanitizeSystemPromptForModel } from "../guidance";
import { isProbablyCompleteJson } from "../incremental-json";
import { convertTools } from "../openai-conversion";
import { debugLog } from "../output-channel";
import { extractChatRequestContext, getToolSchemaMap, isToolCallInput } from "../tool-repair";
import { AnthropicMessage, AnthropicSSEEvent, OcGoModelInfo, type Json } from "../types";
import { readSseLines } from "./sse";
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

  // Reasoning models may consume the entire output budget on internal thinking
  // before producing any visible text/tool calls.  Allow multiple retries with
  // exponentially increasing budgets so the model has room to reason AND respond.
  // Retries are silent: visible "(Retrying...)" markers would be persisted in
  // the conversation history and confuse the model on later turns, and VS Code
  // already shows its own progress indicator while the request is in flight.
  const MAX_RETRIES = 3;
  let currentMaxTokens = requestedMaxTokens;
  let prevEmittedKeys: Set<string> | undefined;
  let retryReason:
    | "reasoning-only"
    | "mid-response-stop"
    | "truncated"
    | "missing-tool-call"
    | undefined;
  // Messages sent on the next attempt.  The missing-tool-call retry appends
  // the model's action announcement plus a nudge so the model can emit the
  // tool call it announced.
  let requestMessages = apiMessages;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();

    if (attempt > 0) {
      // Reasoning-only retry: model produced thinking but no text/tool calls.
      // Increase output tokens so the model has room to reason AND respond.
      // For DeepSeek models max_tokens is not sent to the API (budget is
      // managed internally), but we still track the budget for non-DeepSeek
      // models where doubling against the cap would be a no-op when already
      // at limit.
      currentMaxTokens = isDeepSeek
        ? currentMaxTokens * 2
        : Math.min(
            currentMaxTokens * 2,
            fallbackModels.find((m) => m.id === modelId)?.maxOutput ?? currentMaxTokens * 2,
          );
      debugLog("handleAnthropicRequest retry", { attempt, retryReason });
    }

    const requestBody: {
      model: string;
      messages: AnthropicMessage[];
      system?: string | Array<{ type: "text"; text: string }>;
      max_tokens?: number;
      stream: boolean;
      temperature?: number;
      tools?: unknown[];
      tool_choice?: unknown;
    } = {
      model: modelId,
      messages: requestMessages,
      stream: true,
    };

    if (!isDeepSeek) {
      requestBody.max_tokens = Math.max(1, currentMaxTokens);
    }

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

    // Check if retry is needed.  Use the same visibility semantics as the
    // OpenAI path: reasoning output alone (ThinkingPart) does not count as
    // visible output, otherwise the reasoning-only retry below could never
    // fire now that thinking is reported to the user.
    let shouldRetry = false;
    const hasVisibleOutput = streamState.hasVisibleOutput();
    if (
      !hasVisibleOutput &&
      streamState.reasoningContent &&
      attempt < MAX_RETRIES &&
      !token.isCancellationRequested
    ) {
      shouldRetry = true;
      retryReason = "reasoning-only";
    } else if (
      !hasVisibleOutput &&
      streamState.hasIncompleteToolCall() &&
      attempt < MAX_RETRIES &&
      !token.isCancellationRequested
    ) {
      // Model started producing tool calls but stopped mid-response
      shouldRetry = true;
      retryReason = "mid-response-stop";
    } else if (
      streamState.stopReason === "max_tokens" &&
      attempt < MAX_RETRIES &&
      !token.isCancellationRequested
    ) {
      // The model hit its output token budget mid-response.
      // Retry with larger budget for a complete response.
      shouldRetry = true;
      retryReason = "truncated";
    } else if (
      !streamState.sawToolCall &&
      (streamState.stopReason === null || streamState.stopReason === "end_turn") &&
      (toolConfig.tools?.length ?? 0) > 0 &&
      streamState.pendingText.trim().length > 0 &&
      looksLikeActionAnnouncement(streamState.pendingText) &&
      attempt < MAX_RETRIES &&
      !token.isCancellationRequested
    ) {
      // The model ended its turn by announcing an action (e.g.
      // "テストを実行します。" / "I will run the tests.") without emitting the
      // tool call, which would silently end the agentic loop before the
      // announced action ever happens.  The announcement text is still
      // buffered (never shown to the user), so silently replay it as an
      // assistant message and nudge the model to emit the tool call it
      // announced.
      shouldRetry = true;
      retryReason = "missing-tool-call";
      const announcement = streamState.pendingText.trim();
      requestMessages = [
        ...requestMessages,
        { role: "assistant", content: announcement },
        { role: "user", content: buildMissingToolCallNudge() },
      ];
    }

    if (shouldRetry) {
      streamState.closeReasoningBlockIfNeeded();
      prevEmittedKeys = streamState.snapshotEmittedKeys();
      continue;
    }

    const wasTruncated = streamState.stopReason === "max_tokens" && hasVisibleOutput;

    // Finalize on last attempt (successful or all retries exhausted)
    streamState.finalize("processAnthropicStreamingResponse");
    if (wasTruncated) {
      progress.report(
        new vscode.LanguageModelTextPart(
          "\n\n_⚠️ The response was automatically truncated. You can ask the model to continue if the response seems incomplete._",
        ),
      );
    }
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

  try {
    for await (const line of readSseLines(body)) {
      if (token.isCancellationRequested) break;

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
              // Surface thinking output to the user (ThinkingPart or the
              // blockquote fallback), matching the OpenAI streaming path.
              state.handleReasoningDelta(thinking);
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

        case "message_delta": {
          const deltaEvt = event as {
            delta?: { stop_reason?: string; stop_sequence?: string | null };
            usage?: { output_tokens?: number };
          };
          if (deltaEvt.delta?.stop_reason) {
            state.stopReason = deltaEvt.delta.stop_reason;
          }
          break;
        }
        case "message_stop":
          break;

        default:
          // Unknown event type — skip silently.  The Anthropic endpoint only
          // emits the event types handled above; anything else is either a
          // protocol extension or noise.
          break;
      }
    }

    return state;
  } catch (err) {
    if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
      throw new vscode.CancellationError();
    }
    throw err;
  }
}
