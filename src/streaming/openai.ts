// streaming/openai.ts — OpenAI-format SSE streaming + tool call assembly
import * as vscode from "vscode";
import { buildMissingToolCallNudge, looksLikeActionAnnouncement } from "../announcement";
import { streamChatCompletion } from "../api";
import { REASONING_CONTENT_WORKAROUND_MODELS } from "../constants";
import { applyOpenAiSystemPromptGuidance, calculateMaxToolResultChars } from "../guidance";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
  reasoningCache,
} from "../openai-conversion";
import { captureLog, debugLog } from "../output-channel";
import { extractChatRequestContext, getToolSchemaMap, isToolCallInput } from "../tool-repair";
import type { OcGoModelInfo } from "../types";
import { OcGoChatRequest } from "../types";
import { setupStreamState, type StreamState } from "./shared";

export interface OpenAIModelInfo {
  id: string;
  modelInfo?: OcGoModelInfo;
  maxOutputTokens: number;
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

function emitPendingToolCalls(state: StreamState): void {
  for (const [callId, buf] of Array.from(state.nativeToolCalls.entries())) {
    if (state.completedNativeCallIds.has(callId)) continue;
    try {
      const args = buf.args ? JSON.parse(buf.args) : {};
      if (buf.id && buf.name && isToolCallInput(args)) {
        const emitted = state.tryEmitNativeToolCall(buf.id, buf.name, args);
        if (emitted) {
          state.completedNativeCallIds.add(callId);
        }
      }
    } catch {
      debugLog("processOpenAIStream", `Failed to parse JSON for tool call ${buf.name}`);
    }
    state.nativeToolCalls.delete(callId);
  }
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
  reasoningEffort?: string,
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
  const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
  const isThinkingModel = REASONING_CONTENT_WORKAROUND_MODELS.has(model.id);

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
    | "empty-response"
    | "truncated"
    | "missing-tool-call"
    | undefined;
  // Messages sent on the next attempt.  Usually identical to convertedMessages,
  // but the missing-tool-call retry appends the model's action announcement
  // plus a nudge so the model can emit the tool call it announced.
  let requestMessages = convertedMessages;
  const attemptSnapshots: Array<Record<string, unknown>> = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    let fullContent = "";

    // When the user left Thinking Effort at "default", retries force "low" so a
    // thinking model cannot burn the whole budget on reasoning again — this is
    // what breaks reasoning-only retry storms.  An explicitly configured effort
    // keeps its step-down schedule (xhigh → high → medium → low).
    const attemptReasoningEffort =
      normalizedEffort !== undefined
        ? getRetryReasoningEffort(normalizedEffort, attempt)
        : attempt > 0 && isThinkingModel
          ? "low"
          : undefined;

    if (attempt > 0) {
      // Reasoning-only retry: the model produced thinking but no text/tool
      // calls, so the reasoning likely consumed the output budget.  Increase
      // output tokens significantly so the model has room to reason AND respond.
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
      messages: requestMessages,
      stream: true,
      temperature: temperatureVal,
    };

    if (isThinkingModel) {
      requestBody.max_completion_tokens = Math.min(
        Math.max(currentMaxTokens, 16384),
        model.maxOutputTokens,
      );
    } else {
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
          emitPendingToolCalls(state);
          fullContent += choice.delta.content;
          state.handleTextDelta(choice.delta.content);
        }

        if (choice?.delta?.reasoning_content) {
          emitPendingToolCalls(state);
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
          }
        }
      }

      // Flush remaining buffered tool calls at stream end
      emitPendingToolCalls(state);

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
      } else if (
        finishReason === "length" &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        // The model hit its output token budget mid-response, producing only
        // partial text or a fragment before being cut off.  Retry with larger
        // budget so the model has room to complete its full response.
        // This can fire even when hasVisibleOutput is true (e.g. the model
        // produced one word then exhausted the budget), which the three
        // conditions above would all skip.
        shouldRetry = true;
        retryReason = "truncated";
      } else if (
        !state.sawToolCall &&
        (finishReason === null || finishReason === "stop") &&
        (toolConfig.tools?.length ?? 0) > 0 &&
        state.pendingText.trim().length > 0 &&
        looksLikeActionAnnouncement(state.pendingText) &&
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
        const announcement = state.pendingText.trim();
        requestMessages = [
          ...requestMessages,
          {
            role: "assistant",
            content: announcement,
            ...(isThinkingModel ? { reasoning_content: " " } : {}),
          },
          { role: "user", content: buildMissingToolCallNudge() },
        ];
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

      const wasTruncated = finishReason === "length" && hasVisibleOutput;
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
      if (wasTruncated) {
        captureLog("OpenAI truncated response", {
          model: model.id,
          attempts: attemptSnapshots,
          finishReason,
          hasVisibleOutput,
          pendingTextChars: state.pendingText.length,
        });
      }

      // Finalize on last attempt (successful or all retries exhausted)
      state.finalize("processOpenAIStream");
      if (wasTruncated) {
        progress.report(
          new vscode.LanguageModelTextPart(
            "\n\n_⚠️ The response was automatically truncated. You can ask the model to continue if the response seems incomplete._",
          ),
        );
      }
      if (state.reasoningContent) {
        reasoningCache.set(fullContent.trim(), state.reasoningContent.trim());
      }
      return;
    } catch (err) {
      if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
        throw new vscode.CancellationError();
      }
      throw err;
    }
  }
}
