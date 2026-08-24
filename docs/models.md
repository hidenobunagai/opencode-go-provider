# Supported Models

At runtime the extension fetches the available models from the OpenCode Go API (`GET /models`) and infers capabilities for each model ID (`inferModelInfo` in `src/types.ts`). When the fetch fails or no API key is configured yet, the bundled `FALLBACK_MODELS` array in `src/types.ts` is used instead. Each model has an `OcGoModelInfo` entry specifying capabilities, context window, and API format.

## Model List

### GLM Series (Zhipu AI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| GLM-5 | 202,752 | 131,072 | ✗ | ✓ | ✓ (`high,max`) | OpenAI |
| GLM-5.1 | 202,752 | 32,768 | ✗ | ✓ | ✓ (`high,max`) | OpenAI |
| GLM-5.2 | 1,000,000 | 131,072 | ✗ | ✓ | ✓ (`high,max`) | OpenAI |
| GLM-5.3 | 1,000,000 | 131,072 | ✗ | ✓ | ✓ (`low,high,max`) | OpenAI |

### Kimi Series (Moonshot AI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Kimi K2.5 | 262,144 | 65,536 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| Kimi K2.6 | 262,144 | 65,536 | ✓ | ✓ | ✗ | OpenAI |
| Kimi K2.7 Code | 262,144 | 262,144 | ✓ | ✓ | ✗ | OpenAI |
| Kimi K3 | 1,048,576 | 131,072 | ✓ | ✓ | ✓ (`max`) | OpenAI |

> **Note**: Kimi models use `fixedTemperature: 1` for optimal performance. Kimi K2.5 also sends `top_p: 0.95`, matching the OpenCode CLI's per-model sampling defaults.
> Kimi models other than K2.5 (K2.6, K2.7 Code, K3, ...) require `REASONING_CONTENT_WORKAROUND_MODELS` for correct streaming output.

### MiMo Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| MiMo-V2-Pro | 1,048,576 | 131,072 | ✗ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| MiMo-V2-Omni | 262,144 | 65,536 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| MiMo-V2.5-Pro | 1,048,576 | 128,000 | ✗ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| MiMo-V2.5 | 1,000,000 | 128,000 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |

### MiniMax Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| MiniMax M2.5 | 196,608 | 131,072 | ✗ | ✓ | ✗ | Anthropic |
| MiniMax M2.7 | 204,800 | 131,072 | ✗ | ✓ | ✗ | Anthropic |
| MiniMax M3 | 1,000,000 | 131,072 | ✓ | ✓ | ✗ | Anthropic |

> **Note**: MiniMax models use the **Anthropic Messages API** (`apiFormat: "anthropic"`). Tool calls and results use Anthropic's `tool_use` / `tool_result` block format rather than OpenAI's function calling. M2.5/M2.7 send `temperature: 1` and `top_p: 0.95`, matching the OpenCode CLI's defaults; M3 leaves sampling to the provider default.

### Qwen Series (Alibaba)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Qwen3.5 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| Qwen3.6 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| Qwen3.7 Plus | 1,000,000 | 65,536 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| Qwen3.7 Max | 1,000,000 | 65,536 | ✗ | ✓ | ✓ (`low,medium,high`) | OpenAI |
| Qwen3.8 Max | 1,000,000 | 131,072 | ✓ | ✓ | ✓ (`low,medium,high`) | OpenAI |

> **Note**: Qwen models have a 1M context window — the largest in the lineup. The dynamic safety margin scales proportionally (~10,240 tokens). They send `temperature: 0.55` and `top_p: 1`, matching the OpenCode CLI's defaults.

### DeepSeek Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| DeepSeek V4 Pro | 1,000,000 | 384,000 | ✗ | ✓ | ✓ (`high,max`) | OpenAI |
| DeepSeek V4 Flash | 1,000,000 | 384,000 | ✗ | ✓ | ✓ (`low,high,max`) | OpenAI |
| DeepSeek V4 Flash Vision Exp | 1,000,000 | 384,000 | ✓ | ✓ | ✓ (`low,high,max`) | OpenAI |

> **Note**: DeepSeek models require `REASONING_CONTENT_WORKAROUND_MODELS` for correct streaming output. System prompts are sanitized to replace "Claude"/"Anthropic" references.

### Grok Series (xAI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Grok 4.5 | 500,000 | 500,000 | ✓ | ✓ | ✓ (`low,medium,high`) | Responses |

### GPT Series (OpenAI)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| GPT 5.6 Luna | 1,050,000 | 128,000 | ✓ | ✓ | ✓ (`low,medium,high,xhigh,max`) | Responses |

> **Note**: GPT 5.6 Luna uses the **OpenAI Responses API** (`apiFormat: "responses"`) served from the `/responses` endpoint. Messages are converted to Responses input items (`message` / `function_call` / `function_call_output`), tool calls use `function_call` items, and reasoning is streamed via `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`. `max_output_tokens` is used instead of `max_tokens` / `max_completion_tokens`.

### Muse Series (Meta)

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Muse Spark 1.2 Contributor | 1,048,576 | 131,072 | ✓ | ✓ | ✓ (`minimal,low,medium,high,xhigh`) | Responses |

> **Note**: Muse Spark 1.2 Contributor uses the **OpenAI Responses API** (`apiFormat: "responses"`) served from the `/responses` endpoint, same as GPT 5.6 Luna. It has a 1M context window — the largest in the lineup — with text and image input. The Contributor tier offers heavily discounted token pricing in exchange for permission to use prompts/completions to train future Meta models.

### HY3 Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Hy3 | 256,000 | 64,000 | ✗ | ✓ | ✓ (`low,high`) | OpenAI |
| HY3 Preview | 256,000 | 64,000 | ✗ | ✓ | ✓ (`low,high`) | OpenAI |

### LongCat Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| LongCat 2.0 | 1,000,000 | 131,072 | ✗ | ✓ | ✓ (`low,medium,high`) | OpenAI |

### Ox Series

| Model | Context | Max Output | Vision | Tools | Thinking | API |
|-------|---------|------------|--------|-------|----------|-----|
| Ox Alpha Free | 1,000,000 | 131,072 | ✓ | ✓ | ✓ (`low,high,max`) | OpenAI |

> **Note**: `hy3` is the current model ID; `hy3-preview` is kept for backward compatibility.

## Model Quirks & Workarounds

The extension applies several model-behavior workarounds while streaming. This matrix summarizes which workaround applies to which model family, and where it lives:

| Workaround | Applies to | Where |
|------------|-----------|-------|
| `reasoning_content` field added to assistant history, and parsed from streaming deltas | Kimi (except K2.5), DeepSeek V4+ (`REASONING_CONTENT_WORKAROUND_MODELS`) | `constants.ts`, `openai-conversion.ts` |
| Responses API (`/responses`) instead of OpenAI chat.completions | GPT 5.6 Luna, Muse Spark 1.2 Contributor (`apiFormat: "responses"`) | `responses-conversion.ts`, `streaming/responses.ts` |
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

Models with `supportsThinking: true` show a **Thinking Effort** dropdown in the model picker. This controls the `reasoning_effort` parameter, allowing users to trade reasoning depth for speed. The available levels are **per-model**, synced from `pi-ai`'s `thinkingLevelMap` for `opencode-go` (see `src/types.ts`):

- `minimal` — Minimal reasoning (e.g. Muse Spark)
- `low` — Reduced reasoning
- `medium` — Balanced
- `high` — Strong reasoning
- `xhigh` — Extra-high reasoning (e.g. Muse, GPT Luna)
- `max` — Maximum reasoning (e.g. DeepSeek, GPT Luna, Kimi K3)

Examples (see tables above for the full list):

- `muse-spark-1.2-contributor`: `minimal,low,medium,high,xhigh` — **no `max`**
- `grok-4.5` / `longcat-2.0`: `low,medium,high` — **no `xhigh`/`max`**
- `deepseek-v4-flash`: `low,high,max` — **no `medium`/`xhigh`**
- `gpt-5.6-luna`: `low,medium,high,xhigh,max` — all levels
- `kimi-k2.6` / `kimi-k2.7-code` / MiniMax: **no thinking UI** (`supportsThinking: false`)

For Responses-API models (`grok-4.5`, `gpt-5.6-luna`, `muse-spark-1.2-contributor`) the effort is sent as `reasoning.effort` with `summary: "auto"`; for OpenAI `chat.completions` models it is sent as `reasoning_effort`. The extension validates the selection per model and drops unsupported values (with `max<->xhigh` alias for stale configs).

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
| GLM-5.x, DeepSeek V4, MiMo, Grok, MiniMax M3, Hy3, GPT 5.6 Luna, Muse Spark 1.2 Contributor | unset (provider default) | unset |

When a model has no fixed values and the user has not set a temperature in the model options, the request omits `temperature` entirely so the server-side default applies — same as the OpenCode CLI. Requests always use `max_tokens` (the zen/go proxy ignores `max_completion_tokens`); thinking models enforce a 16K output-budget floor.

## Adding Models

See [Contributing: Adding a New Model](./contributing.md#adding-a-new-model).
