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
import { debugLog } from "../output-channel";
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
  const MAX_RETRIES = 3;
  let currentMaxTokens = requestedMaxTokens;
  let prevEmittedKeys: Set<string> | undefined;
  let retryReason: "reasoning-only" | "mid-response-stop" | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();

    if (attempt > 0) {
      // Reasoning-only retry: model produced thinking but no text/tool calls.
      // The reasoning likely consumed the output budget.  Increase output tokens
      // significantly so the model has room to reason AND respond.
      // For thinking models the maxOutputTokens cap is skipped on retry because
      // the budget must cover both reasoning and visible output; doubling
      // against the cap would be a no-op when already at limit.
      currentMaxTokens = isThinkingModel
        ? currentMaxTokens * 2
        : Math.min(currentMaxTokens * 2, model.maxOutputTokens);
      const retryLabel =
        retryReason === "mid-response-stop"
          ? "Retrying after mid-response stop with increased output token budget"
          : "Retrying with increased output token budget";
      progress.report(new vscode.LanguageModelTextPart(`\n\n(${retryLabel}...)\n\n`));
    }

    const requestBody: OcGoChatRequest = {
      model: model.id,
      messages: convertedMessages,
      stream: true,
      temperature: temperatureVal,
    };

    if (isThinkingModel) {
      requestBody.max_completion_tokens = currentMaxTokens;
    } else {
      requestBody.max_tokens = currentMaxTokens;
    }

    if (toolConfig.tools) requestBody.tools = toolConfig.tools;
    if (toolConfig.tool_choice) requestBody.tool_choice = toolConfig.tool_choice;
    if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;

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

    try {
      for await (const chunk of streamChatCompletion(
        apiKey,
        requestBody,
        abortController.signal,
        userAgent,
      )) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();

        const choice = chunk.choices?.[0];

        if (choice?.delta?.content) {
          state.handleTextDelta(choice.delta.content);
        }

        if (choice?.delta?.reasoning_content) {
          state.reasoningContent += choice.delta.reasoning_content;
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
                  state.nativeToolCalls.delete(callId);
                }
              }
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
        } catch {
          debugLog("processOpenAIStream", "Failed to parse incomplete JSON at stream end");
        }
      }

      // Check if retry is needed
      let shouldRetry = false;
      if (
        !state.hasEmittedOutput &&
        state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        shouldRetry = true;
        retryReason = "reasoning-only";
      } else if (
        state.sawToolCall &&
        !state.emittedToolCall &&
        state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        // Model started producing tool calls but stopped mid-response
        shouldRetry = true;
        retryReason = "mid-response-stop";
      }

      if (shouldRetry) {
        prevEmittedKeys = state.snapshotEmittedKeys();
        continue;
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
