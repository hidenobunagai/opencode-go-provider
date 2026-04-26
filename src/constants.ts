// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { version: string };

export const BASE_URL = "https://opencode.ai/zen/go/v1";
export const EXTENSION_VERSION: string = pkg.version;

/** Safety margin for context window calculations (in tokens) */
export const CONTEXT_WINDOW_SAFETY_MARGIN = 4096;

/** Default token limit if model info is unknown */
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** Maximum retry delay in milliseconds */
export const MAX_RETRY_DELAY_MS = 30000;

/** Base retry delay in milliseconds */
export const BASE_RETRY_DELAY_MS = 1000;

/** Max tool result characters for Anthropic API */
export const ANTHROPIC_MAX_TOOL_RESULT_CHARS = 20000;

/** Models that require the reasoning_content workaround */
export const REASONING_CONTENT_WORKAROUND_MODELS = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

/** Map model IDs to tiktoken encoder names */
export const MODEL_TOKENIZER_MAP: Record<string, string> = {
  "glm-5": "gpt-4o",
  "glm-5.1": "gpt-4o",
  "kimi-k2.5": "gpt-4o",
  "kimi-k2.6": "gpt-4o",
  "mimo-v2-pro": "gpt-4o",
  "mimo-v2-omni": "gpt-4o",
  "mimo-v2.5-pro": "gpt-4o",
  "mimo-v2.5": "gpt-4o",
  "minimax-m2.5": "claude-3-haiku-20240307",
  "minimax-m2.7": "claude-3-haiku-20240307",
  "qwen3.5-plus": "gpt-4o",
  "qwen3.6-plus": "gpt-4o",
  "deepseek-v4-pro": "gpt-4o",
  "deepseek-v4-flash": "gpt-4o",
};
