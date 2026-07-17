# Architecture

## Overview

The OpenCode Go Provider is a VS Code extension that registers a custom `LanguageModelChatProvider` ("opencode-go") for Copilot Chat. It translates Copilot Chat's internal message format into OpenCode Go's OpenAI-compatible or Anthropic-compatible API requests, routes them to `https://opencode.ai/zen/go/v1`, and streams responses back through VS Code's language model API.

```
Copilot Chat
  └─ LanguageModelChatProvider (opencode-go)
       ├─ Anthropic Conversion  (MiniMax models)
       │    └─ POST /v1/messages  (Anthropic-compatible)
       └─ OpenAI Conversion  (all other models)
            └─ POST /v1/chat/completions  (OpenAI-compatible)
                    │
                    ├─ Retry logic (exponential backoff + jitter)
                    ├─ SSE stream parsing
                    ├─ Tool call detection & repair
                    └─ Token counting
```

## Module Map

| Module | Responsibility |
|--------|---------------|
| `extension.ts` | Entry point. Registers the provider, MCP client, tools, and debug commands. |
| `provider.ts` | `OcGoChatModelProvider` implements `LanguageModelChatProvider`. Orchestrates model listing, API key management, message conversion, and streaming. |
| `types.ts` | Shared types (`OcGoModelInfo`, `OcGoChatMessage`, `OcGoToolCall`) and the `FALLBACK_MODELS` list. |
| `api.ts` | HTTP client with retry logic. Handles `fetch`, status codes, rate limiting (`Retry-After`), and SSE streaming via `ReadableStream`. |
| `openai-conversion.ts` | Converts Copilot Chat `LanguageModelChatMessage[]` → OpenAI `/chat/completions` request format. |
| `streaming/openai.ts` | Parses OpenAI-compatible SSE streams into `LanguageModelResponsePart[]`. |
| `anthropic-conversion.ts` | Converts Copilot Chat messages → Anthropic `/messages` request format (used by MiniMax models). |
| `streaming/anthropic.ts` | Parses Anthropic-compatible SSE streams. |
| `message-parts.ts` | Type guards (`hasTextValue`, `isToolCallPart`, `isToolResultPart`) and extraction helpers for `LanguageModelInputPart` and legacy parts. |
| `tokenizer.ts` | Lightweight token estimator (characters ÷ 2). No WASM/tiktoken dependency. |
| `tool-parser.ts` | Parses text-embedded and XML-style tool calls from streaming model output. Includes `ToolCallScanner` for incremental parsing. |
| `announcement.ts` | Detects responses that end by announcing an action (JA/EN/ZH) without emitting the tool call, and builds the nudge message used to continue the turn. |
| `tool-repair.ts` | Deduplicates tool calls, repairs missing arguments from chat context, and coerces argument types using `inputSchema`. |
| `tools.ts` | Registers the `opencode_go_analyze_image` language model tool for vision requests. |
| `mcp.ts` | MCP (Model Context Protocol) client for optional server integration. |
| `guidance.ts` | Builds system-prompt guidance: provider identity, tool-use instructions, and DeepSeek-specific prompt sanitization. |
| `output-channel.ts` | Centralized debug logging via `vscode.OutputChannel`. |
| `constants.ts` | API base URL, timeout values, context window safety margins, and workaround model sets. |

## Data Flow

### 1. Model Discovery

`prepareLanguageModelChatModel()` reads the bundled `FALLBACK_MODELS` list and returns model metadata (name, context window, capabilities) to Copilot Chat. Models are identified by `{ vendor: "opencode-go", family: "<model-id>" }`.

### 2. Request Lifecycle

1. **Copilot Chat** calls `provideLanguageModelChatResponse(messages, options, token)`.
2. The provider reads the API key from `SecretStorage` (`opencode-go.apiKey`).
3. System prompt guidance is injected (`guidance.ts`):
   - Provider identity ("You are GitHub Copilot using OpenCode Go...")
   - Tool-use grounding instructions
   - DeepSeek-specific prompt sanitization (replaces "Claude" → "GitHub Copilot", "Anthropic" → "OpenCode Go")
4. Messages are converted to API-specific format:
   - **OpenAI format** (default): `openai-conversion.ts` → `POST /v1/chat/completions`
   - **Anthropic format** (`apiFormat: "anthropic"`): `anthropic-conversion.ts` → `POST /v1/messages`
5. The response is streamed back as SSE, parsed into `LanguageModelResponsePart[]`, and yielded to Copilot Chat.

### 3. Tool Execution

- **Text-embedded tool calls**: Parsed from streaming output by `tool-parser.ts` (`ToolCallScanner`). Detects `<|tool_call_begin|>` markers and XML-style `<tool_calls>` blocks.
- **Tool call repair**: Before re-sending a tool call, `tool-repair.ts` checks for duplicates and repairs missing/invalid arguments using `inputSchema` and chat context (file path, selection, CWD).
- **Vision tool**: The `opencode_go_analyze_image` language model tool is registered via `tools.ts` for models without native vision support.

### 4. Error Handling & Retry

`api.ts` implements exponential backoff with full jitter:
- Retries on `429` (rate limit), `502`, `503`, `504`
- Respects `Retry-After` headers
- Per-read SSE timeout (60s) to detect silent connection drops
- Request-level timeout (120s)

The streaming handlers (`streaming/openai.ts`, `streaming/anthropic.ts`) additionally retry a single user-visible request up to 3 times when an attempt yields no usable output: reasoning-only output, empty responses, mid-response stops, truncation (`finish_reason: "length"` / `stop_reason: "max_tokens"`), or an **action announcement without a tool call** (`announcement.ts` detects endings like "テストを実行します。" / "I will run the tests."; the buffered announcement is replayed as an assistant message followed by a nudge so the model emits the tool call it announced). These retries are silent — no `(Retrying...)` text is written to the chat, because such text would persist in the conversation history and confuse the model on later turns. When Thinking Effort is left at "default", retries also force `reasoning_effort: "low"` for thinking models so a reasoning-only storm cannot repeat.

## API Formats

### OpenAI-Compatible (`apiFormat: "openai"`)

Used by all models except MiniMax. Endpoint: `POST /v1/chat/completions`. Standard SSE streaming with `data: {...}` lines.

### Anthropic-Compatible (`apiFormat: "anthropic"`)

Used by MiniMax M2.5, M2.7, M3. Endpoint: `POST /v1/messages`. Uses Anthropic content block format with `tool_use` / `tool_result` blocks. SSE streaming with `event:` lines.

## Key Design Decisions

- **Zero runtime dependencies**: All HTTP, streaming, and parsing logic is built on Node.js/VS Code APIs.
- **Two API formats, single provider**: The provider selects the conversion path based on `modelInfo.apiFormat`.
- **Fallback model list**: Models are bundled in `types.ts` rather than fetched dynamically. This ensures offline availability and deterministic behavior.
- **Lightweight tokenizer**: Token estimation uses `Math.ceil(text.length / 2)` instead of loading a full tokenizer (tiktoken/WASM). This sacrifices precision for zero binary dependencies and fast startup.
- **Reasoning content workaround**: Kimi K2.6+, DeepSeek V4 Pro/Flash models require special handling of `reasoning_content` fields in streaming deltas (`REASONING_CONTENT_WORKAROUND_MODELS`).
