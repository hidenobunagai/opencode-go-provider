export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface OcGoContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OcGoChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OcGoContentPart[];
  name?: string;
  tool_calls?: OcGoToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OcGoToolCall {
  id: string;
  /** Optional index used in streaming tool call deltas */
  index?: number;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OcGoTool {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonObject };
}

export interface OcGoChatRequest {
  model: string;
  messages: OcGoChatMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  top_p?: number;
  stop?: string | string[];
  tools?: OcGoTool[];
  tool_choice?: "auto" | "none" | "required" | { type: string; function: { name: string } };
  reasoning_effort?: string;
}

export interface OcGoStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: OcGoToolCall[];
  };
  finish_reason: string | null;
}

export interface OcGoStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OcGoStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OcGoChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** API format used by a model */
export type OcGoApiFormat = "openai" | "anthropic" | "responses";

/** Reasoning effort level for models that support it (e.g. DeepSeek) */
export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "max";

/** Ordered list for UI and fallback logic */
export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface OcGoModelInfo {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** API format: "openai" (default) or "anthropic" (MiniMax models) */
  apiFormat?: OcGoApiFormat;
  /** If set, this exact temperature value is sent for every request */
  fixedTemperature?: number;
  /**
   * If set, this exact top_p value is sent for every request.
   * Matches the OpenCode CLI's per-model sampling defaults
   * (e.g. qwen top_p=1, kimi-k2.5 / minimax-m2 top_p=0.95).
   */
  fixedTopP?: number;
  /** If true, a Thinking Effort dropdown is shown in the model picker */
  supportsThinking?: boolean;
  /** Per-model allowed reasoning efforts (excluding "default"). If undefined and supportsThinking, generic fallback is used. */
  supportedReasoningEfforts?: ReasoningEffort[];
}

export const FALLBACK_MODELS: OcGoModelInfo[] = [
  {
    id: "glm-5",
    name: "GLM-5",
    displayName: "GLM-5",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["high", "max"],
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    displayName: "GLM-5.1",
    contextWindow: 202752,
    maxOutput: 32768,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["high", "max"],
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    displayName: "GLM-5.2",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["high", "max"],
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    displayName: "GLM-5.3",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high", "max"],
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    displayName: "Kimi K2.5",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
    fixedTopP: 0.95,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    displayName: "Kimi K2.6",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
    supportsThinking: false,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    displayName: "Kimi K2.7 Code",
    contextWindow: 262144,
    maxOutput: 262144,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
    supportsThinking: false,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    displayName: "Kimi K3",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["max"],
  },
  {
    id: "mimo-v2-pro",
    name: "MiMo-V2-Pro",
    displayName: "MiMo-V2-Pro",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "mimo-v2-omni",
    name: "MiMo-V2-Omni",
    displayName: "MiMo-V2-Omni",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    displayName: "MiMo-V2.5-Pro",
    contextWindow: 1048576,
    maxOutput: 128000,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    displayName: "MiMo-V2.5",
    contextWindow: 1000000,
    maxOutput: 128000,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    displayName: "MiniMax M2.5",
    contextWindow: 196608,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "anthropic",
    fixedTemperature: 1,
    fixedTopP: 0.95,
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    displayName: "MiniMax M2.7",
    contextWindow: 204800,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "anthropic",
    fixedTemperature: 1,
    fixedTopP: 0.95,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "anthropic",
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    displayName: "Qwen3.5 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 0.55,
    fixedTopP: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    displayName: "Qwen3.6 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 0.55,
    fixedTopP: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    displayName: "Qwen3.7 Plus",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 0.55,
    fixedTopP: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    displayName: "Qwen3.7 Max",
    contextWindow: 1000000,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    fixedTemperature: 0.55,
    fixedTopP: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    displayName: "Qwen3.8 Max",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    fixedTemperature: 0.55,
    fixedTopP: 1,
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1000000,
    maxOutput: 384000,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["high", "max"],
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxOutput: 384000,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high", "max"],
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision Exp",
    displayName: "DeepSeek V4 Flash Vision Exp",
    contextWindow: 1000000,
    maxOutput: 384000,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high", "max"],
  },
  {
    id: "hy3",
    name: "Hy3",
    displayName: "Hy3",
    contextWindow: 256000,
    maxOutput: 64000,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high"],
  },
  {
    id: "hy3-preview",
    name: "HY3 Preview",
    displayName: "HY3 Preview",
    contextWindow: 256000,
    maxOutput: 64000,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high"],
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    displayName: "Grok 4.5",
    contextWindow: 500000,
    maxOutput: 500000,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "responses",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    displayName: "GPT 5.6 Luna",
    contextWindow: 1050000,
    maxOutput: 128000,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "responses",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "ox-alpha-free",
    name: "Ox Alpha Free",
    displayName: "Ox Alpha Free",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "high", "max"],
  },
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    displayName: "Muse Spark 1.2 Contributor",
    contextWindow: 1048576,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: true,
    apiFormat: "responses",
    supportsThinking: true,
    supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "longcat-2.0",
    name: "LongCat 2.0",
    displayName: "LongCat 2.0",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
    apiFormat: "openai",
    supportsThinking: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
];

export function inferModelInfo(id: string): OcGoModelInfo {
  const known = FALLBACK_MODELS.find((m) => m.id === id);
  if (known) {
    return known;
  }

  const isKimi = id.startsWith("kimi-");
  const isGlm = id.startsWith("glm-");
  const isMinimax = id.startsWith("minimax-");
  const isDeepseek = id.startsWith("deepseek-");
  const isQwen = id.startsWith("qwen");
  const isMimo = id.startsWith("mimo-");
  const isHy3 = id === "hy3" || id.startsWith("hy3-");
  const isGrok = id.startsWith("grok-");
  const isGpt = id.startsWith("gpt-5.6");
  const isMuse = id.startsWith("muse-");
  const isLongcat = id.startsWith("longcat-");
  const isOx = id.startsWith("ox-");

  let contextWindow = 262144;
  let maxOutput = 65536;
  const supportsTools = true;
  let supportsVision = false;
  let apiFormat: OcGoApiFormat = "openai";
  let fixedTemperature: number | undefined = undefined;
  let fixedTopP: number | undefined = undefined;
  let supportsThinking = false;
  let supportedReasoningEfforts: ReasoningEffort[] | undefined = undefined;

  if (isMinimax) {
    apiFormat = "anthropic";
    if (id === "minimax-m3") {
      contextWindow = 1000000;
      supportsVision = true;
    } else if (id.includes("m2.7")) {
      contextWindow = 204800;
    } else {
      contextWindow = 196608;
    }
    maxOutput = 131072;
    if (id.includes("m2")) {
      fixedTemperature = 1;
      fixedTopP = 0.95;
    }
    // MiniMax: no reasoning ui (anthropic adaptive thinking is internal)
  } else if (isKimi) {
    fixedTemperature = 1;
    if (id.includes("k2.5")) {
      fixedTopP = 0.95;
      supportsVision = true;
      supportsThinking = true;
      supportedReasoningEfforts = ["low", "medium", "high"];
      contextWindow = 262144;
      maxOutput = 65536;
    } else if (id.includes("k2.6")) {
      supportsVision = true;
      supportsThinking = false;
      contextWindow = 262144;
      maxOutput = 65536;
    } else if (id.includes("k2.7")) {
      supportsVision = true;
      supportsThinking = false;
      contextWindow = 262144;
      maxOutput = 262144;
    } else if (id.includes("k3")) {
      supportsVision = true;
      supportsThinking = true;
      supportedReasoningEfforts = ["max"];
      contextWindow = 1048576;
      maxOutput = 131072;
    } else {
      supportsVision = true;
      supportsThinking = true;
      supportedReasoningEfforts = ["low", "medium", "high"];
      contextWindow = 262144;
      maxOutput = 262144;
    }
  } else if (isGlm) {
    supportsThinking = true;
    contextWindow = id.includes("5.3") ? 1000000 : id.includes("5.2") ? 1000000 : 202752;
    maxOutput = id.includes("5.1") ? 32768 : 131072;
    if (id.includes("5.3")) {
      supportedReasoningEfforts = ["low", "high", "max"];
    } else if (id.includes("5.2") || id === "glm-5" || id.includes("5.1")) {
      supportedReasoningEfforts = ["high", "max"];
    }
  } else if (isDeepseek) {
    supportsThinking = true;
    supportsVision = id.includes("vision");
    contextWindow = 1000000;
    maxOutput = 384000;
    if (id.includes("v4-pro")) {
      supportedReasoningEfforts = ["high", "max"];
    } else {
      supportedReasoningEfforts = ["low", "high", "max"];
    }
  } else if (isQwen) {
    fixedTemperature = 0.55;
    fixedTopP = 1;
    supportsVision = true;
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "medium", "high"];
    contextWindow = 1000000;
    maxOutput = id.includes("3.8") ? 131072 : 65536;
  } else if (isMimo) {
    supportsThinking = true;
    supportsVision = !id.includes("v2-pro");
    contextWindow = id.includes("pro") ? 1048576 : 1000000;
    maxOutput = id.includes("pro") ? 128000 : 128000;
    supportedReasoningEfforts = ["low", "medium", "high"];
  } else if (isHy3) {
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "high"];
    contextWindow = 256000;
    maxOutput = 64000;
  } else if (isGrok) {
    // grok-4.5 uses Responses API in Pi (openai-responses)
    apiFormat = "responses";
    supportsVision = true;
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "medium", "high"];
    contextWindow = 500000;
    maxOutput = 500000;
  } else if (isGpt) {
    apiFormat = "responses";
    supportsVision = true;
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "medium", "high", "xhigh", "max"];
    contextWindow = 1050000;
    maxOutput = 128000;
  } else if (isMuse) {
    apiFormat = "responses";
    supportsVision = true;
    supportsThinking = true;
    supportedReasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"];
    contextWindow = 1048576;
    maxOutput = 131072;
  } else if (isLongcat) {
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "medium", "high"];
    contextWindow = 1000000;
    maxOutput = 131072;
  } else if (isOx) {
    supportsVision = true;
    supportsThinking = true;
    supportedReasoningEfforts = ["low", "high", "max"];
    contextWindow = 1000000;
    maxOutput = 131072;
  }

  const displayName = id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return {
    id,
    name: displayName,
    displayName,
    contextWindow,
    maxOutput,
    supportsTools,
    supportsVision,
    apiFormat,
    fixedTemperature,
    fixedTopP,
    supportsThinking,
    ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
  };
}

// ============================================================================
// Anthropic Messages API types
// Used by MiniMax M2.5 and M2.7 via OpenCode Go proxy
// ============================================================================

/** Anthropic message content block */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] };

/** Anthropic message format */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
  reasoning_content?: string;
}

/** Anthropic tool definition */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

/** Anthropic request body */
export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: "auto" | "any" | { type: "tool"; name: string };
}

/** Anthropic SSE event types */
export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string };
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage: { output_tokens: number };
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export type AnthropicSSEEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent;

// ============================================================================
// OpenAI Responses API types
// Used by GPT 5.6 Luna via the OpenCode Go proxy (/responses endpoint)
// ============================================================================

/** Content part inside a Responses API message item */
export type OcGoResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

/** Input item for the Responses API */
export type OcGoResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: string | OcGoResponsesContentPart[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Function tool definition for the Responses API */
export interface OcGoResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: JsonObject;
}

/** Responses API request body */
export interface OcGoResponsesRequest {
  model: string;
  instructions?: string;
  input: OcGoResponsesInputItem[];
  tools?: OcGoResponsesTool[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; name: string };
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  store?: boolean;
  reasoning?: { effort?: string; summary?: string };
}

/** Responses API SSE stream event */
export interface OcGoResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    status?: string;
    role?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
  };
  error?: { message?: string; code?: string };
}
