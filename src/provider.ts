import * as vscode from "vscode";
import {
  CancellationToken,
  Event,
  EventEmitter,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import { BASE_URL, streamChatCompletion } from "./api";
import { debugEnabled, debugLog } from "./output-channel";
import { OcGoMcpClient } from "./mcp";
import {
  AnthropicRequestBody,
  AnthropicSSEEvent,
  FALLBACK_MODELS,
  OcGoModelInfo,
  type Json,
} from "./types";
import {
  convertMessages,
  convertMessagesToAnthropic,
  convertTools,
  convertToolsToAnthropic,
  estimateMessagesTokens,
  LegacyPart,
} from "./utils";

const DEFAULT_MAX_TOKENS = 65536;

interface ToolSchema {
  required?: string[];
  enumValues?: Record<string, string[]>;
}

interface SkippedToolCall {
  name: string;
  required: string[];
}

interface ParsedTextToolCall {
  name: string;
  args: unknown;
}

interface ParsedTextSegmentText {
  type: "text";
  text: string;
}

interface ParsedTextSegmentToolCall {
  type: "toolCall";
  toolCall: ParsedTextToolCall;
}

type ParsedTextSegment = ParsedTextSegmentText | ParsedTextSegmentToolCall;

interface ParsedTextToolCallResult {
  segments: ParsedTextSegment[];
  incompleteText: string;
}

interface ChatRequestContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
}

function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

function getCompletedToolCallKeys(
  messages: readonly LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
): Set<string> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    const hasNonToolResultContent = message.content.some((part) => {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      return !(typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content));
    });
    if (hasNonToolResultContent) {
      startIndex = i + 1;
      break;
    }
  }

  const completedCallIds = new Set<string>();

  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolResultPart = part as { callId?: unknown; content?: unknown[] };
      if (typeof toolResultPart.callId === "string" && Array.isArray(toolResultPart.content)) {
        completedCallIds.add(toolResultPart.callId);
      }
    }
  }

  const keys = new Set<string>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const toolCallPart = part as { callId?: unknown; name?: unknown; input?: unknown };
      if (
        typeof toolCallPart.callId !== "string" ||
        !completedCallIds.has(toolCallPart.callId) ||
        typeof toolCallPart.name !== "string"
      ) {
        continue;
      }

      const repairedArgs = repairToolArguments(
        toolCallPart.name,
        toolCallPart.input ?? {},
        requestContext,
        toolSchemas.get(toolCallPart.name),
      );
      keys.add(buildToolCallCanonicalKey(toolCallPart.name, repairedArgs));
    }
  }

  return keys;
}

function getToolSchemaMap(
  options: ProvideLanguageModelChatResponseOptions,
): Map<string, ToolSchema> {
  const map = new Map<string, ToolSchema>();
  for (const tool of options.tools ?? []) {
    const inputSchema = tool.inputSchema as
      | { required?: unknown; properties?: unknown }
      | undefined;
    const required = Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : undefined;
    const enumValues: Record<string, string[]> = {};
    const properties =
      typeof inputSchema?.properties === "object" && inputSchema.properties !== null
        ? (inputSchema.properties as Record<string, unknown>)
        : {};
    for (const [name, value] of Object.entries(properties)) {
      const propertySchema =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as { enum?: unknown })
          : undefined;
      if (Array.isArray(propertySchema?.enum)) {
        const allowed = propertySchema.enum.filter(
          (item): item is string => typeof item === "string",
        );
        if (allowed.length > 0) {
          enumValues[name] = allowed;
        }
      }
    }
    map.set(tool.name, { required, enumValues });
  }
  return map;
}

function hasRequiredToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  const required = schema?.required ?? [];
  if (required.length === 0) {
    return true;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const record = args as Record<string, unknown>;
  return required.every(
    (key) =>
      key in record && record[key] !== undefined && record[key] !== null && record[key] !== "",
  );
}

function buildInvalidToolCallFallback(
  skippedToolCalls: readonly SkippedToolCall[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((toolCall) => toolCall.required.length > 0);
  if (!skippedWithRequiredArgs) {
    return undefined;
  }

  const requiredArgs = skippedWithRequiredArgs.required.map((arg) => `\`${arg}\``).join(", ");
  return `The model tried to call \`${skippedWithRequiredArgs.name}\` without the required argument(s) ${requiredArgs}. Please retry the request and provide those arguments explicitly.`;
}

function buildMissingApiKeyFallback(): string {
  return 'OpenCode Go API key is not configured. Run "OpenCode Go: Manage OpenCode Go API Key" from the Command Palette, or retry this request and enter the key when prompted.';
}

function findTrailingTokenPrefixStart(text: string, token: string): number {
  const maxPrefixLength = Math.min(text.length, token.length - 1);
  for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
    if (text.endsWith(token.slice(0, prefixLength))) {
      return text.length - prefixLength;
    }
  }

  return -1;
}

function parseTextEmbeddedToolCalls(text: string): ParsedTextToolCallResult {
  const beginToken = "<|tool_call_begin|>";
  const argBeginToken = "<|tool_call_argument_begin|>";
  const endToken = "<|tool_call_end|>";

  const segments: ParsedTextSegment[] = [];
  let remaining = text;
  let incompleteText = "";

  const appendText = (value: string): void => {
    if (!value) {
      return;
    }
    const lastSegment = segments.at(-1);
    if (lastSegment?.type === "text") {
      lastSegment.text += value;
      return;
    }
    segments.push({ type: "text", text: value });
  };

  while (remaining.length > 0) {
    const beginIndex = remaining.indexOf(beginToken);
    if (beginIndex === -1) {
      const partialBeginIndex = findTrailingTokenPrefixStart(remaining, beginToken);
      if (partialBeginIndex === -1) {
        appendText(remaining);
      } else {
        appendText(remaining.slice(0, partialBeginIndex));
        incompleteText = remaining.slice(partialBeginIndex);
      }
      break;
    }

    appendText(remaining.slice(0, beginIndex));
    remaining = remaining.slice(beginIndex + beginToken.length);

    const argBeginIndex = remaining.indexOf(argBeginToken);
    const endIndex = remaining.indexOf(endToken);
    if (argBeginIndex === -1 || endIndex === -1 || argBeginIndex > endIndex) {
      incompleteText = beginToken + remaining;
      break;
    }

    const name = remaining.slice(0, argBeginIndex).trim();
    const argsText = remaining.slice(argBeginIndex + argBeginToken.length, endIndex).trim();
    remaining = remaining.slice(endIndex + endToken.length);

    if (!name) {
      continue;
    }

    try {
      segments.push({
        type: "toolCall",
        toolCall: { name, args: argsText ? JSON.parse(argsText) : {} },
      });
    } catch {
      appendText(`${beginToken}${name}${argBeginToken}${argsText}${endToken}`);
    }
  }

  return { segments, incompleteText };
}

function extractChatRequestContext(
  messages: readonly LanguageModelChatMessage[],
): ChatRequestContext | undefined {
  const filePattern = /The user's current file is\s+([^\n]+?)\.(?:\s|$)/;
  const selectionPattern = /The current selection is from line\s+(\d+)\s+to line\s+(\d+)/;
  const cwdPattern = /(?:^|\n)Cwd:\s+([^\n]+)/;
  const context: ChatRequestContext = {};

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.content) {
      const text =
        part instanceof vscode.LanguageModelTextPart
          ? part.value
          : typeof part === "object" &&
              part !== null &&
              "value" in part &&
              typeof (part as { value?: unknown }).value === "string"
            ? (part as { value: string }).value
            : undefined;

      if (!text) {
        continue;
      }

      const fileMatch = text.match(filePattern);
      const selectionMatch = text.match(selectionPattern);
      const cwdMatch = text.match(cwdPattern);

      if (fileMatch && !context.filePath) {
        context.filePath = fileMatch[1].trim();
      }
      if (cwdMatch && !context.cwd) {
        context.cwd = cwdMatch[1].trim();
      }
      if (selectionMatch && context.startLine === undefined && context.endLine === undefined) {
        const startLine = Number(selectionMatch[1]);
        const endLine = Number(selectionMatch[2]);
        if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
          context.startLine = startLine;
          context.endLine = endLine;
        }
      }

      if (
        context.filePath &&
        context.cwd &&
        context.startLine !== undefined &&
        context.endLine !== undefined
      ) {
        break;
      }
    }
  }

  return context.filePath ||
    context.cwd ||
    context.startLine !== undefined ||
    context.endLine !== undefined
    ? context
    : undefined;
}

function repairToolArguments(
  toolName: string,
  args: unknown,
  requestContext: ChatRequestContext | undefined,
  schema?: ToolSchema,
): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }

  const record = args as Record<string, unknown>;
  const required = new Set(schema?.required ?? []);
  const needsStringField = (value: unknown, field: string): boolean =>
    required.has(field) && (typeof value !== "string" || value.trim().length === 0);
  const needsNumberField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "number";
  const context = requestContext;

  if (!context) {
    return args;
  }

  if (toolName === "read_file") {
    return {
      ...record,
      ...(needsStringField(record.filePath, "filePath") && context.filePath
        ? { filePath: context.filePath }
        : {}),
      ...(needsNumberField(record.startLine, "startLine")
        ? { startLine: context.startLine ?? 1 }
        : {}),
      ...(needsNumberField(record.endLine, "endLine") ? { endLine: context.endLine ?? 200 } : {}),
    };
  }

  if (toolName === "list_dir") {
    return {
      ...record,
      ...(needsStringField(record.path, "path") && context.cwd ? { path: context.cwd } : {}),
    };
  }

  return args;
}

function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

export class OcGoChatModelProvider implements LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  private readonly _mcpClient: OcGoMcpClient;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly globalState?: vscode.Memento,
  ) {
    this._mcpClient = new OcGoMcpClient(secrets);
  }

  fireModelInfoChanged(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /** Look up FALLBACK_MODELS entry by model id. */
  private getModelInfo(modelId: string): OcGoModelInfo | undefined {
    return FALLBACK_MODELS.find((m) => m.id === modelId);
  }

  /** Return true if the model natively accepts image inputs. */
  private modelSupportsVision(modelId: string): boolean {
    return this.getModelInfo(modelId)?.supportsVision ?? false;
  }

  /** Return the preferred vision fallback model id (mimo-v2-omni preferred). */
  private getVisionFallbackModelId(): string | undefined {
    const preferred = FALLBACK_MODELS.find((m) => m.id === "mimo-v2-omni" && m.supportsVision);
    return preferred?.id ?? FALLBACK_MODELS.find((m) => m.supportsVision)?.id;
  }

  /** Return true if any message contains image input parts. */
  private hasImageInput(messages: readonly LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        const p = part as { mimeType?: unknown; data?: unknown };
        if (typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Process images for non-vision models by converting them to text descriptions
   * using the OpenCode Go Vision model via MCP client.
   */
  private async processImagesForNonVisionModel(
    messages: readonly LanguageModelChatMessage[],
    token: CancellationToken,
  ): Promise<LanguageModelChatMessage[]> {
    const processedMessages: LanguageModelChatMessage[] = [];

    for (const msg of messages) {
      const textParts: string[] = [];
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (
          typeof part === "object" &&
          part !== null &&
          "value" in part &&
          typeof (part as { value?: unknown }).value === "string"
        ) {
          textParts.push((part as { value: string }).value);
        }
      }

      const images: Array<{ mimeType: string; data: Uint8Array }> = [];
      for (const part of msg.content) {
        const p = part as { mimeType?: unknown; data?: unknown; bytes?: unknown; buffer?: unknown };
        if (typeof p.mimeType !== "string" || !p.mimeType.startsWith("image/")) continue;
        let data: Uint8Array | undefined;
        if (p.data instanceof Uint8Array && p.data.length > 0) data = p.data;
        else if (p.bytes instanceof Uint8Array && (p.bytes as Uint8Array).length > 0)
          data = p.bytes as Uint8Array;
        else if (Array.isArray(p.data) && p.data.length > 0)
          data = new Uint8Array(p.data as number[]);
        else if (Array.isArray(p.bytes) && (p.bytes as unknown[]).length > 0)
          data = new Uint8Array(p.bytes as number[]);
        if (data) images.push({ mimeType: p.mimeType, data });
      }

      if (images.length === 0) {
        processedMessages.push(msg);
        continue;
      }

      const userPrompt = textParts.join(" ");
      const descriptions: string[] = [];

      for (const img of images) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const base64Data = Buffer.from(img.data).toString("base64");
        const imageDataUrl = `data:${img.mimeType};base64,${base64Data}`;
        const analysisPrompt = userPrompt || "Describe this image in detail.";
        const description = await this._mcpClient.analyzeImage(imageDataUrl, analysisPrompt);
        descriptions.push(description);
      }

      const newContent: vscode.LanguageModelTextPart[] = textParts.map(
        (t) => new vscode.LanguageModelTextPart(t),
      );
      if (descriptions.length > 0) {
        newContent.push(
          new vscode.LanguageModelTextPart(
            `\n\n[Image Analysis]:\n${descriptions.join("\n\n---\n\n")}`,
          ),
        );
      }
      processedMessages.push(vscode.LanguageModelChatMessage.User(newContent));
    }

    return processedMessages;
  }

  /**
   * Handle an Anthropic Messages API request (for MiniMax M2.5 / M2.7).
   */
  private async handleAnthropicRequest(
    modelId: string,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    apiKey: string,
    requestedMaxTokens: number,
    temperatureVal: number,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
    abortController: AbortController,
  ): Promise<void> {
    const toolConfig = convertToolsToAnthropic(options);
    const { messages: apiMessages, system } = convertMessagesToAnthropic(messages, {
      maxToolResultChars: 20000,
    });

    if (apiMessages.length === 0) {
      throw new Error("No messages to send to Anthropic API");
    }

    const requestBody: AnthropicRequestBody = {
      model: modelId,
      messages: apiMessages,
      max_tokens: Math.max(1, requestedMaxTokens),
      stream: true,
    };

    if (system) requestBody.system = system;
    if (typeof temperatureVal === "number" && temperatureVal > 0) {
      requestBody.temperature = temperatureVal;
    }
    if (toolConfig.tools && toolConfig.tools.length > 0) {
      requestBody.tools = toolConfig.tools;
      if (toolConfig.tool_choice && toolConfig.tool_choice !== "auto") {
        requestBody.tool_choice = toolConfig.tool_choice;
      }
    }

    const response = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
      },
      signal: abortController.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenCode Go Anthropic API error: ${response.status} ${response.statusText}\n${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error("No response body from Anthropic API");
    }

    await this.processAnthropicStreamingResponse(response.body, progress, token);
  }

  /**
   * Process an Anthropic-format streaming SSE response.
   */
  private async processAnthropicStreamingResponse(
    body: ReadableStream<Uint8Array>,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Track active tool_use blocks: index -> { id, name, inputJson }
    const activeToolCalls = new Map<number, { id: string; name: string; inputJson: string }>();

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let event: AnthropicSSEEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicSSEEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case "message_start":
              break;

            case "content_block_start": {
              const cb = (
                event as { content_block?: { type?: string; id?: string; name?: string } }
              ).content_block;
              if (cb?.type === "tool_use") {
                const idx = (event as { index: number }).index;
                const toolId = cb.id ?? `tu_${Math.random().toString(36).slice(2, 10)}`;
                const toolName = cb.name ?? "unknown_tool";
                activeToolCalls.set(idx, { id: toolId, name: toolName, inputJson: "" });
              }
              break;
            }

            case "content_block_delta": {
              const deltaEvt = event as {
                index: number;
                delta?: { type?: string; text?: string; partial_json?: string };
              };
              if (deltaEvt.delta?.type === "text_delta") {
                const text = deltaEvt.delta.text ?? "";
                if (text) progress.report(new vscode.LanguageModelTextPart(text));
              } else if (deltaEvt.delta?.type === "input_json_delta") {
                const partialJson = deltaEvt.delta.partial_json ?? "";
                const tc = activeToolCalls.get(deltaEvt.index);
                if (tc) tc.inputJson += partialJson;
              }
              break;
            }

            case "content_block_stop": {
              const idx = (event as { index: number }).index;
              const tc = activeToolCalls.get(idx);
              if (tc) {
                let input: Record<string, Json> = {};
                if (tc.inputJson.trim()) {
                  try {
                    input = JSON.parse(tc.inputJson) as Record<string, Json>;
                  } catch {
                    // keep empty input
                  }
                }
                progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, input));
                activeToolCalls.delete(idx);
              }
              break;
            }

            case "message_delta":
            case "message_stop":
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    // When silent, avoid prompting or network calls; return cached/fallback models immediately.
    if (options.silent) {
      const cached = this.globalState?.get<Array<{ id: string; name: string }>>(
        "opencode-go.models",
      );
      const models = cached && cached.length > 0 ? cached : FALLBACK_MODELS;
      return this._mapToChatInformation(models);
    }

    // Non-silent: return cached/fallback models immediately so the chat UI never blocks.
    const cached = this.globalState?.get<Array<{ id: string; name: string }>>("opencode-go.models");
    const models = cached && cached.length > 0 ? cached : FALLBACK_MODELS;

    return this._mapToChatInformation(models);
  }

  private _mapToChatInformation(
    models: Array<{ id: string; name: string }>,
  ): LanguageModelChatInformation[] {
    return models.map((model: { id: string; name: string }) => {
      const info = FALLBACK_MODELS.find((m) => m.id === model.id) ?? {
        id: model.id,
        name: model.name,
        displayName: model.name,
        contextWindow: 262144,
        maxOutput: 65536,
        supportsTools: true,
        supportsVision: false,
      };
      return {
        id: info.id,
        name: info.displayName,
        detail: "OpenCode Go",
        tooltip: `OpenCode Go ${info.name}`,
        family: "opencode-go",
        version: "1.0.0",
        maxInputTokens: Math.max(
          1,
          info.contextWindow - Math.min(info.maxOutput, DEFAULT_MAX_TOKENS),
        ),
        maxOutputTokens: info.maxOutput,
        capabilities: {
          toolCalling: info.supportsTools ? 128 : false,
          // All models accept image input: vision models handle natively,
          // non-vision models route through mimo-v2-omni or OCR fallback.
          imageInput: true,
        },
      };
    });
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const abortController = new AbortController();
    const cancellationSubscription = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const apiKey = await this.ensureApiKey(false);
      if (!apiKey) {
        progress.report(new vscode.LanguageModelTextPart(buildMissingApiKeyFallback()));
        return;
      }

      const inputTokenCount = estimateMessagesTokens(
        messages as readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
      );
      const maxInputTokens = model.maxInputTokens;

      if (inputTokenCount > maxInputTokens) {
        throw new Error(
          `Message exceeds token limit (${inputTokenCount} > ${maxInputTokens}). Try reducing the conversation history or switching to a model with a larger context window.`,
        );
      }

      const maxTokensVal = (options.modelOptions as Record<string, unknown>)?.max_tokens;
      const requestedMaxTokens = Math.min(
        typeof maxTokensVal === "number" ? maxTokensVal : DEFAULT_MAX_TOKENS,
        model.maxOutputTokens,
      );

      // Resolve model info for apiFormat and fixedTemperature
      const modelInfo = this.getModelInfo(model.id);
      const apiFormat = modelInfo?.apiFormat ?? "openai";
      const temperatureVal =
        typeof modelInfo?.fixedTemperature === "number"
          ? modelInfo.fixedTemperature
          : typeof (options.modelOptions as Record<string, unknown>)?.temperature === "number"
            ? ((options.modelOptions as Record<string, unknown>).temperature as number)
            : 0.7;

      // Handle image input: non-vision models fall back to OCR via MCP
      const hasImages = this.hasImageInput(messages);
      let effectiveMessages: readonly LanguageModelChatMessage[] = messages;
      let effectiveModelId = model.id;

      if (hasImages && !this.modelSupportsVision(model.id)) {
        const visionFallback = this.getVisionFallbackModelId();
        if (visionFallback && visionFallback !== model.id) {
          effectiveModelId = visionFallback;
        } else {
          effectiveMessages = await this.processImagesForNonVisionModel(messages, token);
        }
      }

      // Dispatch to Anthropic format for MiniMax models
      if (apiFormat === "anthropic") {
        await this.handleAnthropicRequest(
          effectiveModelId,
          effectiveMessages,
          options,
          apiKey,
          requestedMaxTokens,
          temperatureVal,
          progress,
          token,
          abortController,
        );
        return;
      }

      const apiMessages = convertMessages(effectiveMessages);

      const toolConfig = convertTools(options);
      const requestBody: import("./types").OcGoChatRequest = {
        model: effectiveModelId,
        messages: apiMessages,
        stream: true,
        max_tokens: requestedMaxTokens,
        temperature: temperatureVal,
      };
      if (toolConfig.tools) {
        requestBody.tools = toolConfig.tools;
      }
      if (toolConfig.tool_choice) {
        requestBody.tool_choice = toolConfig.tool_choice;
      }

      debugLog("Outgoing request messages", requestBody.messages);

      // Buffers for assembling streamed tool calls by index
      const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
      const completedToolCallIndices = new Set<number>();
      const toolSchemas = getToolSchemaMap(options);
      const requestContext = extractChatRequestContext(messages);
      const skippedToolCalls: SkippedToolCall[] = [];
      const emittedTextToolCallKeys = getCompletedToolCallKeys(
        messages,
        requestContext,
        toolSchemas,
      );
      let pendingTextEmbeddedContent = "";
      let pendingText = "";
      let sawToolCall = false;
      let emittedToolCall = false;
      const flushPendingText = (): void => {
        if (!pendingText) {
          return;
        }
        progress.report(new vscode.LanguageModelTextPart(pendingText));
        pendingText = "";
      };

      for await (const chunk of streamChatCompletion(
        apiKey,
        requestBody,
        abortController.signal,
        this.userAgent,
      )) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const choice = chunk.choices?.[0];

        // Handle text content
        if (choice?.delta?.content) {
          const { segments, incompleteText } = parseTextEmbeddedToolCalls(
            pendingTextEmbeddedContent + choice.delta.content,
          );
          pendingTextEmbeddedContent = incompleteText;

          for (const segment of segments) {
            if (segment.type === "text") {
              pendingText += segment.text;
              continue;
            }

            const toolCall = segment.toolCall;
            sawToolCall = true;
            const schema = toolSchemas.get(toolCall.name);
            const repairedArgs = repairToolArguments(
              toolCall.name,
              toolCall.args,
              requestContext,
              schema,
            );
            const canonicalKey = buildToolCallCanonicalKey(toolCall.name, repairedArgs);
            if (emittedTextToolCallKeys.has(canonicalKey)) {
              continue;
            }

            if (hasRequiredToolArguments(repairedArgs, schema)) {
              flushPendingText();
              progress.report(
                new vscode.LanguageModelToolCallPart(
                  `text_tool_${Math.random().toString(36).slice(2, 10)}`,
                  toolCall.name,
                  repairedArgs as Record<string, unknown>,
                ),
              );
              emittedToolCall = true;
              emittedTextToolCallKeys.add(canonicalKey);
            } else {
              skippedToolCalls.push({
                name: toolCall.name,
                required: schema?.required ?? [],
              });
              debugLog("Skipped invalid text tool call", toolCall);
            }
          }
        }

        // Handle tool calls
        if (choice?.delta?.tool_calls) {
          sawToolCall = true;
          for (const tc of choice.delta.tool_calls) {
            const idx = (tc as { index?: number }).index ?? 0;
            if (completedToolCallIndices.has(idx)) {
              continue;
            }

            const buf = toolCallBuffers.get(idx) ?? { args: "" };
            if (tc.id && typeof tc.id === "string") {
              buf.id = tc.id;
            }
            const func = tc.function;
            if (func?.name && typeof func.name === "string") {
              buf.name = func.name;
            }
            if (typeof func?.arguments === "string") {
              buf.args += func.arguments;
            }
            toolCallBuffers.set(idx, buf);

            if (buf.args.trim().length === 0) {
              continue;
            }

            // Emit immediately once arguments become valid JSON
            try {
              const schema = toolSchemas.get(buf.name ?? "");
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
                });
                debugLog("Skipped invalid tool call", { id: buf.id, name: buf.name, args });
                completedToolCallIndices.add(idx);
                toolCallBuffers.delete(idx);
              }
            } catch {
              // JSON incomplete — wait for next chunk
            }
          }
        }
      }

      if (pendingTextEmbeddedContent) {
        pendingText += pendingTextEmbeddedContent;
      }

      // Flush any remaining buffered tool calls at stream end
      for (const [idx, buf] of Array.from(toolCallBuffers.entries())) {
        if (completedToolCallIndices.has(idx)) {
          continue;
        }
        try {
          const schema = toolSchemas.get(buf.name ?? "");
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
              continue;
            }
            flushPendingText();
            progress.report(new vscode.LanguageModelToolCallPart(buf.id, buf.name, args));
            emittedToolCall = true;
            emittedTextToolCallKeys.add(canonicalKey);
          } else if (buf.id && buf.name) {
            skippedToolCalls.push({
              name: buf.name,
              required: schema?.required ?? [],
            });
            debugLog("Skipped invalid tool call at stream end", {
              id: buf.id,
              name: buf.name,
              args,
            });
          }
        } catch {
          // Ignore incomplete JSON at stream end
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
    } finally {
      cancellationSubscription.dispose();
    }
  }

  provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    _token: CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return Promise.resolve(Math.ceil(text.length / 2));
    }
    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += Math.ceil(part.value.length / 2);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "value" in part &&
        typeof (part as any).value === "string"
      ) {
        total += Math.ceil((part as any).value.length / 2);
      } else {
        total += 2; // rough estimate for non-text parts
      }
    }
    return Promise.resolve(total);
  }

  private async ensureApiKey(silent: boolean): Promise<string | undefined> {
    let apiKey = await this.secrets.get("opencode-go.apiKey");
    if (!apiKey && !silent) {
      const entered = await vscode.window.showInputBox({
        title: "OpenCode Go API Key",
        prompt: "Enter your OpenCode Go API key",
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await this.secrets.store("opencode-go.apiKey", apiKey);
      }
    }
    return apiKey;
  }
}
