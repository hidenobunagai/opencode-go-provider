# Change Log

## [0.1.55] - 2026-07-02

### Fixed

- **Fixed tool execution cutting off midway for Opencode Go models.** Previously, native tool calls were validated and deleted early during streaming if the accumulated JSON structure happened to be complete (such as when the model streams a nested object like `ArtifactMetadata` first). This caused subsequent fields to be ignored and the conversation to hang. Now, the extension buffers native tool calls and only validates and emits them when the model starts outputting normal text/reasoning or when the stream finishes.
- **Fixed broken reasoning_effort and retry unit tests.** Updated tests to align with the new `reasoningEffort` configuration schema.

## [0.1.54] - 2026-06-30

### Fixed

- **Fixed chat getting stuck mid-response due to SSE stream read timeout.** Previously, each `reader.read()` call during SSE streaming had no timeout. If the server paused mid-stream (e.g., during a long generation), the extension would hang indefinitely waiting for data. Now a 60-second per-read timeout races each read; if the timeout fires, the stream is cancelled and the retry loop re-establishes a new connection.
  - OpenAI SSE path (`api.ts`): per-read timeout with stream cancellation.
  - Anthropic SSE path (`anthropic.ts`): same timeout logic.
  - Both paths added a 1 MB safety cap on the SSE buffer to prevent unbounded memory growth.

### Changed

- **Added visible retry progress for OpenAI-format models.** When the extension retries a failed attempt (reasoning-only, empty-response, truncated, mid-response-stop), the user now sees a progress message like `"(Retrying...)"` in the chat, matching the existing Anthropic path behavior. Previously, retries happened silently and the chat appeared to have stopped.

## [0.1.53] - 2026-06-28

### Fixed

- **Fixed chat getting stuck mid-response when the model hits its output token budget.** Previously, if a model produced even one character before exhausting its token budget (`finish_reason: "length"` / `stop_reason: "max_tokens"`), no retry was attempted because all retry conditions required zero visible output. The response was silently truncated, appearing to the user as if the chat had stopped mid-sentence. Now the extension retries with a larger budget, and if retries are exhausted, a truncation warning is shown.
  - OpenAI handler: new `finish_reason === "length"` retry condition (bypasses `hasVisibleOutput` gate).
  - Anthropic handler: captures `stop_reason` from `message_delta` events; new `stop_reason === "max_tokens"` retry condition.
  - Both handlers emit `_⚠️ The response was automatically truncated._` when retries are exhausted.

## [0.1.52] - 2026-06-27

### Changed

- **Replaced model-variant approach with a dedicated Thinking Effort dropdown.** Instead of listing separate model variants (e.g. `DeepSeek V4 Flash (Max)`), each reasoning model now shows a single entry with a configurable "Thinking Effort" dropdown (Default / Max / High / Medium / Low) directly in the model picker. This matches how the native OpenCode provider works in VS Code Copilot Chat.
  - Uses `configurationSchema` (non-public Copilot Chat API) to render the dropdown.
  - The selected effort is sent as `reasoning_effort` in the API request body.
  - "Default" lets the model decide; "Max" sends maximum reasoning effort.
  - Affects GLM-5/5.1/5.2, Kimi K2.5/K2.6/K2.7 Code, Qwen3.5/3.6/3.7 Plus/Max, MiMo V2 Pro/Omni/2.5 Pro/2.5, DeepSeek V4 Pro/Flash, and HY3 Preview.

## [0.1.51] - 2026-06-27

### Added

- **Added Thinking Effort variants for all reasoning models.** Each reasoning model now has variants (e.g. `:max`, `:high`) that let you control how much effort the model spends on reasoning before responding. Selectable from the model picker in VS Code Copilot Chat.
  - **GLM-5, GLM-5.1, GLM-5.2** — new `:max` (Max) variant for maximum reasoning effort.
  - **Kimi K2.5, K2.6, K2.7 Code** — new `:max` (Max), `:high`, `:medium`, `:low` variants for fine-grained reasoning control.
  - **Qwen3.5 Plus, Qwen3.6 Plus, Qwen3.7 Plus, Qwen3.7 Max** — new `:max` (Max) variant.
  - **MiMo-V2-Pro, MiMo-V2-Omni, MiMo-V2.5-Pro, MiMo-V2.5** — new `:max` (Max) variant.
  - **HY3 Preview** — new `:max` (Max) variant.

## [0.1.50] - 2026-06-27

### Fixed

- **Restored accidentally removed models in `FALLBACK_MODELS`.** Kimi K2.5, MiMo-V2-Pro, MiMo-V2-Omni, MiniMax M2.5, Qwen3.5 Plus, and HY3 Preview were missing from the list and are now selectable again.
- **Fixed Qwen model `apiFormat`.** Qwen3.6 Plus, Qwen3.7 Plus, and Qwen3.7 Max were incorrectly set to `anthropic` instead of `openai`.
- Restored missing tiktoken encoder mappings for the restored models.

### Added

- **Added `glm-5.2` (GLM-5.2)** to the `FALLBACK_MODELS` list. Mirrors GLM-5.1 with 202,752 context window and OpenAI API format.

## [0.1.49] - 2026-06-14

### Changed

- **Updated supported models list in `FALLBACK_MODELS` to match the latest OpenCode Go offerings:**
  - Added **Kimi K2.7 Code** (`kimi-k2.7-code`) and configured it for the reasoning content workaround.
  - Added **Qwen3.7 Plus** (`qwen3.7-plus`).
  - Switched Qwen models (`qwen3.6-plus`, `qwen3.7-plus`, `qwen3.7-max`) to use the **Anthropic Messages API format** (`apiFormat: "anthropic"`) as specified by OpenCode Go's updated endpoints.
  - Removed deprecated models: `kimi-k2.5`, `mimo-v2-pro`, `mimo-v2-omni`, `minimax-m2.5`, `qwen3.5-plus`, and `hy3-preview`.

## [0.1.48] - 2026-06-01

### Added

- **Added newly available OpenCode Go models to the bundled `FALLBACK_MODELS` list.** The `/models` endpoint now returns models that were not yet selectable in the extension:
  - **Qwen3.7 Max** (`qwen3.7-max`) — 1M context, vision, OpenAI format (mirrors Qwen3.6 Plus).
  - **MiniMax M3** (`minimax-m3`) — Anthropic Messages API format (mirrors MiniMax M2.7).
  - **HY3 Preview** (`hy3-preview`) — 256K context, OpenAI format.
- Registered tiktoken encoder mappings (`gpt-4o`) for the three new models.

## [0.1.47] - 2026-05-24

### Changed

- **Encouraged parallel tool calling in system prompt guidance.** Instructed the model to emit independent tool calls in parallel within a single response (e.g., editing multiple sections/files or reading multiple files) instead of sequentially across multiple turns, minimizing user prompts and round-trips.

## [0.1.46] - 2026-05-24

### Added

- **Implemented native VS Code `LanguageModelThinkingPart` support when available.** Allows thinking content from reasoning models (like DeepSeek V4) to be rendered using the native VS Code API without polluting text output.
- **Added a clean Markdown blockquote fallback for thinking process display.** When native `LanguageModelThinkingPart` is not supported, the extension streams reasoning content inside a blockquote formatting block (`\n> **[思考プロセス (Thinking Process)]**\n> `) ending with a divider, keeping it clearly distinct from normal response content.
- **Implemented round-trip reasoning content caching and extraction.** Extracted blockquote formatting cleanly from chat logs, and introduced an in-memory `reasoningCache` to map assistant replies to their respective thinking history to maintain context on subsequent turns.

## [0.1.45] - 2026-05-24

### Added

- **Implemented HTML `<details>` details-block streaming and round-tripping for reasoning content.** Models that support thinking output now stream reasoning content inside an HTML `<details>` details block to hide it behind a disclosure widget by default in the chat UI.
- **Added comprehensive unit tests for details-block reasoning extraction and message conversion.** Validated details-block reasoning round-tripping, tiktoken preloading, and caching behaviors.

### Fixed

- **Improved retry state-tracking with `hasEmittedNormalOutput`.** Introduced state tracking inside `StreamState` to ensure retry logic correctly determines if a model successfully produced normal visible output vs only thinking process content, hardening fallback behavior on empty responses.
- **Gracefully handled details-block termination during retries.** The extension now explicitly closes the active reasoning details block before transitioning to a retry attempt or fallback messaging.

## [0.1.44] - 2026-05-16

### Fixed

- **Improved model picker compatibility by explicitly marking models as user-selectable.** Each contributed model now sets `isUserSelectable: true`.
- **Added startup diagnostics for model-picker visibility.** On activation, the extension now logs the result of `vscode.lm.selectChatModels({ vendor: "opencode-go" })` (count and IDs), making it clear whether VS Code can resolve selectable models for the vendor.

## [0.1.43] - 2026-05-16

### Fixed

- **Removed runtime dependency on `@dqbd/tiktoken` to eliminate startup `MODULE_NOT_FOUND` errors.** Token estimation now consistently uses the built-in lightweight character-based estimator, so missing native/WASM artifacts cannot break extension startup diagnostics.
- **Hardened provider registration and model-discovery diagnostics.** Added explicit debug logs for provider registration success/failure and `provideLanguageModelChatInformation` calls so model picker issues can be traced directly from the `OpenCode Go` output channel.
- **Normalized model capability shape for compatibility.** `toolCalling` is now returned as a boolean capability.

## [0.1.42] - 2026-05-16

### Fixed

- **Fixed OpenCode Go models not appearing in the model picker after VS Code 1.104 update.** VS Code 1.104 finalized the `LanguageModelChatProviders` API and removed support for the `configuration` field in the manifest contribution. The provider now uses `managementCommand` instead, which is the correct format for the stable API.

## [0.1.41] - 2026-05-16

### Fixed

- **Restored OpenCode Go model visibility in the chat model picker after recent VS Code updates.** The provider configuration no longer requires `apiKey` in settings, so models remain selectable when the key is managed via SecretStorage/command-based setup.

## [0.1.40] - 2026-05-04

### Fixed

- **Reduced empty-response failures for OpenAI/DeepSeek streaming paths.** The extension now retries not only reasoning-only responses, but also fully silent stream terminations and incomplete tool-call stops, which were previously more likely to fall through to no visible output.
- **Empty responses now fail more gracefully when retries are exhausted.** If a model still produces no visible text or tool calls after all retries, the extension returns an explicit fallback message instead of letting VS Code surface the generic "Sorry, no response was returned" message.

### Added

- **Replay-ready diagnostics for no-output incidents.** When OpenAI/DeepSeek retries are exhausted with no visible output, the extension now captures the exact request payloads and attempt metadata in the `OpenCode Go` output channel so problematic requests can be replayed directly against `/chat/completions`.
- Added `bun run measure:deepseek` and `bun run measure:deepseek:json` helper scripts to measure `deepseek-v4-flash:max` / `deepseek-v4-pro:max` behavior directly against `/chat/completions`.

## [0.1.39] - 2026-05-02

### Fixed

- **Made DeepSeek retry attempts more effective for Flash/Max and other thinking variants.** On empty-response retries, the extension now reduces `reasoning_effort` step by step (`xhigh -> high -> medium -> low`) instead of retrying with the same settings, which helps models that frequently end with only internal reasoning and no visible output.
- Retry attempts are no longer emitted into the chat transcript as `Retrying...` text; they are logged only in debug output.

## [0.1.38] - 2026-05-02

### Fixed

- **Restored retries for thinking-model empty responses** without reintroducing explicit `max_tokens`. DeepSeek and other reasoning-heavy paths can again retry when the upstream returns only reasoning content or stops mid-response, reducing cases where VS Code falls back to "Sorry, no response was returned."

## [0.1.37] - 2026-04-30

### Removed

- **Silenced the "no text content" diagnostic** that appeared when the API occasionally returned an empty response. OpenCode Go itself never shows this message — it handles empty responses silently. The diagnostic was alarming users with a misleading token-budget warning.

## [0.1.36] - 2026-04-30

### Fixed

- **Removed spurious "(Retrying with increased output token budget...)" noise for thinking models (DeepSeek, Kimi).** Since v0.1.35 no longer sends `max_tokens` to thinking models, the retry loop with doubled budgets had no effect — the API already manages reasoning/output balance internally. Retries are now skipped for thinking models entirely.

## [0.1.35] - 2026-04-30

### Fixed

- **Removed false-positive "stopped mid-task" diagnostic** that appeared after successful responses. The message was incorrectly triggered by a condition that checked `!sawToolCall && emittedCanonicalKeys.size > 0`, which fired whenever the model produced a text-only response after previously emitting tool calls in the conversation history.

## [0.1.34] - 2026-04-30

### Fixed

- **Critical:** Thinking models (DeepSeek V4, Kimi K2) no longer receive `max_completion_tokens` / `max_tokens` in API requests. The OpenCode Go API balances reasoning vs visible output internally; overriding with explicit limits caused the model to exhaust the entire budget on internal reasoning, producing zero visible text or tool calls. This eliminates the frequent "stopped mid-response" failures.
- Mid-response stop detection: when a model starts producing tool calls but stops before completing any, the extension now retries with increased token budget.
- Extended automatic retry from 1 to 3 attempts with exponentially increasing budgets each time.

### Performance

- Token counting now uses cached tiktoken encodings instead of allocating/freeing per call.
- Incomplete JSON tool call fragments are detected structurally before attempting `JSON.parse`, avoiding unnecessary parse failures.
- Stateful tool call scanner replaces regex-based text-embedded tool call parsing for more efficient incremental processing.
- Removed OpenAI SSE fallback parser from Anthropic streaming path.
- System prompt guidance compressed to reduce token overhead.
- Dynamic context window safety margin: 1% of model context window (minimum 2048 tokens), replacing the flat 4096 across all models.
- Improved retry with snapshot-based tool call deduplication so already-emitted calls aren't repeated on retry.

## [0.1.33] - 2026-04-29

### Fixed

- Made the mid-task stop diagnostic message cover additional causes (upstream disconnect, internal model error) beyond just token budget exhaustion.

## [0.1.31] - 2026-04-29

### Fixed

- When a reasoning model (DeepSeek V4, Kimi K2) exhausts its token budget mid-task with partial text output and no tool calls, the extension now appends a diagnostic note explaining the likely cause instead of leaving the user with an incomplete-looking response.

## [0.1.30] - 2026-04-29

### Fixed

- Fixed `imageInput` capability to respect `supportsVision` per model. Previously all models claimed `imageInput: true`, causing VS Code to attempt clipboard reads for non-vision models and fail with "Cannot read clipboard".
- Fixed vision fallback path to use the fallback model's `apiFormat` instead of the original model's format, preventing API format mismatch hangs.
- Added error handling around `processImagesForNonVisionModel` so image analysis failures report a user-facing message instead of silently throwing.

## [0.1.29] - 2026-04-29

### Changed

- Translated README Japanese text to English throughout.

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
