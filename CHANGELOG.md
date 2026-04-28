# Change Log

## [0.1.28] - 2026-04-28

### Fixed

- When a model produces only internal reasoning/thinking content without visible text, the extension now emits a diagnostic message explaining the situation instead of silently returning nothing. This primarily affects reasoning models (DeepSeek V4, Kimi K2) whose token budget may be exhausted during the thinking phase.

## [0.1.27] - 2026-04-28

### Performance

- Token counting in `provideTokenCount` now batches all text parts into a single `estimateTokens` call instead of creating a tiktoken encoding per part.
- `debugLog` calls for outgoing requests are now guarded by `OPENCODE_GO_DEBUG` env check, avoiding unnecessary object construction when debug is disabled.

### Refactoring

- Extracted shared streaming state machine (`src/streaming/shared.ts`) to eliminate ~110 lines of duplicate code between OpenAI and Anthropic streaming handlers.
- Tool call buffer management changed from index-based keys to ID-based keys with index→ID mapping for robustness with partial chunks.
- Unified `CancellationError` / `AbortError` handling between OpenAI and Anthropic streaming paths.

## [0.1.26] - 2026-04-28

### Fixed

- Reasoning/thinking content no longer displayed in user-facing chat output. It remains available via debug logging only.

## [0.1.25] - 2026-04-28

### Performance

- Token estimation now reuses a single tiktoken encoding across all messages instead of creating/destroying per message part.
- tiktoken WASM module preloaded during extension activation to eliminate first-request load delay.
- Model lookup changed from O(n) array scan to O(1) Map.

### Quality

- Automatic type coercion for tool arguments: string `"5"` → number `5`, string `"true"` → boolean `true` when schema specifies type.
- Tool name normalization (case-insensitive matching) so `Read_File`/`read_file`/`ReadFile` all match.
- Dedup canonical keys now sort object keys before JSON.stringify, preventing order-dependent false duplicates.
- `run_in_terminal` default value repairs no longer require request context.

### Reliability

- Added 120-second request timeout via `AbortSignal` to prevent indefinite hangs.
- Retry-After header now supports HTTP-date format in addition to integer seconds.
- Improved error messages: 401/403 errors now include the `opencode-go.manage` command name, 400 token limit errors have specific guidance.
- Error messages parse structured JSON error bodies for cleaner details.
- Timeout-error handling added alongside cancellation handling in provider catch block.

### Feature Parity

- Users are notified when a non-vision model auto-switches to a vision fallback model for image analysis.
- Reasoning/thinking content from models (DeepSeek V4, MiniMax) is now displayed to users with a `[Reasoning]` prefix (truncated at 2000 characters).

### UX

- Model picker tooltips now display reasoning effort, vision support, context window size, and API format.

## [0.1.24] - 2026-04-28

### Changed

- Removed startup-time `/models` discovery and now use the bundled `FALLBACK_MODELS` list as the single source of truth for selectable models.
- Unified vision/image analysis requests with the shared chat completion request path, including retries, user-agent propagation, and explicit empty-response errors.
- Stopped fabricating placeholder tool search queries when required arguments are missing; invalid tool calls now surface the missing arguments instead.
- Split the previous monolithic `utils.ts` responsibilities into focused conversion and tokenizer modules.
- Pinned `@types/vscode` to the supported VS Code API baseline and pinned the CI Bun runtime.
- Added VSIX packaging to CI so marketplace packaging regressions are caught before release.

## [0.1.23] - 2026-04-27

### Added

- Added Medium thinking variant for DeepSeek V4 Pro and DeepSeek V4 Flash, matching the full set available in OpenCode Go CLI (Default, Low, Medium, High, Max).

## [0.1.19] - 2026-04-27

### Added

- Added thinking mode variants for DeepSeek V4 Pro and DeepSeek V4 Flash: (Max Thinking), (High Thinking), (Low Thinking).
- Thinking variants appear as separate entries in the model picker, similar to native Copilot Chat models.
- Each variant sends the `reasoning_effort` parameter to the target model.

## [0.1.16] - 2026-04-26

### Changed

- Refactored monolithic provider.ts into focused modules: tool-parser, tool-repair, guidance, streaming/openai, streaming/anthropic.
- Improved token estimation with model-aware tiktoken-based tokenizer (fallback to char-based heuristic).
- Parallelized image analysis with Promise.all for multi-image messages.

### Fixed

- Added debugLog to previously silent error catch blocks across streaming modules.
- Replaced `require()` with ES import for package.json, removed unused imports.
- Tightened TypeScript types, eliminated `no-explicit-any` warnings in source files.

## [0.1.15] - 2026-04-26

### Fixed

- Improved tool grounding for non-DeepSeek models so workspace inspections are less likely to fail on missing `read_file` arguments.
- Added stronger `read_file` argument repair and editor-context fallback handling to reduce empty tool-call crashes.

## [0.1.14] - 2026-04-26

### Fixed

- Improved Kimi / API handling of `HTTP 429 Too Many Requests` by honoring server-provided `Retry-After` headers regardless of absolute length, and increasing chat completion retry limits.
- Automatically repair `grep_search` and `file_search` arguments (`query`, `isRegexp` etc.) before dispatch to VS Code Copilot agent handlers, preventing random crashes when the model hallucinates missing required tool inputs.
- Converted residual `console.warn` usage to `debugLog` to avoid console spam in production paths.

## [0.1.13] - 2026-04-26

### Changed

- Improved DeepSeek V4 Pro / V4 Flash tool-use grounding so workspace and file summaries stay tied to actual tool outputs.
- Routed DeepSeek tool-enabled chats through the OpenAI-compatible chat completions path with explicit automatic tool choice.

### Fixed

- Preserved DeepSeek reasoning-content placeholders for tool-call history to avoid thinking-mode request failures.
- Reduced DeepSeek tool-use roleplay by reinforcing evidence-based guidance for latest-file and workspace claims.

## [0.1.12] - 2026-04-26

### Added

- Added `--json` output mode to the DeepSeek comparison helper so upstream identity checks can be saved directly as machine-readable logs.
- Added a `bun run repro:compare:json` shortcut for the default DeepSeek vs Kimi comparison pair.

## [0.1.11] - 2026-04-26

### Added

- Added side-by-side model comparison support to the DeepSeek reproduction script so the same prompt can be sent to DeepSeek and reference models in one run.

### Changed

- Added a `bun run repro:compare` helper and expanded README troubleshooting guidance for upstream model identity checks.

## [0.1.10] - 2026-04-26

### Changed

- Removed verbose DeepSeek investigation logs from the Anthropic `/messages` path after the streaming fix was validated.
- Added a `bun run repro:deepseek` helper script and README troubleshooting steps to verify directly whether OpenCode Go routes `deepseek-v4-flash` to an unexpected upstream model.

## [0.1.9] - 2026-04-26

### Fixed

- DeepSeek V4 Pro / V4 Flash: accept raw JSON event lines on the `/messages` streaming endpoint in addition to standard `data:` SSE lines. This fixes cases where the model produced a valid response but VS Code showed "Sorry, no response was returned".

## [0.1.8] - 2026-04-26

### Removed

- Removed the **Refresh Models** command (`opencode-go.refreshModels`). OpenCode Go does not provide a `/models` endpoint, so the command always failed. The built-in `FALLBACK_MODELS` list is now the sole source of model information.

## [0.1.7] - 2026-04-26

### Fixed

- DeepSeek V4 Pro / V4 Flash: use OpenAI-format tool definitions (`convertTools`) instead of Anthropic format (`convertToolsToAnthropic`) when calling the `/messages` endpoint. The DeepSeek proxy expects `tools[].function.name` rather than `tools[].name`.

## [0.1.6] - 2026-04-26

### Fixed

- Changed DeepSeek V4 Pro and V4 Flash to use Anthropic Messages API (`/zen/go/v1/messages`) instead of OpenAI format, matching the official OpenCode Go API documentation.
- Improved Refresh Models error message to clarify that OpenCode Go does not provide a models list endpoint.

## [0.1.5] - 2026-04-26

### Fixed

- Set `supportsVision: false` for DeepSeek V4 Pro and V4 Flash (these models do not accept `image_url` input).


## [0.1.2] - 2026-04-24

### Added

- Automated CI with GitHub Actions (lint → compile → test).
- ESLint + Prettier configuration with lint/format scripts.
- Comprehensive test suites for MCP client and tool registration.
- HTTP retry logic with exponential backoff and `Retry-After` header support.

### Changed

- Unified `BASE_URL` and `EXTENSION_VERSION` into `src/constants.ts`.
- Centralized debug logging into `src/output-channel.ts`.
- Pinned `@vscode/vsce` as devDependency for reproducible packaging.

### Fixed

- `fetchWithRetry` now handles HTTP 429/502/503/504 in addition to network errors.
- User-Agent version now matches `package.json` dynamically.

## [0.1.0] - 2026-04-24

### Added

- Initial release.
- Support for 12 OpenCode Go models:
  - GLM-5, GLM-5.1
  - Kimi K2.5, Kimi K2.6 (fixed temperature = 1 per provider requirements)
  - MiMo-V2-Pro, MiMo-V2-Omni, MiMo-V2.5-Pro, MiMo-V2.5
  - MiniMax M2.5, MiniMax M2.7 (via Anthropic Messages API)
  - Qwen3.5 Plus, Qwen3.6 Plus
- OpenAI-compatible streaming chat (`POST /chat/completions`) for most models.
- Anthropic Messages API streaming (`POST /messages`) for MiniMax M2.5 / M2.7.
- Tool calling (function calling) support for all models.
- Vision / image input support:
  - Native vision for Kimi K2.x, MiMo-V2-Omni, MiMo-V2.5-Pro, MiMo-V2.5, Qwen3.x.
  - Automatic routing to `mimo-v2-omni` when a non-vision model receives an image.
  - OCR text-extraction fallback via `OcGoMcpClient` when no vision model is available.
- `opencode_go_analyze_image` Language Model Tool for direct image analysis from the chat UI.
- Secure API key storage via VS Code `SecretStorage` (`opencode-go.apiKey`).
- Commands:
  - **OpenCode Go: Manage OpenCode Go API Key** — set or clear the API key.
  - **OpenCode Go: Refresh Models** — fetch the current model list from the API.
  - **OpenCode Go: Toggle Debug Logging** — write verbose request logs to the Output panel.
  - **OpenCode Go: Open Debug Log** — reveal the Output panel for the extension.
- Dynamic model list refresh on startup; falls back to the built-in `FALLBACK_MODELS` list when the API is unreachable.
- Text-embedded tool call parsing (`<|tool_call_begin|>…<|tool_call_end|>`) for models that embed tool calls in the response text.
- Tool argument repair heuristics for `read_file` and `list_dir` tools (auto-fills `filePath`, `path`, line ranges from context).
