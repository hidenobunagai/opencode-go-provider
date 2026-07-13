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
export const REASONING_CONTENT_WORKAROUND_MODELS = {
  has(modelId: string): boolean {
    const staticSet = new Set([
      "kimi-k2.6",
      "kimi-k2.7-code",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
    if (staticSet.has(modelId)) {
      return true;
    }
    if (modelId.startsWith("kimi-")) {
      return !modelId.includes("k2.5");
    }
    if (modelId.startsWith("deepseek-")) {
      const match = modelId.match(/deepseek-v(\d+)/);
      if (match) {
        const version = parseInt(match[1], 10);
        return version >= 4;
      }
      return modelId.includes("-r1") || modelId.includes("-r2");
    }
    return false;
  },
};
