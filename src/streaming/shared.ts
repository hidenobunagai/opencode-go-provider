import * as vscode from "vscode";
import { debugLog } from "../output-channel";
import { ToolCallScanner, type ParsedTextToolCall } from "../tool-parser";
import {
  buildInvalidToolCallFallback,
  buildToolCallCanonicalKey,
  getCompletedToolCallKeys,
  getMissingRequiredToolArguments,
  hasRequiredToolArguments,
  isToolCallInput,
  repairToolArguments,
  type ChatRequestContext,
  type ToolSchema,
} from "../tool-repair";

export interface SkippedToolCall {
  name: string;
  required: string[];
  missing: string[];
}

export interface NativeToolCall {
  id: string;
  name: string;
  args: string;
}

export function setupStreamState(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  toolSchemas: Map<string, ToolSchema>,
  requestContext: ChatRequestContext | undefined,
  messages: readonly vscode.LanguageModelChatMessage[],
): StreamState {
  const emittedCanonicalKeys = getCompletedToolCallKeys(messages, requestContext, toolSchemas);
  return new StreamState(progress, toolSchemas, requestContext, emittedCanonicalKeys);
}

export class StreamState {
  pendingText = "";
  sawToolCall = false;
  emittedToolCall = false;
  hasEmittedOutput = false;
  reasoningContent = "";
  reasoningFlushed = false;
  skippedToolCalls: SkippedToolCall[] = [];

  nativeToolCalls = new Map<string, NativeToolCall>();
  completedNativeCallIds = new Set<string>();

  private toolCallScanner = new ToolCallScanner();

  constructor(
    private progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private toolSchemas: Map<string, ToolSchema>,
    private requestContext: ChatRequestContext | undefined,
    public emittedCanonicalKeys: Set<string>,
  ) {}

  flushPendingText(reasoningLogLabel: string): void {
    if (!this.reasoningFlushed && this.reasoningContent) {
      this.reasoningFlushed = true;
      debugLog(reasoningLogLabel, {
        reasoning_length: this.reasoningContent.length,
        reasoning_preview: this.reasoningContent.slice(0, 300),
      });
    }
    if (!this.pendingText) return;
    this.progress.report(new vscode.LanguageModelTextPart(this.pendingText));
    this.hasEmittedOutput = true;
    this.pendingText = "";
  }

  handleTextDelta(text: string): void {
    const segments = this.toolCallScanner.feed(text);
    for (const segment of segments) {
      if (segment.type === "text") {
        this.pendingText += segment.text;
      } else {
        this.emitTextEmbeddedToolCall(segment.toolCall);
      }
    }
  }

  emitTextEmbeddedToolCall(toolCall: ParsedTextToolCall, toolId?: string): void {
    this.sawToolCall = true;
    const schema = this.toolSchemas.get(toolCall.name.toLowerCase());
    const repairedArgs = repairToolArguments(
      toolCall.name,
      toolCall.args,
      this.requestContext,
      schema,
    );
    const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
    if (this.emittedCanonicalKeys.has(canonicalKey)) return;

    if (hasRequiredToolArguments(repairedArgs, schema) && isToolCallInput(repairedArgs)) {
      this.flushPendingText("StreamState");
      this.progress.report(
        new vscode.LanguageModelToolCallPart(
          toolId ?? `text_tool_${Math.random().toString(36).slice(2, 10)}`,
          toolCall.name,
          repairedArgs,
        ),
      );
      this.emittedToolCall = true;
      this.hasEmittedOutput = true;
      this.emittedCanonicalKeys.add(canonicalKey);
    } else {
      this.skippedToolCalls.push({
        name: toolCall.name,
        required: schema?.required ?? [],
        missing: getMissingRequiredToolArguments(repairedArgs, schema),
      });
      debugLog("Skipped invalid embedded tool call", toolCall);
    }
  }

  tryEmitNativeToolCall(id: string, name: string, rawArgs: unknown): boolean {
    this.sawToolCall = true;
    const schema = this.toolSchemas.get(name.toLowerCase());
    const repairedArgs = repairToolArguments(name, rawArgs, this.requestContext, schema);

    if (!isToolCallInput(repairedArgs) || !hasRequiredToolArguments(repairedArgs, schema)) {
      this.skippedToolCalls.push({
        name,
        required: schema?.required ?? [],
        missing: getMissingRequiredToolArguments(repairedArgs, schema),
      });
      debugLog("Skipped invalid native tool call", { id, name, args: repairedArgs });
      return false;
    }

    const canonicalKey = buildToolCallCanonicalKey(name, repairedArgs);
    if (this.emittedCanonicalKeys.has(canonicalKey)) {
      debugLog("Dup suppressed native tool call", { id, name, canonicalKey });
      return false;
    }
    this.emittedCanonicalKeys.add(canonicalKey);

    this.flushPendingText("StreamState");
    this.progress.report(new vscode.LanguageModelToolCallPart(id, name, repairedArgs));
    this.emittedToolCall = true;
    this.hasEmittedOutput = true;
    return true;
  }

  /**
   * Capture the set of already-emitted tool call canonical keys so they can
   * seed a new StreamState on retry, preventing duplicate tool call emissions.
   */
  snapshotEmittedKeys(): Set<string> {
    return new Set(this.emittedCanonicalKeys);
  }

  finalize(reasoningLogLabel: string): void {
    const leftoverText = this.toolCallScanner.flushText();
    if (leftoverText) {
      this.pendingText += leftoverText;
    }

    if (
      this.pendingText &&
      (!this.sawToolCall || this.emittedToolCall || this.pendingText.trim().length > 0)
    ) {
      this.flushPendingText(reasoningLogLabel);
    }

    if (this.sawToolCall && !this.emittedToolCall) {
      const fallbackText = buildInvalidToolCallFallback(this.skippedToolCalls);
      if (fallbackText) {
        this.progress.report(new vscode.LanguageModelTextPart(fallbackText));
        this.hasEmittedOutput = true;
      }
    }

    if (this.reasoningContent && !this.reasoningFlushed) {
      this.reasoningFlushed = true;
      debugLog(reasoningLogLabel, {
        reasoning_length: this.reasoningContent.length,
        reasoning_preview: this.reasoningContent.slice(0, 300),
      });
    }

    if (!this.hasEmittedOutput) {
      const reasonings =
        this.reasoningContent.trim().length > 0
          ? ` The model produced ${this.reasoningContent.length} characters of internal reasoning but no visible output.`
          : " The API returned no content.";
      this.progress.report(
        new vscode.LanguageModelTextPart(
          `The model did not return any text content.${reasonings} This may indicate the model's token budget was exhausted during reasoning, or the request was interrupted. Try reducing the conversation length, simplifying the prompt, or switching to a model with a larger context window.`,
        ),
      );
    }
  }
}
