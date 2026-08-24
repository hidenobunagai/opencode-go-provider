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

/** Legacy helper: map "max" alias to the target API's highest effort level. Kept for stale configs; new per-model UI sends correct values directly. */
export function normalizeReasoningEffort(
  reasoningEffort: string | undefined,
  maxEquivalent: string,
): string | undefined {
  return reasoningEffort === "max" ? maxEquivalent : reasoningEffort;
}

/**
 * Step-down schedule used on retries. Includes all levels; per-model filtering
 * is applied in the streaming handlers so unsupported levels are skipped.
 */
export const REASONING_EFFORT_FALLBACK_ORDER = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
] as const;

/** Step reasoning effort down on retries so a thinking model cannot burn the whole budget again. */
export function getRetryReasoningEffort(
  reasoningEffort: string | undefined,
  attempt: number,
  fallbackOrder: readonly string[],
): string | undefined {
  if (!reasoningEffort || attempt <= 0) {
    return reasoningEffort;
  }
  const index = fallbackOrder.indexOf(reasoningEffort as (typeof fallbackOrder)[number]);
  if (index === -1) {
    return reasoningEffort;
  }
  return fallbackOrder[Math.min(index + attempt, fallbackOrder.length - 1)];
}

export function emitPendingToolCalls(state: StreamState): void {
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
      state.lostNativeToolCallCount += 1;
      debugLog("emitPendingToolCalls", `Failed to parse JSON for tool call ${buf.name}`);
    }
    state.nativeToolCalls.delete(callId);
  }
}

/** Record an attempt snapshot for the no-output/truncation capture logs. */
export function pushAttemptSnapshot(
  snapshots: Array<Record<string, unknown>>,
  attempt: number,
  retryReason: string | undefined,
  requestBody: unknown,
  state: StreamState,
  finishReason: string | null,
): void {
  snapshots.push({
    attempt: attempt + 1,
    retryReason: retryReason ?? null,
    requestBody: JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>,
    state: {
      hasVisibleOutput: state.hasVisibleOutput(),
      sawToolCall: state.sawToolCall,
      emittedToolCall: state.emittedToolCall,
      incompleteToolCall: state.hasIncompleteToolCall(),
      pendingTextChars: state.pendingText.length,
      reasoningChars: state.reasoningContent.length,
      nativeToolCalls: state.nativeToolCalls.size,
      lostNativeToolCalls: state.lostNativeToolCallCount,
      skippedToolCalls: state.skippedToolCalls,
      finishReason,
    },
  });
}

export function reportTruncated(progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
  progress.report(
    new vscode.LanguageModelTextPart(
      "\n\n_⚠️ The response was automatically truncated. You can ask the model to continue if the response seems incomplete._",
    ),
  );
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
  hasEmittedNormalOutput = false;
  reasoningContent = "";
  reasoningFlushed = false;
  isReasoningActive = false;
  hasReasoningStarted = false;
  skippedToolCalls: SkippedToolCall[] = [];

  nativeToolCalls = new Map<string, NativeToolCall>();
  completedNativeCallIds = new Set<string>();

  /**
   * Number of buffered native tool calls dropped because their streamed
   * arguments never formed valid JSON.  Diagnostic only: the entries are
   * dropped to avoid poisoning later retries, but the count is surfaced in
   * attempt snapshots so mid-response cut-offs remain visible in capture logs.
   */
  lostNativeToolCallCount = 0;

  /** Captured stop_reason from Anthropic message_delta events */
  stopReason: string | null = null;

  private toolCallScanner = new ToolCallScanner();

  constructor(
    private progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private toolSchemas: Map<string, ToolSchema>,
    private requestContext: ChatRequestContext | undefined,
    public emittedCanonicalKeys: Set<string>,
  ) {}

  handleReasoningDelta(text: string): void {
    this.reasoningContent += text;

    const LanguageModelThinkingPartClass = (
      vscode as unknown as {
        LanguageModelThinkingPart?: new (text: string) => vscode.LanguageModelResponsePart;
      }
    ).LanguageModelThinkingPart;
    if (LanguageModelThinkingPartClass) {
      this.progress.report(new LanguageModelThinkingPartClass(text));
      this.hasEmittedOutput = true;
      return;
    }

    if (!this.hasReasoningStarted) {
      this.hasReasoningStarted = true;
      this.isReasoningActive = true;
      const startTag = `\n> **[思考プロセス (Thinking Process)]**\n> `;
      this.progress.report(new vscode.LanguageModelTextPart(startTag));
      this.hasEmittedOutput = true;
    }
    const formattedText = text.replace(/\n/g, "\n> ");
    this.progress.report(new vscode.LanguageModelTextPart(formattedText));
  }

  closeReasoningBlockIfNeeded(): void {
    if (this.isReasoningActive) {
      this.isReasoningActive = false;
      const LanguageModelThinkingPartClass = (
        vscode as unknown as {
          LanguageModelThinkingPart?: new (text: string) => vscode.LanguageModelResponsePart;
        }
      ).LanguageModelThinkingPart;
      if (!LanguageModelThinkingPartClass) {
        const endTag = `\n\n---\n\n`;
        this.progress.report(new vscode.LanguageModelTextPart(endTag));
      }
    }
  }

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
    this.hasEmittedNormalOutput = true;
    this.pendingText = "";
  }

  handleTextDelta(text: string): void {
    this.closeReasoningBlockIfNeeded();
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
    this.closeReasoningBlockIfNeeded();
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
      this.hasEmittedNormalOutput = true;
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
    this.closeReasoningBlockIfNeeded();
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
    this.hasEmittedNormalOutput = true;
    return true;
  }

  /**
   * Capture the set of already-emitted tool call canonical keys so they can
   * seed a new StreamState on retry, preventing duplicate tool call emissions.
   */
  snapshotEmittedKeys(): Set<string> {
    return new Set(this.emittedCanonicalKeys);
  }

  hasVisibleOutput(): boolean {
    return (
      this.hasEmittedNormalOutput ||
      (this.pendingText.trim().length > 0 && !this.hasIncompleteToolCall())
    );
  }

  hasIncompleteToolCall(): boolean {
    return (
      this.nativeToolCalls.size > 0 ||
      (this.sawToolCall && !this.emittedToolCall && this.skippedToolCalls.length === 0) ||
      this.toolCallScanner.buffer.trim().length > 0
    );
  }

  finalize(reasoningLogLabel: string): void {
    this.closeReasoningBlockIfNeeded();
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
        this.hasEmittedNormalOutput = true;
      }
    }

    if (this.reasoningContent && !this.reasoningFlushed) {
      this.reasoningFlushed = true;
      debugLog(reasoningLogLabel, {
        reasoning_length: this.reasoningContent.length,
        reasoning_preview: this.reasoningContent.slice(0, 300),
      });
    }

    if (!this.hasEmittedNormalOutput) {
      const fallbackText = this.reasoningContent
        ? "The model completed internal reasoning but returned no visible response. Please retry. If this keeps happening, try a lower reasoning setting."
        : "The model returned no visible response. Please retry.";
      this.progress.report(new vscode.LanguageModelTextPart(fallbackText));
      this.hasEmittedOutput = true;
      this.hasEmittedNormalOutput = true;
    }
  }
}
