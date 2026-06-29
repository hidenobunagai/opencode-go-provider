import { version } from "../package.json";

export const BASE_URL = "https://opencode.ai/zen/go/v1";
export const EXTENSION_VERSION: string = version;

/** Safety margin for context window calculations (in tokens).
 * Fallback value used when model context window is unknown. */
export const CONTEXT_WINDOW_SAFETY_MARGIN = 4096;

/** Compute a dynamic safety margin: 1% of context window, minimum 2048 tokens.
 * Larger models need proportionally larger margins for system overhead. */
export function getContextWindowSafetyMargin(contextWindow: number): number {
  return Math.max(2048, Math.floor(contextWindow * 0.01));
}

/** Default token limit if model info is unknown */
export const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

/** Maximum retry delay in milliseconds */
export const MAX_RETRY_DELAY_MS = 30000;

/** Base retry delay in milliseconds */
export const BASE_RETRY_DELAY_MS = 1000;

/** Request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 120000;

/**
 * Per-read timeout for SSE stream reads (milliseconds).
 * Prevents infinite hangs when the server pauses mid-stream or the
 * connection silently drops.  The reader races against this timeout;
 * if it fires, the stream is cancelled and the generator exits so
 * the retry loop can re-establish a new connection.
 */
export const STREAM_READ_TIMEOUT_MS = 60000;

/** Max tool result characters for Anthropic API */
export const ANTHROPIC_MAX_TOOL_RESULT_CHARS = 20000;

/** Models that require the reasoning_content workaround */
export const REASONING_CONTENT_WORKAROUND_MODELS = new Set([
  "kimi-k2.6",
  "kimi-k2.7-code",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

/** Map model IDs to tiktoken encoder names */
export const MODEL_TOKENIZER_MAP: Record<string, string> = {
  "glm-5": "gpt-4o",
  "glm-5.1": "gpt-4o",
  "glm-5.2": "gpt-4o",
  "kimi-k2.5": "gpt-4o",
  "kimi-k2.6": "gpt-4o",
  "kimi-k2.7-code": "gpt-4o",
  "mimo-v2-pro": "gpt-4o",
  "mimo-v2-omni": "gpt-4o",
  "mimo-v2.5-pro": "gpt-4o",
  "mimo-v2.5": "gpt-4o",
  "minimax-m2.5": "gpt-4o",
  "minimax-m2.7": "gpt-4o",
  "minimax-m3": "gpt-4o",
  "qwen3.5-plus": "gpt-4o",
  "qwen3.6-plus": "gpt-4o",
  "qwen3.7-plus": "gpt-4o",
  "qwen3.7-max": "gpt-4o",
  "deepseek-v4-pro": "gpt-4o",
  "deepseek-v4-flash": "gpt-4o",
  "hy3-preview": "gpt-4o",
};
