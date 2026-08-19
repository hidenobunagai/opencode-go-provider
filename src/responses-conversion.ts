// responses-conversion.ts — OpenAI Responses API message/tool conversion
// Used by GPT 5.6 Luna via the OpenCode Go proxy (/responses endpoint).
import * as vscode from "vscode";
import { convertTools } from "./openai-conversion";
import {
  OcGoChatMessage,
  OcGoContentPart,
  OcGoResponsesContentPart,
  OcGoResponsesInputItem,
  OcGoResponsesTool,
} from "./types";

/** Convert an OcGoContentPart[] into Responses API content parts. */
function convertContentParts(parts: OcGoContentPart[]): OcGoResponsesContentPart[] {
  const result: OcGoResponsesContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      result.push({ type: "input_text", text: part.text });
    } else if (part.type === "image_url" && part.image_url?.url) {
      result.push({ type: "input_image", image_url: part.image_url.url });
    }
  }
  return result;
}

/**
 * Convert chat messages into Responses API input items plus instructions.
 * System messages are hoisted into the top-level `instructions` field; tool
 * calls become `function_call` items and tool results become
 * `function_call_output` items.
 */
export function convertMessagesToResponses(apiMessages: OcGoChatMessage[]): {
  input: OcGoResponsesInputItem[];
  instructions?: string;
} {
  const instructions: string[] = [];
  const input: OcGoResponsesInputItem[] = [];

  for (const message of apiMessages) {
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.trim().length > 0) {
        instructions.push(message.content);
      }
      continue;
    }

    if (message.role === "tool") {
      if (typeof message.tool_call_id === "string") {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: typeof message.content === "string" ? message.content : "",
        });
      }
      continue;
    }

    const isAssistant = message.role === "assistant";
    const content =
      typeof message.content === "string" ? message.content : convertContentParts(message.content);

    if (isAssistant) {
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: typeof content === "string" && content.length > 0 ? content : [],
        });
        for (const toolCall of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          });
        }
      } else if (content !== undefined && content !== "") {
        input.push({ type: "message", role: "assistant", content });
      }
    } else if (content !== undefined && content !== "") {
      input.push({ type: "message", role: "user", content });
    }
  }

  return {
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
  };
}

/** Convert VS Code tool options into Responses API tools + tool_choice. */
export function convertToolsToResponses(options: vscode.ProvideLanguageModelChatResponseOptions): {
  tools?: OcGoResponsesTool[];
  tool_choice?: "auto" | "required" | { type: "function"; name: string };
} {
  const openAiConfig = convertTools(options);
  if (!openAiConfig.tools || openAiConfig.tools.length === 0) {
    return {};
  }

  const tools: OcGoResponsesTool[] = openAiConfig.tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    // Some VS Code tools carry no inputSchema. OpenAI's Responses API accepts
    // a function tool without `parameters`, but strict backends (e.g. Meta's
    // Muse Spark via the /responses endpoint) reject it with
    // "did not match any supported type". Default it to an empty object schema.
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));

  let tool_choice: "auto" | "required" | { type: "function"; name: string } = "auto";
  if (openAiConfig.tool_choice === "required") {
    tool_choice = "required";
  } else if (
    typeof openAiConfig.tool_choice === "object" &&
    openAiConfig.tool_choice.type === "function"
  ) {
    tool_choice = {
      type: "function",
      name: openAiConfig.tool_choice.function.name,
    };
  }

  return { tools, tool_choice };
}
