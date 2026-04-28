// streaming/openai.ts — OpenAI-format SSE streaming + tool call assembly
import * as vscode from "vscode";
import { streamChatCompletion } from "../api";
import { applyOpenAiSystemPromptGuidance, calculateMaxToolResultChars } from "../guidance";
import { debugLog } from "../output-channel";
import { parseTextEmbeddedToolCalls, type ParsedTextToolCall } from "../tool-parser";
import {
  buildInvalidToolCallFallback,
  buildToolCallCanonicalKey,
  extractChatRequestContext,
  getCompletedToolCallKeys,
  getMissingRequiredToolArguments,
  getToolSchemaMap,
  hasRequiredToolArguments,
  isToolCallInput,
  repairToolArguments,
} from "../tool-repair";
import type { OcGoModelInfo } from "../types";
import { OcGoChatRequest } from "../types";
import {
  applyReasoningContentWorkaround,
  convertMessages,
  convertTools,
} from "../openai-conversion";

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
  const requestBody: OcGoChatRequest = {
    model: model.id,
    messages: convertedMessages,
    stream: true,
    max_tokens: requestedMaxTokens,
    temperature: temperatureVal,
  };
  if (toolConfig.tools) requestBody.tools = toolConfig.tools;
  if (toolConfig.tool_choice) requestBody.tool_choice = toolConfig.tool_choice;
  const reasoningEffort = normalizeReasoningEffort(model.reasoningEffort);
  if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;

  debugLog("Outgoing request messages", {
    messages: requestBody.messages,
    tools: requestBody.tools,
    tool_choice: requestBody.tool_choice,
  });

  const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
  const completedToolCallIndices = new Set<number>();
  const skippedToolCalls: { name: string; required: string[]; missing: string[] }[] = [];
  const emittedTextToolCallKeys = getCompletedToolCallKeys(
    apiMessages,
    requestContext,
    toolSchemas,
  );
  let pendingTextEmbeddedContent = "";
  let pendingText = "";
  let sawToolCall = false;
  let emittedToolCall = false;
  /** Accumulated reasoning/thinking content from models that emit it (e.g. DeepSeek V4) */
  let reasoningContent = "";
  /** Whether we have already flushed the accumulated reasoning content to the progress stream */
  let reasoningFlushed = false;

  const flushPendingText = (): void => {
    if (!reasoningFlushed && reasoningContent) {
      reasoningFlushed = true;
      progress.report(
        new vscode.LanguageModelTextPart(
          `[Reasoning]\n${reasoningContent.slice(0, 2000)}${reasoningContent.length > 2000 ? "\n...(truncated)" : ""}\n`,
        ),
      );
      debugLog("processOpenAIStream", {
        reasoning_length: reasoningContent.length,
        reasoning_preview: reasoningContent.slice(0, 300),
      });
    }
    if (!pendingText) return;
    progress.report(new vscode.LanguageModelTextPart(pendingText));
    pendingText = "";
  };

  const emitTextToolCall = (toolCall: ParsedTextToolCall, toolId?: string): void => {
    sawToolCall = true;
    const schema = toolSchemas.get(toolCall.name.toLowerCase());
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
    } else {
      skippedToolCalls.push({
        name: toolCall.name,
        required: schema?.required ?? [],
        missing: getMissingRequiredToolArguments(repairedArgs, schema),
      });
      debugLog("Skipped invalid text tool call", toolCall);
    }
  };

  const handleTextDelta = (text: string): void => {
    const { segments, incompleteText } = parseTextEmbeddedToolCalls(
      pendingTextEmbeddedContent + text,
    );
    pendingTextEmbeddedContent = incompleteText;
    for (const segment of segments) {
      if (segment.type === "text") {
        pendingText += segment.text;
      } else {
        emitTextToolCall(segment.toolCall);
      }
    }
  };

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
        handleTextDelta(choice.delta.content);
      }

      if (choice?.delta?.reasoning_content) {
        reasoningContent += choice.delta.reasoning_content;
      }

      if (choice?.delta?.tool_calls) {
        sawToolCall = true;
        for (const tc of choice.delta.tool_calls) {
          const idx = (tc as { index?: number }).index ?? 0;
          if (completedToolCallIndices.has(idx)) continue;

          const buf = toolCallBuffers.get(idx) ?? { args: "" };
          if (tc.id && typeof tc.id === "string") buf.id = tc.id;
          const func = tc.function;
          if (func?.name && typeof func.name === "string") buf.name = func.name;
          if (typeof func?.arguments === "string") buf.args += func.arguments;
          toolCallBuffers.set(idx, buf);

          if (buf.args.trim().length === 0) continue;

          try {
            const schema = toolSchemas.get((buf.name ?? "").toLowerCase());
            const args = repairToolArguments(
              buf.name ?? "",
              buf.args ? JSON.parse(buf.args) : {},
              requestContext,
              schema,
            );
            if (
              buf.id &&
              buf.name &&
              isToolCallInput(args) &&
              hasRequiredToolArguments(args, schema)
            ) {
              const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
              if (emittedTextToolCallKeys.has(canonicalKey)) {
                completedToolCallIndices.add(idx);
                toolCallBuffers.delete(idx);
                continue;
              }
              flushPendingText();
              progress.report(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
              emittedToolCall = true;
              emittedTextToolCallKeys.add(canonicalKey);
              completedToolCallIndices.add(idx);
              toolCallBuffers.delete(idx);
            } else if (buf.id && buf.name) {
              skippedToolCalls.push({
                name: buf.name,
                required: schema?.required ?? [],
                missing: getMissingRequiredToolArguments(args, schema),
              });
              debugLog("Skipped invalid tool call", {
                id: buf.id,
                name: buf.name,
                args,
              });
              completedToolCallIndices.add(idx);
              toolCallBuffers.delete(idx);
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
    for (const [idx, buf] of Array.from(toolCallBuffers.entries())) {
      if (completedToolCallIndices.has(idx)) continue;
      try {
        const schema = toolSchemas.get((buf.name ?? "").toLowerCase());
        const args = repairToolArguments(
          buf.name ?? "",
          buf.args ? JSON.parse(buf.args) : {},
          requestContext,
          schema,
        );
        if (buf.id && buf.name && isToolCallInput(args) && hasRequiredToolArguments(args, schema)) {
          const canonicalKey = buildToolCallCanonicalKey(buf.name, args);
          if (emittedTextToolCallKeys.has(canonicalKey)) continue;
          flushPendingText();
          progress.report(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
          emittedToolCall = true;
          emittedTextToolCallKeys.add(canonicalKey);
        } else if (buf.id && buf.name) {
          skippedToolCalls.push({
            name: buf.name,
            required: schema?.required ?? [],
            missing: getMissingRequiredToolArguments(args, schema),
          });
          debugLog("Skipped invalid tool call at stream end", {
            id: buf.id,
            name: buf.name,
            args,
          });
        }
      } catch {
        debugLog("processOpenAIStream", "Failed to parse incomplete JSON at stream end");
      }
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
  } catch (err) {
    if (token.isCancellationRequested || (err instanceof Error && err.name === "AbortError")) {
      throw new vscode.CancellationError();
    }
    throw err;
  }
}
