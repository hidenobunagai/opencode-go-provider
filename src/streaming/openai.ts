// streaming/openai.ts — OpenAI-format SSE streaming + tool call assembly
import * as vscode from "vscode";
import { streamChatCompletion } from "../api";
import { applyOpenAiSystemPromptGuidance, calculateMaxToolResultChars } from "../guidance";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
} from "../openai-conversion";
import type { OcGoModelInfo } from "../types";
import { OcGoChatRequest } from "../types";
import { getToolSchemaMap, extractChatRequestContext, isToolCallInput } from "../tool-repair";
import { debugLog } from "../output-channel";
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
  const isThinkingModel = model.id.startsWith("deepseek-v");

  const MAX_RETRIES = 1;
  let currentMaxTokens = requestedMaxTokens;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();

    if (attempt > 0) {
      currentMaxTokens = Math.min(currentMaxTokens * 2, model.maxOutputTokens);
      progress.report(
        new vscode.LanguageModelTextPart(
          "\n\n(Retrying with increased output token budget...)\n\n",
        ),
      );
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
              debugLog(
                "processOpenAIStream",
                "Failed to parse tool call JSON, waiting for next chunk",
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

      // Check if retry is needed: reasoning was produced but no visible output
      if (
        !state.hasEmittedOutput &&
        state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
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
