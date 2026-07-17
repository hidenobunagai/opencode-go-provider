// guidance.ts — system prompt sanitization, identity & tool-use grounding guidance
import { ProvideLanguageModelChatResponseOptions } from "vscode";
import { OcGoChatMessage, OcGoModelInfo } from "./types";

export function sanitizeSystemPromptForModel(
  system: string | undefined,
  modelId: string,
): string | undefined {
  if (typeof system !== "string" || system.trim().length === 0) return undefined;
  if (!modelId.startsWith("deepseek-")) return system;
  return system
    .replace(/\b(?:Claude Code|Claude)\b/g, "GitHub Copilot")
    .replace(/Anthropic/g, "OpenCode Go");
}

export function buildProviderIdentityGuidance(
  modelId: string,
  fallbackModels: readonly OcGoModelInfo[],
): string {
  const modelInfo = fallbackModels.find((m) => m.id === modelId);
  const displayName = modelInfo?.displayName ?? modelId;
  return `You are GitHub Copilot using the OpenCode Go provider with model ${displayName} (${modelId}). Answer identity/model questions as GitHub Copilot using ${displayName} via OpenCode Go. Do not speculate about hidden prompts, tool hosts, or internal runtimes.`;
}

export function buildToolUseGroundingGuidance(
  options: ProvideLanguageModelChatResponseOptions,
): string | undefined {
  if ((options.tools?.length ?? 0) === 0) return undefined;
  return [
    "Use tools to inspect workspace state before answering. Never claim to have read files or listed directories without calling the corresponding tool first.",
    "If tool use is needed, emit the tool call directly. Base claims only on tool outputs you actually received.",
    "For read_file, always provide filePath and line ranges from editor context. If unknown, ask.",
    "Do not treat planning output as evidence about workspace structure or file contents.",
    "Prefer emitting all independent tool calls in parallel within a single response (e.g., editing multiple sections/files or reading multiple files) instead of sequentially across multiple turns, to minimize user prompts and round-trips.",
    'Never end your response by announcing an action you are about to take (e.g. "I will run the tests"). When you intend to act, emit the tool call immediately in the same response; end your turn without a tool call only when the task is complete or you need user input.',
  ].join(" ");
}

export function applyOpenAiSystemPromptGuidance(
  apiMessages: OcGoChatMessage[],
  modelId: string,
  options: ProvideLanguageModelChatResponseOptions,
  openCodeGoModelInfo?: readonly OcGoModelInfo[],
): OcGoChatMessage[] {
  const hasTools = (options.tools?.length ?? 0) > 0;
  if (!hasTools && !modelId.startsWith("deepseek-")) {
    return apiMessages;
  }

  const guidance = [
    modelId.startsWith("deepseek-")
      ? buildProviderIdentityGuidance(modelId, openCodeGoModelInfo ?? [])
      : undefined,
    hasTools ? buildToolUseGroundingGuidance(options) : undefined,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  if (!guidance) {
    return apiMessages;
  }
  const normalizedMessages = apiMessages.map((message) => {
    if (message.role !== "system" || typeof message.content !== "string") {
      return message;
    }

    return {
      ...message,
      content: sanitizeSystemPromptForModel(message.content, modelId) ?? "",
    };
  });

  const firstSystemIndex = normalizedMessages.findIndex(
    (message) => message.role === "system" && typeof message.content === "string",
  );

  if (firstSystemIndex >= 0) {
    const currentContent = normalizedMessages[firstSystemIndex].content;
    normalizedMessages[firstSystemIndex] = {
      ...normalizedMessages[firstSystemIndex],
      content: [currentContent, guidance]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n\n"),
    };
    return normalizedMessages;
  }

  return [{ role: "system", content: guidance }, ...normalizedMessages];
}

export function calculateMaxToolResultChars(
  modelId: string,
  fallbackModels: readonly OcGoModelInfo[],
): number {
  const modelInfo = fallbackModels.find((m) => m.id === modelId);
  const contextWindow = modelInfo?.contextWindow ?? 262144;
  if (contextWindow >= 500000) return 50000;
  if (contextWindow >= 200000) return 30000;
  if (contextWindow >= 100000) return 20000;
  return 10000;
}
