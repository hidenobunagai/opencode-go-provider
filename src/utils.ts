import * as vscode from "vscode";
import { REASONING_CONTENT_WORKAROUND_MODELS } from "./constants";
import { debugLog } from "./output-channel";
import {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
  Json,
  JsonObject,
  OcGoChatMessage,
  OcGoContentPart,
  OcGoTool,
} from "./types";

export interface LegacyPart {
  type?: string;
  mimeType?: string;
  bytes?: Uint8Array | number[];
  data?: Uint8Array | number[];
  buffer?: ArrayBuffer;
  value?: string;
  [key: string]: unknown;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toUint8Array(
  data: Uint8Array | number[] | ArrayBuffer | string | undefined,
  options?: { allowBase64String?: boolean },
): Uint8Array | undefined {
  if (data instanceof Uint8Array && data.length > 0) {
    return data;
  }
  if (Array.isArray(data) && data.length > 0) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer && data.byteLength > 0) {
    return new Uint8Array(data);
  }
  if (typeof data === "string" && data.length > 0) {
    const trimmed = data.trim();
    if (
      options?.allowBase64String &&
      trimmed.length > 0 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length > 0) {
        try {
          const text = new TextDecoder().decode(decoded);
          if (!text.includes("\uFFFD") && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
            return decoded;
          }
        } catch {
          // Fall back to treating the value as plain text.
        }
      }
    }
    return Buffer.from(data, "utf8");
  }
  return undefined;
}

function isIgnorableToolResultPart(part: vscode.LanguageModelInputPart | LegacyPart): boolean {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const mimeType = (part as { mimeType?: unknown }).mimeType;
  return typeof mimeType === "string" && mimeType.includes("cache_control");
}

function getTextPartValue(part: vscode.LanguageModelInputPart | LegacyPart): string | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (typeof part === "object" && part !== null) {
    const p = part as { value?: string };
    if (typeof p.value === "string") {
      return p.value;
    }
  }
  return undefined;
}

function getDataPartTextValue(
  part: vscode.LanguageModelInputPart | LegacyPart,
): string | undefined {
  if (typeof part !== "object" || part === null) {
    return undefined;
  }
  const p = part as {
    mimeType?: unknown;
    data?: Uint8Array | number[] | string;
    bytes?: Uint8Array | number[] | string;
    buffer?: ArrayBuffer;
  };
  if (typeof p.mimeType !== "string") {
    return undefined;
  }
  const isTextMime =
    p.mimeType.startsWith("text/") ||
    p.mimeType === "application/json" ||
    p.mimeType.endsWith("+json");
  if (!isTextMime) {
    return undefined;
  }
  const allowBase64String = p.mimeType === "application/json" || p.mimeType.endsWith("+json");
  const bytes =
    toUint8Array(p.data, { allowBase64String }) ??
    toUint8Array(p.bytes, { allowBase64String }) ??
    toUint8Array(p.buffer);
  if (!bytes) {
    return undefined;
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function extractImageData(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { mimeType: string; data: Uint8Array } | undefined {
  if (typeof part !== "object" || part === null) return undefined;

  const p = part as LegacyPart;
  const mimeType = typeof p.mimeType === "string" ? p.mimeType : undefined;
  if (!mimeType || !mimeType.startsWith("image/")) {
    return undefined;
  }

  if (p.data instanceof Uint8Array && p.data.length > 0) {
    return { mimeType, data: p.data };
  }
  if (p.bytes instanceof Uint8Array && p.bytes.length > 0) {
    return { mimeType, data: p.bytes };
  }
  if (p.buffer instanceof ArrayBuffer && p.buffer.byteLength > 0) {
    return { mimeType, data: new Uint8Array(p.buffer) };
  }
  if (Array.isArray(p.bytes) && p.bytes.length > 0) {
    return { mimeType, data: new Uint8Array(p.bytes) };
  }
  if (Array.isArray(p.data) && p.data.length > 0) {
    return { mimeType, data: new Uint8Array(p.data) };
  }

  return undefined;
}

function getToolCallInfo(
  part: vscode.LanguageModelInputPart | LegacyPart,
): { id?: string; name?: string; args?: Record<string, unknown> } | undefined {
  const p = part as { callId?: string; name?: string; input?: Record<string, unknown> };
  if (typeof p.callId === "string" && typeof p.name === "string") {
    return { id: p.callId, name: p.name, args: p.input };
  }
  return undefined;
}

function getToolResultTexts(part: vscode.LanguageModelInputPart | LegacyPart): string[] {
  const results: string[] = [];
  const p = part as { callId?: string; content?: unknown[] };
  if (typeof p.callId === "string" && Array.isArray(p.content)) {
    for (const inner of p.content) {
      if (isIgnorableToolResultPart(inner as vscode.LanguageModelInputPart | LegacyPart)) {
        continue;
      }
      if (typeof inner === "object" && inner !== null && "value" in inner) {
        const value = (inner as { value?: unknown }).value;
        if (typeof value === "string") {
          results.push(value);
          continue;
        }
        if (value !== undefined) {
          try {
            results.push(JSON.stringify(value));
          } catch {
            results.push(String(value));
          }
          continue;
        }
      }
      const tv =
        getTextPartValue(inner as vscode.LanguageModelInputPart | LegacyPart) ??
        getDataPartTextValue(inner as vscode.LanguageModelInputPart | LegacyPart);
      if (tv !== undefined) {
        results.push(tv);
        continue;
      }
      debugLog("Unhandled tool result part", inner);
      try {
        results.push(JSON.stringify(inner));
      } catch {
        results.push(String(inner));
      }
    }
    return results;
  }
  return results;
}

function getToolResultEntries(
  parts: Array<vscode.LanguageModelInputPart | LegacyPart>,
): Array<{ callId: string; content: string }> {
  const entries: Array<{ callId: string; content: string }> = [];
  for (const part of parts) {
    const p = part as { callId?: string; content?: unknown[] };
    if (typeof p.callId === "string" && Array.isArray(p.content)) {
      const content = getToolResultTexts(part).join("\n").trim();
      entries.push({ callId: p.callId, content });
    }
  }
  return entries;
}

function buildToolDescription(
  description: string | undefined,
  inputSchema: unknown,
): string | undefined {
  const schema = asObjectRecord(inputSchema);
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];

  const guidance: string[] = [];
  if (schema?.type === "object") {
    guidance.push("Return a valid JSON object that matches this schema.");
    if (required.length > 0) {
      guidance.push(`Required arguments: ${required.join(", ")}.`);
      guidance.push("Do not call this tool with an empty object.");
    }

    const properties = asObjectRecord(schema.properties);
    const propertyNames = properties ? Object.keys(properties) : [];
    const highlightedNames = propertyNames
      .filter((name) => required.includes(name) || propertyNames.length <= 5)
      .slice(0, 5);
    if (highlightedNames.length > 0) {
      const propertyLines = highlightedNames.map((name) => {
        const propertySchema = asObjectRecord(properties?.[name]);
        const propertyType = typeof propertySchema?.type === "string" ? propertySchema.type : "any";
        const propertyDescription =
          typeof propertySchema?.description === "string" ? propertySchema.description.trim() : "";
        const enumValues = Array.isArray(propertySchema?.enum)
          ? propertySchema.enum.filter(
              (item): item is string => typeof item === "string" && item.length > 0,
            )
          : [];
        const enumGuidance =
          enumValues.length > 0 ? ` Allowed values: ${enumValues.join(", ")}.` : "";
        return propertyDescription
          ? `- ${name} (${propertyType}): ${propertyDescription}${enumGuidance}`
          : `- ${name} (${propertyType})${enumGuidance}`;
      });
      guidance.push(`Arguments:\n${propertyLines.join("\n")}`);
    }
  }

  const baseDescription = typeof description === "string" ? description.trim() : "";
  const guidanceText = guidance.join("\n");
  if (baseDescription && guidanceText) {
    return `${baseDescription}\n\n${guidanceText}`;
  }
  return baseDescription || guidanceText || undefined;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number },
): OcGoChatMessage[] {
  const result: OcGoChatMessage[] = [];

  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : msg.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "system";

    const textParts: string[] = [];
    const imageParts: OcGoContentPart[] = [];

    for (const part of msg.content) {
      if (getToolCallInfo(part) || getToolResultTexts(part).length > 0) {
        continue;
      }
      const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (tv !== undefined) {
        textParts.push(tv);
        continue;
      }
      const img = extractImageData(part);
      if (img) {
        const base64 = Buffer.from(img.data).toString("base64");
        imageParts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${base64}` },
        });
        continue;
      }
      console.warn("[OpenCode Go Provider] Unrecognized message part:", part);
    }

    // Handle tool calls
    const toolCalls = msg.content
      .map((p) => getToolCallInfo(p))
      .filter((t): t is { id?: string; name?: string; args?: Record<string, unknown> } => !!t);

    if (toolCalls.length > 0) {
      const assistantContent = textParts.join("");
      result.push({
        role: "assistant",
        content: assistantContent || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: {
            name: tc.name ?? "unknown",
            arguments: JSON.stringify(tc.args ?? {}),
          },
        })),
        reasoning_content: " ",
      });
    }

    // Handle tool results
    const toolResults = getToolResultEntries(
      msg.content as Array<vscode.LanguageModelInputPart | LegacyPart>,
    );
    for (const tr of toolResults) {
      let content = tr.content || "";
      if (options?.maxToolResultChars && content.length > options.maxToolResultChars) {
        content = content.slice(0, options.maxToolResultChars) + "…";
      }
      result.push({
        role: "tool",
        tool_call_id: tr.callId,
        content,
      });
    }

    const hasTextOrImage = textParts.length > 0 || imageParts.length > 0;
    const isAssistantWithToolCalls = role === "assistant" && toolCalls.length > 0;

    if (hasTextOrImage && !isAssistantWithToolCalls) {
      if (imageParts.length > 0) {
        const contentParts: OcGoContentPart[] = [];
        const text = textParts.join("");
        if (text) contentParts.push({ type: "text", text });
        contentParts.push(...imageParts);
        result.push(msg);
      } else {
        const msg: OcGoChatMessage = { role, content: textParts.join("") || "(empty message)" };
        result.push(msg);
      }
    } else if (!isAssistantWithToolCalls && toolResults.length === 0 && !hasTextOrImage) {
      result.push({ role, content: "(empty message)" });
    }
  }

  return result;
}

/**
 * Apply reasoning_content workaround for models that need it (e.g. Kimi K2.5/2.6).
 * These models may return incomplete responses when reasoning_content is absent.
 * A single space prevents this without polluting the actual output.
 */
export function applyReasoningContentWorkaround(
  messages: OcGoChatMessage[],
  modelId: string,
): OcGoChatMessage[] {
  if (!REASONING_CONTENT_WORKAROUND_MODELS.has(modelId)) {
    return messages;
  }

  return messages.map((msg) => {
    if (msg.role === "assistant" && !msg.reasoning_content) {
      return { ...msg, reasoning_content: " " };
    }
    return msg;
  })
  return result;
}

export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: OcGoTool[];
  tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    return {};
  }

  const tools: OcGoTool[] = toolsInput.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: buildToolDescription(tool.description, tool.inputSchema),
      parameters: tool.inputSchema as JsonObject,
    },
  }));

  if (
    options.toolMode ===
    (vscode as unknown as { LanguageModelChatToolMode?: { Required?: number } })
      .LanguageModelChatToolMode?.Required
  ) {
    return { tools, tool_choice: "required" };
  }

  return { tools };
}

export function estimateTokens(text: string): number {
  // Conservative heuristic: ~2 chars per token for mixed CJK/Latin text.
  // This intentionally overestimates English to avoid API context-window errors.
  return Math.ceil(text.length / 2);
}

export function estimateMessagesTokens(
  messages: readonly { content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.content) {
      const tv = getTextPartValue(part) ?? getDataPartTextValue(part);
      if (tv !== undefined) {
        total += estimateTokens(tv);
      }
    }
  }
  return total;
}

// ============================================================================
// Anthropic Messages API conversion helpers
// ============================================================================

/**
 * Parse a JSON string, returning a typed result object.
 */
export function tryParseJSONObject<T extends Json = Json>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (!text || !text.trim()) {
    return { ok: false, error: "Empty string" };
  }
  try {
    const value = JSON.parse(text) as T;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validate that a message array is non-empty and each message has content.
 */
export function validateRequest(
  messages:
    | readonly vscode.LanguageModelChatMessage[]
    | readonly { role: string; content: (vscode.LanguageModelInputPart | LegacyPart)[] }[],
): void {
  if (!messages || messages.length === 0) {
    throw new Error("Messages array is empty");
  }
  for (const msg of messages) {
    if (!msg.content || msg.content.length === 0) {
      throw new Error("Message has no content");
    }
  }
}

/**
 * Merge consecutive Anthropic messages with the same role.
 * Anthropic requires strictly alternating user/assistant roles.
 */
function mergeConsecutiveAnthropicMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;

  const result: AnthropicMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      const prevContent =
        typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : prev.content;
      const currContent =
        typeof curr.content === "string"
          ? [{ type: "text" as const, text: curr.content }]
          : curr.content;
      prev.content = [...prevContent, ...currContent];
    } else {
      result.push(curr);
    }
  }

  // Anthropic requires first message to be from user
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "(start of conversation)" });
  }

  return result;
}

/**
 * Convert VS Code LanguageModelChatMessage array to Anthropic Messages API format.
 *
 * Key differences from OpenAI format:
 * - System messages are extracted as a top-level `system` parameter
 * - Only `user` and `assistant` roles are allowed in messages
 * - Tool results use `role: "user"` with `content: [{type:"tool_result",...}]`
 * - Images use `{type:"image", source:{type:"base64",...}}` format
 */
export function convertMessagesToAnthropic(
  messages: readonly vscode.LanguageModelChatMessage[],
  options?: { maxToolResultChars?: number },
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
    const isAssistant = msg.role === vscode.LanguageModelChatMessageRole.Assistant;

    // Collect text parts
    const textParts: string[] = [];
    for (const part of msg.content) {
      const tv = getTextPartValue(part);
      if (tv !== undefined) textParts.push(tv);
    }

    // Collect images in Anthropic format
    const imageBlocks: AnthropicContentBlock[] = [];
    for (const part of msg.content) {
      const img = extractImageData(part);
      if (img && img.data && img.data.length > 0) {
        const base64Data = Buffer.from(img.data).toString("base64");
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: base64Data },
        });
      }
    }

    // Handle tool calls (assistant messages)
    const toolCalls = msg.content
      .map((p) => getToolCallInfo(p))
      .filter((t): t is { id?: string; name?: string; args?: Record<string, unknown> } => !!t);

    // Handle tool results (user messages)
    const toolResults = getToolResultEntries(
      msg.content as Array<vscode.LanguageModelInputPart | LegacyPart>,
    ).map((tr) =>
      options?.maxToolResultChars && tr.content.length > options.maxToolResultChars
        ? { ...tr, content: tr.content.slice(0, options.maxToolResultChars) + "…" }
        : tr,
    );

    // System messages → top-level system parameter
    if (!isUser && !isAssistant) {
      const text = textParts.join("");
      if (text) systemParts.push(text);
      continue;
    }

    const role: "user" | "assistant" = isUser ? "user" : "assistant";

    // Build content blocks
    const contentBlocks: AnthropicContentBlock[] = [];
    const textContent = textParts.join("");
    if (textContent) contentBlocks.push({ type: "text", text: textContent });
    contentBlocks.push(...imageBlocks);

    // Tool calls (assistant messages)
    if (isAssistant && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const inputObj: JsonObject =
          typeof tc.args === "string"
            ? (() => {
                try {
                  return JSON.parse(tc.args) as JsonObject;
                } catch {
                  return {} as JsonObject;
                }
              })()
            : ((tc.args as JsonObject) ?? ({} as JsonObject));
        contentBlocks.push({
          type: "tool_use",
          id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: tc.name ?? "unknown",
          input: inputObj,
        });
      }
    }

    // Tool results → user messages with tool_result blocks
    if (isUser && toolResults.length > 0) {
      for (const tr of toolResults) {
        result.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tr.callId, content: tr.content || "" }],
        });
      }
      // If there's also regular content, add as a separate user message
      if (contentBlocks.length > 0) {
        result.push({ role: "user", content: contentBlocks });
      }
      continue;
    }

    // Regular user/assistant message
    if (contentBlocks.length > 0) {
      if (
        contentBlocks.length === 1 &&
        contentBlocks[0].type === "text" &&
        imageBlocks.length === 0
      ) {
        result.push({ role, content: textContent });
      } else {
        result.push({ role, content: contentBlocks });
      }
    } else {
      result.push({ role, content: "(empty message)" });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: mergeConsecutiveAnthropicMessages(result),
  };
}

/**
 * Convert VS Code tools to Anthropic Messages API format.
 */
export function convertToolsToAnthropic(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: AnthropicTool[];
  tool_choice?: "auto" | "any" | { type: "tool"; name: string };
} {
  const toolsInput = options.tools ?? [];
  if (toolsInput.length === 0) {
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      throw new Error("LanguageModelChatToolMode.Required requires at least one tool.");
    }
    return {};
  }

  const tools: AnthropicTool[] = toolsInput.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema:
      (tool.inputSchema as JsonObject) ?? ({ type: "object", properties: {} } as JsonObject),
  }));

  let tool_choice: "auto" | "any" | { type: "tool"; name: string } = "auto";
  if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
    if (tools.length !== 1) {
      throw new Error(
        "LanguageModelChatToolMode.Required is not supported with more than one tool.",
      );
    }
    tool_choice = { type: "tool", name: tools[0].name };
  }

  return { tools, tool_choice };
}
