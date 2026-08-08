# Supported Models

At runtime the extension fetches the available models from the OpenCode Go API (`GET /models`) and infers capabilities for each model ID (`inferModelInfo` in `src/types.ts`). When the fetch fails or no API key is configured yet, the bundled `FALLBACK_MODELS` array in `src/types.ts` is used instead. Each model has an `OcGoModelInfo` entry specifying capabilities, context window, and API format.

## Model List

### GLM Series (Zhipu AI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| GLM-5 | 202,752 | 131,072 | ✗ | ✓ | ✓ | OpenAI |
| GLM-5.1 | 202,752 | 131,072 | ✗ | ✓ | ✓ | OpenAI |
| GLM-5.2 | 202,752 | 131,072 | ✗ | ✓ | ✓ | OpenAI |

### Kimi Series (Moonshot AI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Kimi K2.5 | 262,144 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| Kimi K2.6 | 262,144 | 262,144 | ✓ | ✓ | ✓ | OpenAI |
| Kimi K2.7 Code | 262,144 | 262,144 | ✓ | ✓ | ✓ | OpenAI |
| Kimi K3 | 1,000,000 | 262,144 | ✓ | ✓ | ✓ | OpenAI |

> **Note**: Kimi models use `fixedTemperature: 1` for optimal performance. Kimi K2.5 also sends `top_p: 0.95`, matching the OpenCode CLI's per-model sampling defaults.
> Kimi models other than K2.5 (K2.6, K2.7 Code, K3, ...) require `REASONING_CONTENT_WORKAROUND_MODELS` for correct streaming output.

### MiMo Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| MiMo-V2-Pro | 1,048,576 | 131,072 | ✗ | ✓ | ✓ | OpenAI |
| MiMo-V2-Omni | 262,144 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| MiMo-V2.5-Pro | 1,048,576 | 131,072 | ✓ | ✓ | ✓ | OpenAI |
| MiMo-V2.5 | 262,144 | 65,536 | ✓ | ✓ | ✓ | OpenAI |

### MiniMax Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| MiniMax M2.5 | 196,608 | 131,072 | ✗ | ✓ | ✗ | Anthropic |
| MiniMax M2.7 | 196,608 | 131,072 | ✗ | ✓ | ✗ | Anthropic |
| MiniMax M3 | 196,608 | 131,072 | ✗ | ✓ | ✗ | Anthropic |

> **Note**: MiniMax models use the **Anthropic Messages API** (`apiFormat: "anthropic"`). Tool calls and results use Anthropic's `tool_use` / `tool_result` block format rather than OpenAI's function calling. M2.5/M2.7 send `temperature: 1` and `top_p: 0.95`, matching the OpenCode CLI's defaults; M3 leaves sampling to the provider default.

### Qwen Series (Alibaba)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Qwen3.5 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| Qwen3.6 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| Qwen3.7 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| Qwen3.7 Max | 1,000,000 | 65,536 | ✓ | ✓ | ✓ | OpenAI |
| Qwen3.8 Max | 1,000,000 | 65,536 | ✓ | ✓ | ✓ | OpenAI |

> **Note**: Qwen models have a 1M context window — the largest in the lineup. The dynamic safety margin scales proportionally (~10,240 tokens). They send `temperature: 0.55` and `top_p: 1`, matching the OpenCode CLI's defaults.

### DeepSeek Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| DeepSeek V4 Pro | 262,144 | 65,536 | ✗ | ✓ | ✓ | OpenAI |
| DeepSeek V4 Flash | 262,144 | 65,536 | ✗ | ✓ | ✓ | OpenAI |

> **Note**: DeepSeek models require `REASONING_CONTENT_WORKAROUND_MODELS` for correct streaming output. System prompts are sanitized to replace "Claude"/"Anthropic" references.

### Grok Series (xAI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Grok 4.5 | 500,000 | 65,536 | ✓ | ✓ | ✗ | OpenAI |

### GPT Series (OpenAI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| GPT 5.6 Luna | 400,000 | 128,000 | ✓ | ✓ | ✓ | Responses |

> **Note**: GPT 5.6 Luna uses the **OpenAI Responses API** (`apiFormat: "responses"`) served from the `/responses` endpoint. Messages are converted to Responses input items (`message` / `function_call` / `function_call_output`), tool calls use `function_call` items, and reasoning is streamed via `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`. `max_output_tokens` is used instead of `max_tokens` / `max_completion_tokens`.

### HY3 Preview

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Hy3 | 262,144 | 65,536 | ✗ | ✓ | ✓ | OpenAI |
| HY3 Preview | 262,144 | 65,536 | ✗ | ✓ | ✓ | OpenAI |

> **Note**: `hy3` is the current model ID; `hy3-preview` is kept for backward compatibility.

## Model Quirks & Workarounds

The extension applies several model-behavior workarounds while streaming. This matrix summarizes which workaround applies to which model family, and where it lives:

| Workaround | Applies to | Where |
|------------|-----------|-------|
| `reasoning_content` field added to assistant history, and parsed from streaming deltas | Kimi (except K2.5), DeepSeek V4+ (`REASONING_CONTENT_WORKAROUND_MODELS`) | `constants.ts`, `openai-conversion.ts` |
| Responses API (`/responses`) instead of OpenAI chat.completions | GPT 5.6 Luna (`apiFormat: "responses"`) | `responses-conversion.ts`, `streaming/responses.ts` |
| `fixedTemperature` / `fixedTopP` sent on every request | Kimi (temp 1), Qwen (0.55 / top_p 1), MiniMax M2 (1 / 0.95), Kimi K2.5 (top_p 0.95) | `types.ts` |
| Anthropic Messages API instead of OpenAI format | MiniMax (`apiFormat: "anthropic"`) | `anthropic-conversion.ts`, `streaming/anthropic.ts` |
| System prompt sanitization ("Claude" → "GitHub Copilot") and provider identity guidance | DeepSeek | `guidance.ts` |
| Tool-use grounding guidance injected into the system prompt | All models, when tools are present | `guidance.ts` |
| Text-embedded tool call parsing (`<\|tool_call_begin\|>`, XML `<tool_calls>`) | All models (streaming) | `tool-parser.ts` |
| Tool call dedup and argument repair from chat context | All models | `tool-repair.ts` |
| Action-announcement nudge (response ends announcing an action without a tool call) | All models, when tools are present | `announcement.ts`, `streaming/*.ts` |
| `reasoning_effort: "low"` forced on retries when Thinking Effort is "Default" | Thinking models | `streaming/openai.ts` |
| Vision fallback: separate image analysis or model switch for image input | Models without native vision | `provider.ts`, `vision.ts`, `tools.ts` |

When adding a new model, check this matrix first and prefer registering quirks in the listed location over inventing a new mechanism.

## Capability Matrix

### Thinking (Reasoning Effort)

Models with `supportsThinking: true` show a **Thinking Effort** dropdown in the model picker. This controls the `reasoning_effort` parameter, allowing users to trade reasoning depth for speed:

- `xhigh` — Maximum reasoning
- `high` — Strong reasoning
- `medium` — Balanced (default)
- `low` — Reduced reasoning
- `minimal` — Minimal reasoning
- `none` — No reasoning

All models in the current lineup support thinking except MiniMax models and Grok 4.5. For Responses-API models (GPT 5.6 Luna) the effort is sent as `reasoning.effort` (with `max` mapped to the Responses-API `high` level, since `xhigh` is not supported).

### Vision

Models with `supportsVision: true` natively accept image input via `image_url` content parts.

For non-vision models, the `opencode_go_analyze_image` language model tool provides vision capabilities through a separate API call. When a user attaches an image to a chat with a non-vision model, the extension:
1. Detects the image input
2. Calls the vision API separately
3. Injects the text description into the conversation

### Tools (Function Calling)

All models support tool/function calling. The extension:
- Parses tool calls from streaming text output (`tool-parser.ts`)
- Deduplicates repeated tool calls (`tool-repair.ts`)
- Repairs missing/invalid arguments using `inputSchema` and chat context
- Supports both text-embedded (`<|tool_call_begin|>`) and XML-style (`<tool_calls>`) tool call formats

## Context Window Management

Each model's `contextWindow` is used to:

1. **Calculate max output tokens**: `maxOutput` or `DEFAULT_MAX_OUTPUT_TOKENS` (65,536), whichever is smaller.
2. **Apply safety margin**: Dynamic margin = `max(2048, floor(contextWindow * 0.01))`.
3. **Cap tool results**: `calculateMaxToolResultChars()` returns 10,000–50,000 chars based on context window size.

## Sampling Parameters

The extension mirrors the OpenCode CLI's per-model sampling defaults so model output matches what you get when using the same models in OpenCode:

| Model | temperature | top_p |
|-------|-------------|-------|
| Qwen3.5/3.6/3.7/3.8 Plus/Max | 0.55 | 1 |
| MiniMax M2.5, M2.7 | 1 | 0.95 |
| Kimi K2.5, K2.6, K2.7 Code, K3 | 1 | K2.5: 0.95, others: unset |
| GLM-5.x, DeepSeek V4, MiMo, Grok, MiniMax M3, Hy3, GPT 5.6 Luna | unset (provider default) | unset |

When a model has no fixed values and the user has not set a temperature in the model options, the request omits `temperature` entirely so the server-side default applies — same as the OpenCode CLI. Requests always use `max_tokens` (the zen/go proxy ignores `max_completion_tokens`); thinking models enforce a 16K output-budget floor.

## Adding Models

See [Contributing: Adding a New Model](./contributing.md#adding-a-new-model).
