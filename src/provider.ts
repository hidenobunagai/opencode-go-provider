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
import { CONTEXT_WINDOW_SAFETY_MARGIN, DEFAULT_MAX_OUTPUT_TOKENS } from "./constants";
import { OcGoMcpClient } from "./mcp";
import { handleAnthropicRequest } from "./streaming/anthropic";
import { processOpenAIStream, type OpenAIModelInfo } from "./streaming/openai";
import { FALLBACK_MODELS, OcGoModelInfo } from "./types";
import { estimateMessagesTokens, estimateTokens } from "./utils";

export class OcGoChatModelProvider implements LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: Event<void> =
    this._onDidChangeLanguageModelChatInformation.event;

  private readonly _mcpClient: OcGoMcpClient;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
  ) {
    this._mcpClient = new OcGoMcpClient(secrets, userAgent);
  }

  fireModelInfoChanged(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  private getModelInfo(modelId: string): OcGoModelInfo | undefined {
    return FALLBACK_MODELS.find((m) => m.id === modelId);
  }

  private resolveApiModelId(modelId: string): string {
    const colonIndex = modelId.indexOf(":");
    return colonIndex > 0 ? modelId.slice(0, colonIndex) : modelId;
  }

  private modelSupportsVision(modelId: string): boolean {
    return this.getModelInfo(modelId)?.supportsVision ?? false;
  }

  private getVisionFallbackModelId(): string | undefined {
    const preferred = FALLBACK_MODELS.find((m) => m.id === "mimo-v2-omni" && m.supportsVision);
    return preferred?.id ?? FALLBACK_MODELS.find((m) => m.supportsVision)?.id;
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
          return this._mcpClient.analyzeImage(imageDataUrl, analysisPrompt, abortController.signal);
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
    return this._mapToChatInformation(FALLBACK_MODELS);
  }

  private _mapToChatInformation(
    models: Array<{ id: string; name: string }>,
  ): LanguageModelChatInformation[] {
    return models.map((model) => {
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
          info.contextWindow - Math.min(info.maxOutput, DEFAULT_MAX_OUTPUT_TOKENS),
        ),
        maxOutputTokens: info.maxOutput,
        capabilities: { toolCalling: info.supportsTools ? 128 : false, imageInput: true },
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
      const apiKey = await this.ensureApiKey(false);
      if (!apiKey) {
        progress.report(
          new vscode.LanguageModelTextPart(
            'OpenCode Go API key is not configured. Run "OpenCode Go: Manage OpenCode Go API Key" from the Command Palette, or retry this request and enter the key when prompted.',
          ),
        );
        return;
      }

      const inputTokenCount = estimateMessagesTokens(
        messages as never, // cast needed for VS Code API type compatibility
        model.id,
      );
      const maxInputTokens = model.maxInputTokens;
      const effectiveMaxInputTokens = Math.max(1, maxInputTokens - CONTEXT_WINDOW_SAFETY_MARGIN);

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

      const modelInfo = this.getModelInfo(model.id);
      const apiFormat = modelInfo?.apiFormat ?? "openai";
      const reasoningEffort = modelInfo?.reasoningEffort;
      const temperatureVal =
        typeof modelInfo?.fixedTemperature === "number"
          ? modelInfo.fixedTemperature
          : typeof (options.modelOptions as Record<string, unknown>)?.temperature === "number"
            ? ((options.modelOptions as Record<string, unknown>).temperature as number)
            : 0.7;

      const hasImages = this.hasImageInput(messages);
      let effectiveMessages = messages;
      let effectiveModelId = this.resolveApiModelId(model.id);

      if (hasImages && !this.modelSupportsVision(model.id)) {
        const visionFallback = this.getVisionFallbackModelId();
        if (visionFallback && visionFallback !== model.id) {
          effectiveModelId = this.resolveApiModelId(visionFallback);
        } else {
          effectiveMessages = await this.processImagesForNonVisionModel(messages, token);
        }
      }

      if (apiFormat === "anthropic") {
        await handleAnthropicRequest({
          modelId: effectiveModelId,
          messages: effectiveMessages,
          options,
          apiKey,
          requestedMaxTokens,
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
        modelInfo,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort,
      };

      await processOpenAIStream(
        openAIModel,
        effectiveMessages,
        options,
        apiKey,
        requestedMaxTokens,
        temperatureVal,
        FALLBACK_MODELS,
        this.userAgent,
        progress,
        token,
        abortController,
      );
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
      return Promise.resolve(estimateTokens(text));
    }
    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += estimateTokens(part.value);
      } else if (
        typeof part === "object" &&
        part !== null &&
        "value" in part &&
        typeof (part as Record<string, unknown>).value === "string"
      ) {
        total += estimateTokens((part as { value: string }).value);
      } else {
        total += 2;
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
