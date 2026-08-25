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
  BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  THINKING_MODELS,
  getContextWindowSafetyMargin,
} from "./constants";
import { OcGoVisionClient } from "./vision";
import { extractImageData, getTextPartValue } from "./message-parts";
import { debugLog } from "./output-channel";
import { handleAnthropicRequest } from "./streaming/anthropic";
import { processOpenAIStream, type OpenAIModelInfo } from "./streaming/openai";
import { handleResponsesRequest } from "./streaming/responses";
import { estimateMessagesTokens, estimateTokens } from "./tokenizer";
import {
  FALLBACK_MODELS,
  OcGoModelInfo,
  REASONING_EFFORT_ORDER,
  ReasoningEffort,
  inferModelInfo,
} from "./types";

export class OcGoChatModelProvider implements LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  private readonly _onDidCompleteResponse = new EventEmitter<void>();
  /** Fires after every chat response completes (success or error). */
  readonly onDidCompleteResponse: Event<void> = this._onDidCompleteResponse.event;

  private readonly _visionClient: OcGoVisionClient;
  private readonly _modelMap = new Map<string, OcGoModelInfo>();
  private _models: OcGoModelInfo[] = FALLBACK_MODELS;
  private _modelsFetched = false;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
  ) {
    this._visionClient = new OcGoVisionClient(secrets, userAgent);
    for (const m of FALLBACK_MODELS) {
      this._modelMap.set(m.id, m);
    }
    void this.fetchModels();
  }

  fireModelInfoChanged(): void {
    void this.fetchModels().then(() => {
      this._onDidChangeLanguageModelChatInformation.fire();
    });
  }

  private async fetchModels(): Promise<void> {
    const apiKey = await this.ensureApiKey({}, true);
    if (!apiKey) {
      debugLog("fetchModels", "No API key available, skipping dynamic model fetch.");
      return;
    }

    try {
      const response = await fetch(`${BASE_URL}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": this.userAgent,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as { data: Array<{ id: string }> };
      if (!body.data || !Array.isArray(body.data)) {
        throw new Error("Invalid response format");
      }

      const fetchedModels: OcGoModelInfo[] = body.data.map((item) => inferModelInfo(item.id));
      this._models = fetchedModels;
      this._modelMap.clear();
      for (const m of fetchedModels) {
        this._modelMap.set(m.id, m);
      }
      this._modelsFetched = true;
      debugLog("fetchModels", `Successfully fetched ${fetchedModels.length} models dynamically.`);
    } catch (error) {
      debugLog("fetchModelsError", `Failed to fetch dynamic models: ${error}. Using fallbacks.`);
    }
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
      const images: Array<{ mimeType: string; data: Uint8Array }> = [];
      for (const part of msg.content) {
        const textValue = getTextPartValue(part as never);
        if (textValue !== undefined) {
          textParts.push(textValue);
          continue;
        }
        const image = extractImageData(part as never);
        if (image) {
          images.push(image);
        }
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
          return this._visionClient.analyzeImage(
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
      if (!this._modelsFetched) {
        await this.fetchModels();
      }
      const models = this._mapToChatInformation(this._models);
      debugLog("provideLanguageModelChatInformation", {
        silent: options.silent,
        modelCount: models.length,
      });
      return models;
    } catch (error) {
      debugLog("provideLanguageModelChatInformationError", error);
      const models = this._mapToChatInformation(this._models);
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
      if (info.supportsThinking) {
        tooltipParts.push("Thinking Effort: configurable");
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
      if (info.apiFormat === "responses") {
        tooltipParts.push("API: Responses format");
      }

      return {
        id: info.id,
        name: info.displayName,
        detail: "OpenCode Go",
        tooltip: tooltipParts.join(" · "),
        family: "opencode-go",
        version: "1.0.0",
        isUserSelectable: true,
        maxInputTokens: Math.max(
          1,
          info.contextWindow - Math.min(info.maxOutput, DEFAULT_MAX_OUTPUT_TOKENS),
        ),
        maxOutputTokens: info.maxOutput,
        capabilities: {
          toolCalling: info.supportsTools,
          imageInput: info.supportsVision,
        },
        ...(info.supportsThinking
          ? (() => {
              const supported = info.supportedReasoningEfforts;
              const order = REASONING_EFFORT_ORDER;
              const efforts: ReasoningEffort[] =
                supported && supported.length > 0
                  ? [...supported].sort((a, b) => order.indexOf(a) - order.indexOf(b))
                  : (["low", "medium", "high", "max"] as ReasoningEffort[]);
              const labels: Record<ReasoningEffort, string> = {
                minimal: "Minimal",
                low: "Low",
                medium: "Medium",
                high: "High",
                xhigh: "XHigh",
                max: "Max",
              };
              const descriptions: Record<ReasoningEffort, string> = {
                minimal: "Minimal reasoning effort",
                low: "Low reasoning effort",
                medium: "Medium reasoning effort",
                high: "High reasoning effort",
                xhigh: "Maximum reasoning effort (xhigh)",
                max: "Maximum reasoning effort",
              };
              const enumValues = ["default", ...efforts];
              const enumItemLabels = ["Default", ...efforts.map((e) => labels[e])];
              const enumDescriptions = [
                "Let the model decide the reasoning effort",
                ...efforts.map((e) => descriptions[e]),
              ];
              return {
                configurationSchema: {
                  properties: {
                    reasoningEffort: {
                      type: "string",
                      title: "Thinking Effort",
                      enum: enumValues,
                      enumItemLabels,
                      enumDescriptions,
                      default: "default",
                      group: "navigation",
                    },
                  },
                },
              };
            })()
          : {}),
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
        Promise.resolve(estimateMessagesTokens(messages as never)),
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
      const isThinkingModel = THINKING_MODELS.has(resolvedModelId);
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
          // Silent like retries: operational notices written into the chat
          // would persist in the conversation history and confuse the model
          // on later turns.
          debugLog(
            "provideLanguageModelChatResponse",
            `Switching to ${effectiveModelInfo?.displayName ?? visionFallback} for image analysis (${selectedModelInfo?.displayName ?? model.id} does not support vision).`,
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
      const modelConfig = (options as unknown as Record<string, unknown>).modelConfiguration as
        Record<string, unknown> | undefined;
      const rawReasoningEffort =
        typeof modelConfig?.reasoningEffort === "string"
          ? (modelConfig.reasoningEffort as string)
          : undefined;
      let reasoningEffort: string | undefined =
        rawReasoningEffort === "default" ? undefined : rawReasoningEffort;
      // Validate per-model supported efforts; drop invalid selections (e.g. stale "max" for muse)
      // and handle legacy alias max<->xhigh.
      if (reasoningEffort && effectiveModelInfo?.supportedReasoningEfforts) {
        const supported = effectiveModelInfo.supportedReasoningEfforts as string[];
        if (!supported.includes(reasoningEffort)) {
          if (reasoningEffort === "max" && supported.includes("xhigh")) {
            reasoningEffort = "xhigh";
          } else if (reasoningEffort === "xhigh" && supported.includes("max")) {
            reasoningEffort = "max";
          } else {
            debugLog(
              "provideLanguageModelChatResponse",
              `Dropping unsupported reasoningEffort "${reasoningEffort}" for ${effectiveModelId} (supported: ${supported.join(",")})`,
            );
            reasoningEffort = undefined;
          }
        }
      } else if (reasoningEffort && effectiveModelInfo && !effectiveModelInfo.supportsThinking) {
        debugLog(
          "provideLanguageModelChatResponse",
          `Dropping reasoningEffort "${reasoningEffort}" for non-thinking model ${effectiveModelId}`,
        );
        reasoningEffort = undefined;
      }
      const temperatureVal =
        typeof variantModelInfo?.fixedTemperature === "number"
          ? variantModelInfo.fixedTemperature
          : typeof (options.modelOptions as Record<string, unknown>)?.temperature === "number"
            ? ((options.modelOptions as Record<string, unknown>).temperature as number)
            : undefined;
      const topPVal = variantModelInfo?.fixedTopP;

      if (apiFormat === "anthropic") {
        await handleAnthropicRequest({
          modelId: effectiveModelId,
          messages: effectiveMessages,
          options,
          apiKey,
          requestedMaxTokens: effectiveMaxTokens,
          temperatureVal,
          topPVal,
          userAgent: this.userAgent,
          fallbackModels: FALLBACK_MODELS,
          progress,
          token,
          abortController,
        });
        return;
      }

      if (apiFormat === "responses") {
        await handleResponsesRequest({
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
          reasoningEffort,
        });
        return;
      }

      const openAIModel: OpenAIModelInfo = {
        id: effectiveModelId,
        modelInfo: effectiveModelInfo,
        maxOutputTokens: model.maxOutputTokens,
      };

      await processOpenAIStream(
        openAIModel,
        effectiveMessages,
        options,
        apiKey,
        effectiveMaxTokens,
        temperatureVal,
        topPVal,
        FALLBACK_MODELS,
        this.userAgent,
        progress,
        token,
        abortController,
        reasoningEffort,
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
      this._onDidCompleteResponse.fire();
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
      const value = getTextPartValue(part as never);
      if (value !== undefined) {
        textParts.push(value);
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
