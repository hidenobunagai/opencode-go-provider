// streaming/openai.ts — OpenAI-format SSE streaming + tool call assembly
import * as vscode from "vscode";
import { streamChatCompletion } from "../api";
import { REASONING_CONTENT_WORKAROUND_MODELS } from "../constants";
import { applyOpenAiSystemPromptGuidance, calculateMaxToolResultChars } from "../guidance";
import { isProbablyCompleteJson } from "../incremental-json";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
} from "../openai-conversion";
import { captureLog, debugLog } from "../output-channel";
import { extractChatRequestContext, getToolSchemaMap, isToolCallInput } from "../tool-repair";
import type { OcGoModelInfo } from "../types";
import { OcGoChatRequest } from "../types";
import { setupStreamState } from "./shared";

export interface OpenAIModelInfo {
  id: string;
  modelInfo?: OcGoModelInfo;
  maxOutputTokens: number;
  reasoningEffort?: string;
}

function normalizeReasoningEffort(reasoningEffort: string | undefined): string | undefined {
  if (reasoningEffort === "max") {
    return "xhigh";
  }
  return reasoningEffort;
}

function getRetryReasoningEffort(
  reasoningEffort: string | undefined,
  attempt: number,
): string | undefined {
  if (!reasoningEffort || attempt <= 0) {
    return reasoningEffort;
  }

  const fallbackOrder = ["xhigh", "high", "medium", "low"] as const;
  const index = fallbackOrder.indexOf(reasoningEffort as (typeof fallbackOrder)[number]);
  if (index === -1) {
    return reasoningEffort;
  }

  return fallbackOrder[Math.min(index + attempt, fallbackOrder.length - 1)];
}

export async function processOpenAIStream(
  model: OpenAIModelInfo,
  apiMessages: readonly vscode.LanguageModelChatMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  apiKey: string,
  requestedMaxTokens: number,
  temperatureVal: number,
  openCodeGoModelInfo: readonly OcGoModelInfo[],
  userAgent: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  abortController: AbortController,
): Promise<void> {
  const toolSchemas = getToolSchemaMap(options);
  const requestContext = extractChatRequestContext(
    apiMessages as readonly vscode.LanguageModelChatMessage[],
  );

  const maxToolResultChars = calculateMaxToolResultChars(model.id, openCodeGoModelInfo);

  let convertedMessages = convertMessages(apiMessages, { maxToolResultChars });
  convertedMessages = applyReasoningContentWorkaround(convertedMessages, model.id);
  convertedMessages = applyOpenAiSystemPromptGuidance(
    convertedMessages,
    model.id,
    options,
    openCodeGoModelInfo,
  );

  const toolConfig = convertTools(options);
  const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
  const isThinkingModel = REASONING_CONTENT_WORKAROUND_MODELS.has(model.id);

  // Reasoning models may consume the entire output budget on internal thinking
  // before producing any visible text/tool calls.  Allow multiple retries with
  // exponentially increasing budgets so the model has room to reason AND respond.
  // The API manages the budget internally for thinking models (no max_tokens is
  // sent), but retries still help when the model produces only reasoning content.
  const MAX_RETRIES = 3;
  let currentMaxTokens = requestedMaxTokens;
  let prevEmittedKeys: Set<string> | undefined;
  let retryReason: "reasoning-only" | "mid-response-stop" | "empty-response" | undefined;
  const attemptSnapshots: Array<Record<string, unknown>> = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();

    const attemptReasoningEffort = getRetryReasoningEffort(reasoningEffort, attempt);

    if (attempt > 0) {
      // Reasoning-only retry: model produced thinking but no text/tool calls.
      // The reasoning likely consumed the output budget.  Increase output tokens
      // significantly so the model has room to reason AND respond.
      // For thinking models max_tokens is not sent to the API (budget is
      // managed internally), but we still track the budget for non-thinking
      // models where doubling against the cap would be a no-op when already
      // at limit.
      currentMaxTokens = isThinkingModel
        ? currentMaxTokens * 2
        : Math.min(currentMaxTokens * 2, model.maxOutputTokens);
      debugLog("processOpenAIStream retry", {
        attempt,
        retryReason,
        reasoning_effort: attemptReasoningEffort,
      });
    }

    const requestBody: OcGoChatRequest = {
      model: model.id,
      messages: convertedMessages,
      stream: true,
      temperature: temperatureVal,
    };

    // NEVER send max_tokens or max_completion_tokens for thinking models.
    // The OpenCode Go API knows how to allocate the budget between reasoning
    // and visible output — overriding this causes the model to exhaust the
    // entire budget on thinking and produce no visible response.
    if (!isThinkingModel) {
      requestBody.max_tokens = currentMaxTokens;
    }

    if (toolConfig.tools) requestBody.tools = toolConfig.tools;
    if (toolConfig.tool_choice) requestBody.tool_choice = toolConfig.tool_choice;
    if (attemptReasoningEffort) requestBody.reasoning_effort = attemptReasoningEffort;

    if (process.env.OPENCODE_GO_DEBUG === "1" && attempt === 0) {
      debugLog("Outgoing request messages", {
        messages: requestBody.messages,
        tools: requestBody.tools,
        tool_choice: requestBody.tool_choice,
      });
    }

    const state = setupStreamState(progress, toolSchemas, requestContext, apiMessages);
    // Seed with previously emitted tool call keys to prevent duplicates on retry
    if (prevEmittedKeys) {
      for (const key of prevEmittedKeys) {
        state.emittedCanonicalKeys.add(key);
      }
    }
    const indexToId = new Map<number, string>();
    let finishReason: string | null = null;

    try {
      for await (const chunk of streamChatCompletion(
        apiKey,
        requestBody,
        abortController.signal,
        userAgent,
      )) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();

        const choice = chunk.choices?.[0];

        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }

        if (choice?.delta?.content) {
          state.handleTextDelta(choice.delta.content);
        }

        if (choice?.delta?.reasoning_content) {
          state.handleReasoningDelta(choice.delta.reasoning_content);
        }

        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = (tc as { index?: number }).index ?? 0;

            const callId =
              tc.id && typeof tc.id === "string"
                ? (indexToId.set(idx, tc.id), tc.id)
                : (indexToId.get(idx) ?? String(idx));

            if (state.completedNativeCallIds.has(callId)) continue;

            const existing = state.nativeToolCalls.get(callId);
            if (existing) {
              if (tc.function?.arguments && typeof tc.function.arguments === "string") {
                existing.args += tc.function.arguments;
              }
            } else if (tc.id && typeof tc.id === "string") {
              state.nativeToolCalls.set(callId, {
                id: tc.id,
                name: tc.function?.name ?? "",
                args: tc.function?.arguments ?? "",
              });
            }

            const buf = state.nativeToolCalls.get(callId);
            if (!buf || !buf.args.trim()) continue;

            // Avoid JSON.parse on fragments that are structurally incomplete
            if (!isProbablyCompleteJson(buf.args)) continue;

            try {
              const args = JSON.parse(buf.args) as unknown;
              if (buf.id && buf.name && isToolCallInput(args)) {
                const emitted = state.tryEmitNativeToolCall(buf.id, buf.name, args);
                if (emitted) {
                  state.completedNativeCallIds.add(callId);
                }
              }
              state.nativeToolCalls.delete(callId);
            } catch {
              // Structural check passed but JSON.parse failed — rare edge case
              debugLog(
                "processOpenAIStream",
                "Json parse failed despite structural completeness check",
              );
            }
          }
        }
      }

      // Flush remaining buffered tool calls at stream end
      for (const [callId, buf] of Array.from(state.nativeToolCalls.entries())) {
        if (state.completedNativeCallIds.has(callId)) continue;
        try {
          const args = buf.args ? JSON.parse(buf.args) : {};
          if (buf.id && buf.name && isToolCallInput(args)) {
            state.tryEmitNativeToolCall(buf.id, buf.name, args);
          }
          state.nativeToolCalls.delete(callId);
        } catch {
          debugLog("processOpenAIStream", "Failed to parse incomplete JSON at stream end");
        }
      }

      // Check if retry is needed
      const hasVisibleOutput = state.hasVisibleOutput();
      let shouldRetry = false;
      if (
        !hasVisibleOutput &&
        state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        shouldRetry = true;
        retryReason = "reasoning-only";
      } else if (
        !hasVisibleOutput &&
        state.hasIncompleteToolCall() &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        // Model started producing tool calls but stopped mid-response
        shouldRetry = true;
        retryReason = "mid-response-stop";
      } else if (
        !hasVisibleOutput &&
        !state.sawToolCall &&
        !state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        // Some providers occasionally terminate a stream without yielding any
        // visible content or tool calls. Retry a few times before surfacing the
        // fallback text to the user.
        shouldRetry = true;
        retryReason = "empty-response";
      }

      attemptSnapshots.push({
        attempt: attempt + 1,
        retryReason: shouldRetry ? retryReason : null,
        requestBody: JSON.parse(JSON.stringify(requestBody)) as OcGoChatRequest,
        state: {
          hasVisibleOutput,
          sawToolCall: state.sawToolCall,
          emittedToolCall: state.emittedToolCall,
          incompleteToolCall: state.hasIncompleteToolCall(),
          pendingTextChars: state.pendingText.length,
          reasoningChars: state.reasoningContent.length,
          nativeToolCalls: state.nativeToolCalls.size,
          skippedToolCalls: state.skippedToolCalls,
          finishReason,
        },
      });

      if (shouldRetry) {
        state.closeReasoningBlockIfNeeded();
        prevEmittedKeys = state.snapshotEmittedKeys();
        continue;
      }

      const shouldCaptureNoOutput =
        !hasVisibleOutput &&
        (!state.sawToolCall || state.reasoningContent.length > 0 || state.hasIncompleteToolCall());
      if (shouldCaptureNoOutput) {
        captureLog("OpenAI exhausted no-output retries", {
          model: model.id,
          attempts: attemptSnapshots,
          hint: "Replay the requestBody payloads above against /chat/completions to compare plain-vs-extension behavior.",
        });
      }

      // Finalize on last attempt (successful or all retries exhausted)
      state.finalize("processOpenAIStream");
      return;
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }
      throw err;
    }
  }
}
