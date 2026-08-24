// streaming/responses.ts — OpenAI Responses API SSE streaming for /responses
// endpoint (GPT 5.6 Luna). Mirrors the retry/visibility semantics of the
// OpenAI chat.completions path while consuming the Responses typed events.
import * as vscode from "vscode";
import { buildMissingToolCallNudge, looksLikeActionAnnouncement } from "../announcement";
import { fetchWithRetry, throwApiError } from "../api";
import { BASE_URL, REQUEST_TIMEOUT_MS } from "../constants";
import { applyOpenAiSystemPromptGuidance } from "../guidance";
import { convertMessages, reasoningCache } from "../openai-conversion";
import { captureLog, debugLog } from "../output-channel";
import { convertMessagesToResponses, convertToolsToResponses } from "../responses-conversion";
import { extractChatRequestContext, getToolSchemaMap, isToolCallInput } from "../tool-repair";
import { OcGoModelInfo, OcGoResponsesRequest, OcGoResponsesStreamEvent } from "../types";
import { readSseLines } from "./sse";
import {
  emitPendingToolCalls,
  getRetryReasoningEffort,
  pushAttemptSnapshot,
  REASONING_EFFORT_FALLBACK_ORDER,
  reportTruncated,
  setupStreamState,
} from "./shared";

export interface ResponsesRequestParams {
  modelId: string;
  messages: readonly vscode.LanguageModelChatMessage[];
  options: vscode.ProvideLanguageModelChatResponseOptions;
  apiKey: string;
  requestedMaxTokens: number;
  temperatureVal: number | undefined;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abortController: AbortController;
  fallbackModels: readonly OcGoModelInfo[];
  userAgent: string;
  reasoningEffort?: string;
}

export async function handleResponsesRequest(params: ResponsesRequestParams): Promise<void> {
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
    reasoningEffort,
  } = params;

  const toolSchemas = getToolSchemaMap(options);
  const requestContext = extractChatRequestContext(
    messages as readonly vscode.LanguageModelChatMessage[],
  );
  const modelInfo = fallbackModels.find((m) => m.id === modelId);
  const maxOutputTokens = modelInfo?.maxOutput ?? 128000;
  const isThinkingModel = modelInfo?.supportsThinking === true;
  const toolConfig = convertToolsToResponses(options);

  let convertedMessages = convertMessages(messages);
  convertedMessages = applyOpenAiSystemPromptGuidance(
    convertedMessages,
    modelId,
    options,
    fallbackModels,
  );
  const { input: initialInput, instructions } = convertMessagesToResponses(convertedMessages);
  // reasoningEffort is already validated per-model in provider.ts; keep as-is.
  const normalizedEffort = reasoningEffort;
  const supportedEfforts = modelInfo?.supportedReasoningEfforts as string[] | undefined;
  const fallbackOrder = supportedEfforts?.length
    ? REASONING_EFFORT_FALLBACK_ORDER.filter((e) => supportedEfforts.includes(e))
    : REASONING_EFFORT_FALLBACK_ORDER.filter((e) => ["high", "medium", "low"].includes(e));

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
  // Input items sent on the next attempt.  The missing-tool-call retry appends
  // the model's action announcement plus a nudge so the model can emit the
  // tool call it announced.
  let requestInput = initialInput;
  const attemptSnapshots: Array<Record<string, unknown>> = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    let fullContent = "";

    const attemptReasoningEffort =
      normalizedEffort !== undefined
        ? getRetryReasoningEffort(normalizedEffort, attempt, fallbackOrder)
        : attempt > 0 && isThinkingModel
          ? "low"
          : undefined;

    if (attempt > 0) {
      currentMaxTokens = Math.min(currentMaxTokens * 2, maxOutputTokens);
      debugLog("handleResponsesRequest retry", {
        attempt,
        retryReason,
        reasoning_effort: attemptReasoningEffort,
      });
    }

    const requestBody: OcGoResponsesRequest = {
      model: modelId,
      input: requestInput,
      stream: true,
      store: false,
      max_output_tokens: currentMaxTokens,
    };

    if (instructions) requestBody.instructions = instructions;
    if (typeof temperatureVal === "number" && temperatureVal > 0) {
      requestBody.temperature = temperatureVal;
    }
    if (toolConfig.tools && toolConfig.tools.length > 0) {
      requestBody.tools = toolConfig.tools;
      requestBody.tool_choice = toolConfig.tool_choice;
    }
    if (attemptReasoningEffort) {
      requestBody.reasoning = { effort: attemptReasoningEffort, summary: "auto" };
    }

    if (process.env.OPENCODE_GO_DEBUG === "1" && attempt === 0) {
      debugLog("Outgoing responses request", {
        input: requestBody.input,
        instructions: requestBody.instructions,
        tools: requestBody.tools,
        tool_choice: requestBody.tool_choice,
      });
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([abortController.signal, timeoutController.signal]);

    const response = await fetchWithRetry(
      `${BASE_URL}/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        signal: combinedSignal,
        body: JSON.stringify(requestBody),
      },
      5,
    ).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      await throwApiError(response, "OpenCode Go API error");
    }

    if (!response.body) {
      throw new Error("No response body from OpenCode Go API");
    }

    const state = setupStreamState(progress, toolSchemas, requestContext, messages);
    if (prevEmittedKeys) {
      for (const key of prevEmittedKeys) {
        state.emittedCanonicalKeys.add(key);
      }
    }
    let finishReason: string | null = null;

    try {
      for await (const line of readSseLines(response.body)) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();

        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        let event: OcGoResponsesStreamEvent;
        try {
          event = JSON.parse(data) as OcGoResponsesStreamEvent;
        } catch {
          debugLog("processResponsesStream", `Malformed SSE line: ${data.slice(0, 200)}`);
          continue;
        }

        switch (event.type) {
          case "response.output_item.added": {
            const item = event.item;
            if (item?.type === "function_call") {
              const id = item.id ?? item.call_id ?? `fc_${Math.random().toString(36).slice(2, 10)}`;
              state.nativeToolCalls.set(id, {
                id,
                name: item.name ?? "",
                args: item.arguments ?? "",
              });
            }
            break;
          }

          case "response.content_part.added":
          case "response.output_text.done":
          case "response.function_call_arguments.done":
            break;

          case "response.output_text.delta": {
            if (event.delta) {
              emitPendingToolCalls(state);
              fullContent += event.delta;
              state.handleTextDelta(event.delta);
            }
            break;
          }

          case "response.reasoning_text.delta":
          case "response.reasoning_summary_text.delta": {
            if (event.delta) {
              emitPendingToolCalls(state);
              state.handleReasoningDelta(event.delta);
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            const tc = event.item_id ? state.nativeToolCalls.get(event.item_id) : undefined;
            if (tc && event.delta) {
              tc.args += event.delta;
            }
            break;
          }

          case "response.output_item.done": {
            const item = event.item;
            if (item?.type !== "function_call") break;
            const id = item.id ?? item.call_id;
            if (!id) break;
            const tc = state.nativeToolCalls.get(id);
            if (!tc) break;
            const rawArgs = tc.args.trim() || item.arguments || "";
            if (rawArgs) {
              try {
                const input = JSON.parse(rawArgs) as Record<string, unknown>;
                if (tc.id && tc.name && isToolCallInput(input)) {
                  state.tryEmitNativeToolCall(tc.id, tc.name, input);
                }
              } catch {
                state.lostNativeToolCallCount += 1;
                debugLog("processResponsesStream", `Failed to parse JSON for tool call ${tc.name}`);
              }
            }
            state.nativeToolCalls.delete(id);
            break;
          }

          case "response.completed":
          case "response.incomplete": {
            if (event.response?.incomplete_details?.reason) {
              finishReason = event.response.incomplete_details.reason;
            } else if (event.response?.status === "completed" && finishReason === null) {
              finishReason = "stop";
            }
            break;
          }

          case "response.failed":
            debugLog("processResponsesStream", "Response failed");
            break;

          case "error":
            debugLog("processResponsesStream", `API error: ${event.error?.message ?? "unknown"}`);
            break;

          default:
            // Unknown event type — skip silently.  The Responses endpoint only
            // emits the event types handled above; anything else is either a
            // protocol extension or noise.
            break;
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
        shouldRetry = true;
        retryReason = "mid-response-stop";
      } else if (
        !hasVisibleOutput &&
        !state.sawToolCall &&
        !state.reasoningContent &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
        shouldRetry = true;
        retryReason = "empty-response";
      } else if (
        finishReason === "max_output_tokens" &&
        attempt < MAX_RETRIES &&
        !token.isCancellationRequested
      ) {
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
        shouldRetry = true;
        retryReason = "missing-tool-call";
        const announcement = state.pendingText.trim();
        requestInput = [
          ...requestInput,
          { type: "message", role: "assistant", content: announcement },
          { type: "message", role: "user", content: buildMissingToolCallNudge() },
        ];
      }

      pushAttemptSnapshot(
        attemptSnapshots,
        attempt,
        shouldRetry ? retryReason : undefined,
        requestBody,
        state,
        finishReason,
      );

      if (shouldRetry) {
        state.closeReasoningBlockIfNeeded();
        prevEmittedKeys = state.snapshotEmittedKeys();
        continue;
      }

      const wasTruncated = finishReason === "max_output_tokens" && hasVisibleOutput;
      const shouldCaptureNoOutput =
        !hasVisibleOutput &&
        (!state.sawToolCall || state.reasoningContent.length > 0 || state.hasIncompleteToolCall());
      if (shouldCaptureNoOutput) {
        captureLog("Responses exhausted no-output retries", {
          model: modelId,
          attempts: attemptSnapshots,
          hint: "Replay the requestBody payloads above against /responses to compare plain-vs-extension behavior.",
        });
      }
      if (wasTruncated) {
        captureLog("Responses truncated response", {
          model: modelId,
          attempts: attemptSnapshots,
          finishReason,
          hasVisibleOutput,
          pendingTextChars: state.pendingText.length,
        });
      }

      // Finalize on last attempt (successful or all retries exhausted)
      state.finalize("handleResponsesRequest");
      if (wasTruncated) {
        reportTruncated(progress);
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
