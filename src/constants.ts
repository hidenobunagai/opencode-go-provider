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
export const REASONING_CONTENT_WORKAROUND_MODELS = new Set(["kimi-k2.5", "kimi-k2.6"]);
