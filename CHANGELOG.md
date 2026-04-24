# Change Log

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
