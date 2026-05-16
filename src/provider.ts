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
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  REASONING_CONTENT_WORKAROUND_MODELS,
  getContextWindowSafetyMargin,
} from "./constants";
import { OcGoMcpClient } from "./mcp";
import { handleAnthropicRequest } from "./streaming/anthropic";
import { processOpenAIStream, type OpenAIModelInfo } from "./streaming/openai";
import { estimateMessagesTokens, estimateTokens } from "./tokenizer";
import { FALLBACK_MODELS, OcGoModelInfo } from "./types";
import { debugLog } from "./output-channel";

export class OcGoChatModelProvider implements LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  private readonly _mcpClient: OcGoMcpClient;
  private readonly _modelMap: Map<string, OcGoModelInfo>;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
  ) {
    this._mcpClient = new OcGoMcpClient(secrets, userAgent);
    this._modelMap = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  }

  fireModelInfoChanged(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  private getConfiguredApiKeyState(configuration: unknown): {
    hasApiKeyProperty: boolean;
    apiKey?: string;
  } {
    if (!configuration || typeof configuration !== "object") {
      return { hasApiKeyProperty: false };
    }

    const configurationRecord = configuration as { apiKey?: unknown };
    if (!("apiKey" in configurationRecord)) {
      return { hasApiKeyProperty: false };
    }

    const apiKey = configurationRecord.apiKey;
    if (typeof apiKey !== "string") {
      return { hasApiKeyProperty: true };
    }

    const normalizedApiKey = apiKey.trim();
    return {
      hasApiKeyProperty: true,
      apiKey: normalizedApiKey || undefined,
    };
  }

  private async syncConfiguredApiKey(options: unknown): Promise<string | undefined> {
    if (!options || typeof options !== "object") {
      return undefined;
    }

    const optionsRecord = options as { configuration?: unknown; modelConfiguration?: unknown };
    const modelConfigurationState = this.getConfiguredApiKeyState(optionsRecord.modelConfiguration);
    const providerConfigurationState = this.getConfiguredApiKeyState(optionsRecord.configuration);
    const hasExplicitApiKeyProperty =
      modelConfigurationState.hasApiKeyProperty || providerConfigurationState.hasApiKeyProperty;
    if (!hasExplicitApiKeyProperty) {
      return undefined;
    }

    const configuredApiKey = modelConfigurationState.apiKey ?? providerConfigurationState.apiKey;
    const storedApiKey = await this.secrets.get("opencode-go.apiKey");
    if (!configuredApiKey) {
      if (storedApiKey !== undefined) {
        await this.secrets.delete("opencode-go.apiKey");
      }
      return undefined;
    }

    if (storedApiKey !== configuredApiKey) {
      await this.secrets.store("opencode-go.apiKey", configuredApiKey);
    }

    return configuredApiKey;
  }

  private getModelInfo(modelId: string): OcGoModelInfo | undefined {
    return this._modelMap.get(modelId);
  }

  private resolveApiModelId(modelId: string): string {
    const colonIndex = modelId.indexOf(":");
    return colonIndex > 0 ? modelId.slice(0, colonIndex) : modelId;
  }

  private modelSupportsVision(modelId: string): boolean {
    return this.getModelInfo(modelId)?.supportsVision ?? false;
  }

  private getVisionFallbackModelId(): string | undefined {
    const omni = this._modelMap.get("mimo-v2-omni");
    if (omni && omni.supportsVision) return omni.id;
    for (const m of this._modelMap.values()) {
      if (m.supportsVision) return m.id;
    }
    return undefined;
  }

  private hasImageInput(messages: readonly LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        const p = part as unknown as Record<string, unknown>;
        if (typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) return true;
      }
    }
    return false;
  }

  private async processImagesForNonVisionModel(
    messages: readonly LanguageModelChatMessage[],
    token: CancellationToken,
    apiKey: string,
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
      const abortController = new AbortController();
      const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());

      const descriptions = await Promise.all(
        images.map(async (img) => {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          const base64Data = Buffer.from(img.data).toString("base64");
          const imageDataUrl = `data:${img.mimeType};base64,${base64Data}`;
          const analysisPrompt = userPrompt || "Describe this image in detail.";
          return this._mcpClient.analyzeImage(
            imageDataUrl,
            analysisPrompt,
            abortController.signal,
            apiKey,
          );
        }),
      ).finally(() => cancellationSubscription.dispose());

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

  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) return [];
    try {
      await this.syncConfiguredApiKey(options);
      const models = this._mapToChatInformation(FALLBACK_MODELS);
      debugLog("provideLanguageModelChatInformation", {
        silent: options.silent,
        modelCount: models.length,
      });
      return models;
    } catch (error) {
      debugLog("provideLanguageModelChatInformationError", error);
      const models = this._mapToChatInformation(FALLBACK_MODELS);
      debugLog("provideLanguageModelChatInformationFallback", {
        modelCount: models.length,
      });
      return models;
    }
  }

  private _mapToChatInformation(
    models: Array<{ id: string; name: string }>,
  ): LanguageModelChatInformation[] {
    return models.map((model) => {
      const info = this._modelMap.get(model.id) ?? {
        id: model.id,
        name: model.name,
        displayName: model.name,
        contextWindow: 262144,
        maxOutput: 65536,
        supportsTools: true,
        supportsVision: false,
      };

      const tooltipParts: string[] = [`OpenCode Go — ${info.name}`];
      if (info.reasoningEffort) {
        tooltipParts.push(`Reasoning: ${info.reasoningEffort}`);
      }
      if (info.supportsVision) {
        tooltipParts.push("Vision: supported");
      }
      if (info.contextWindow >= 1000000) {
        tooltipParts.push("Context: 1M tokens");
      } else {
        tooltipParts.push(`Context: ${Math.round(info.contextWindow / 1000)}K tokens`);
      }
      if (info.apiFormat === "anthropic") {
        tooltipParts.push("API: Anthropic format");
      }

      return {
        id: info.id,
        name: info.displayName,
        detail: "OpenCode Go",
        tooltip: tooltipParts.join(" · "),
        family: "opencode-go",
        version: "1.0.0",
        maxInputTokens: Math.max(
          1,
          info.contextWindow - Math.min(info.maxOutput, DEFAULT_MAX_OUTPUT_TOKENS),
        ),
        maxOutputTokens: info.maxOutput,
        capabilities: {
          toolCalling: info.supportsTools,
          imageInput: info.supportsVision,
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
    const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());

    try {
      const [apiKey, inputTokenCount] = await Promise.all([
        this.ensureApiKey(options, false),
        Promise.resolve(estimateMessagesTokens(messages as never, model.id)),
      ]);
      if (!apiKey) {
        progress.report(
          new vscode.LanguageModelTextPart(
            'OpenCode Go API key is not configured. Add or configure OpenCode Go from the chat model picker, run "OpenCode Go: Manage OpenCode Go API Key" from the Command Palette, or retry this request and enter the key when prompted.',
          ),
        );
        return;
      }

      const maxInputTokens = model.maxInputTokens;
      const modelContextWindow = maxInputTokens + model.maxOutputTokens;
      const safetyMargin = getContextWindowSafetyMargin(modelContextWindow);
      const effectiveMaxInputTokens = Math.max(1, maxInputTokens - safetyMargin);

      if (inputTokenCount > effectiveMaxInputTokens) {
        throw new Error(
          `Message exceeds token limit (${inputTokenCount} > ${effectiveMaxInputTokens}). Try reducing the conversation history or switching to a model with a larger context window.`,
        );
      }

      const maxTokensVal = (options.modelOptions as Record<string, unknown>)?.max_tokens;
      const requestedMaxTokens = Math.min(
        typeof maxTokensVal === "number" ? maxTokensVal : DEFAULT_MAX_OUTPUT_TOKENS,
        model.maxOutputTokens,
      );

      // Thinking models (e.g. DeepSeek V4) consume part of the max_tokens budget
      // for internal reasoning. Enforce a minimum output budget so the model has
      // enough room to reason AND produce a visible response.
      // 16K floor avoids the common failure where reasoning exhausts the budget
      // before any text or tool calls are emitted.
      const MIN_THINKING_MODEL_OUTPUT_TOKENS = 16384;
      const resolvedModelId = this.resolveApiModelId(model.id);
      const isThinkingModel = REASONING_CONTENT_WORKAROUND_MODELS.has(resolvedModelId);
      const effectiveMaxTokens = isThinkingModel
        ? Math.max(
            requestedMaxTokens,
            Math.min(MIN_THINKING_MODEL_OUTPUT_TOKENS, model.maxOutputTokens),
          )
        : requestedMaxTokens;

      const hasImages = this.hasImageInput(messages);
      let effectiveMessages = messages;
      let effectiveModelId = this.resolveApiModelId(model.id);
      let effectiveModelInfo = this.getModelInfo(effectiveModelId);
      const variantModelInfo = this.getModelInfo(model.id);

      if (hasImages && !this.modelSupportsVision(model.id)) {
        const visionFallback = this.getVisionFallbackModelId();
        if (visionFallback && visionFallback !== model.id) {
          effectiveModelId = this.resolveApiModelId(visionFallback);
          effectiveModelInfo = this._modelMap.get(visionFallback);
          const selectedModelInfo = this.getModelInfo(model.id);
          progress.report(
            new vscode.LanguageModelTextPart(
              `Switching to ${effectiveModelInfo?.displayName ?? visionFallback} for image analysis (${selectedModelInfo?.displayName ?? model.id} does not support vision).\n\n`,
            ),
          );
        } else {
          try {
            effectiveMessages = await this.processImagesForNonVisionModel(messages, token, apiKey);
          } catch (err) {
            if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
              throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            progress.report(
              new vscode.LanguageModelTextPart(
                `Image analysis failed: ${message}. The selected model (${effectiveModelInfo?.displayName ?? model.id}) does not support vision and no vision fallback model is available. Please switch to a vision-capable model and try again.`,
              ),
            );
            return;
          }
        }
      }

      const apiFormat = effectiveModelInfo?.apiFormat ?? "openai";
      const reasoningEffort = variantModelInfo?.reasoningEffort;
      const temperatureVal =
        typeof variantModelInfo?.fixedTemperature === "number"
          ? variantModelInfo.fixedTemperature
          : typeof (options.modelOptions as Record<string, unknown>)?.temperature === "number"
            ? ((options.modelOptions as Record<string, unknown>).temperature as number)
            : 0.7;

      if (apiFormat === "anthropic") {
        await handleAnthropicRequest({
          modelId: effectiveModelId,
          messages: effectiveMessages,
          options,
          apiKey,
          requestedMaxTokens: effectiveMaxTokens,
          temperatureVal,
          userAgent: this.userAgent,
          fallbackModels: FALLBACK_MODELS,
          progress,
          token,
          abortController,
        });
        return;
      }

      const openAIModel: OpenAIModelInfo = {
        id: effectiveModelId,
        modelInfo: effectiveModelInfo,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort,
      };

      await processOpenAIStream(
        openAIModel,
        effectiveMessages,
        options,
        apiKey,
        effectiveMaxTokens,
        temperatureVal,
        FALLBACK_MODELS,
        this.userAgent,
        progress,
        token,
        abortController,
      );
    } catch (err) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (err instanceof vscode.CancellationError) {
        throw err;
      }
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
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
      return Promise.resolve(estimateTokens(text));
    }
    const textParts: string[] = [];
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "value" in part &&
        typeof (part as Record<string, unknown>).value === "string"
      ) {
        textParts.push((part as { value: string }).value);
      }
    }
    if (textParts.length === 0) {
      return Promise.resolve(2 * text.content.length);
    }
    return Promise.resolve(estimateTokens(textParts.join(" ")));
  }

  private async ensureApiKey(options: unknown, silent: boolean): Promise<string | undefined> {
    const configuredApiKey = await this.syncConfiguredApiKey(options);
    if (configuredApiKey) {
      return configuredApiKey;
    }

    let apiKey = (await this.secrets.get("opencode-go.apiKey"))?.trim();
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
