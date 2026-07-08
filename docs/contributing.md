# Contributing

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.2 (package manager & runtime)
- [VS Code](https://code.visualstudio.com/) ≥ 1.104.0
- Git

## Setup

```bash
git clone https://github.com/hidenobunagai/opencode-go-provider.git
cd opencode-go-provider
bun install --ignore-scripts
bun run compile
```

## Development Workflow

### Build

```bash
bun run compile    # TypeScript compilation (tsc)
bun run watch      # Watch mode — recompiles on file change
```

### Testing

```bash
bun run test              # Run all tests (Jest)
bun run test -- --runInBand  # Run tests serially (recommended for CI)
bun run test:coverage     # Run tests with coverage report
```

Test files live in `tests/` and mirror the `src/` structure:
- `tests/api.test.ts` — API client and retry logic
- `tests/provider.test.ts` — Provider lifecycle and model discovery
- `tests/tool-repair.test.ts` — Tool argument repair and dedup
- `tests/tool-parser.test.ts` — Tool call parsing from streaming output
- `tests/guidance.test.ts` — System prompt sanitization and guidance
- `tests/incremental-json.test.ts` — JSON completeness heuristics
- `tests/mcp.test.ts` — MCP client integration
- `tests/tools.test.ts` — Language model tool registration
- `tests/utils.test.ts` — Shared utility functions
- `tests/extension.test.ts` — Extension activation/deactivation

### Linting & Formatting

```bash
bun run lint       # ESLint check
bun run lint:fix   # Auto-fix lint issues
bun run format     # Prettier formatting
```

### Running the Extension

1. Open the project in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. In the Extension Dev Host, open Copilot Chat (`Cmd/Ctrl + Alt + I`).
4. Select **OpenCode Go** from the model picker and enter your API key.

### Packaging

```bash
bun run package:vsix   # Creates opencode-go-provider-<version>.vsix
```

## Code Style

- **TypeScript strict mode** (`tsconfig.json`: `strict: true`)
- **2-space indentation** (Prettier)
- **No `any` types** — use `unknown` and type guards
- **No `as` casts for message parts** — use type guards from `message-parts.ts` (`hasTextValue`, `isToolCallPart`, `isToolResultPart`)
- **Explicit return types** on exported functions
- **`import * as vscode`** for VS Code API imports
- **`bun` for all package management** — do not use npm

## Adding a New Model

1. Add an entry to `FALLBACK_MODELS` in `src/types.ts`:
   ```typescript
   {
     id: "new-model-id",
     name: "New Model Name",
     displayName: "New Model Name",
     contextWindow: 262144,
     maxOutput: 65536,
     supportsTools: true,
     supportsVision: false,
     apiFormat: "openai",       // or "anthropic" for MiniMax models
     supportsThinking: true,     // shows Thinking Effort dropdown
     fixedTemperature: undefined, // set to a number to override temperature
   }
   ```
2. Verify the model works with both tool and non-tool requests.
3. If the model has unusual streaming behavior, add it to `REASONING_CONTENT_WORKAROUND_MODELS` in `src/constants.ts`.
4. Update `README.md` with the model name.
5. Run `bun run compile && bun run test -- --runInBand`.

### Model Property Reference

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique model identifier (used in API calls and `family` field) |
| `name` | `string` | Internal model name |
| `displayName` | `string` | User-visible name in the model picker |
| `contextWindow` | `number` | Maximum context window in tokens |
| `maxOutput` | `number` | Maximum output tokens |
| `supportsTools` | `boolean` | Whether the model supports function/tool calling |
| `supportsVision` | `boolean` | Whether the model natively supports image input |
| `apiFormat` | `"openai"` \| `"anthropic"` | API format (default: `"openai"`) |
| `fixedTemperature` | `number` \| `undefined` | Fixed temperature value (e.g., `1` for Kimi models) |
| `supportsThinking` | `boolean` \| `undefined` | Shows Thinking Effort selector in model picker |

## Debugging

### Debug Logging

Toggle debug logging from the Command Palette: `OpenCode Go: Toggle Debug Logging`.

View logs: `OpenCode Go: Open Debug Log`.

Debug logs include:
- Provider lifecycle events
- API request/response metadata (no API keys)
- Tool call parsing and repair details
- Stream errors and retry events

### Troubleshooting DeepSeek Identity

If DeepSeek models claim to be a different model, run the repro script:

```bash
export OPENCODE_GO_API_KEY="your-api-key"
bun run repro:deepseek -- "What model are you?"
```

This sends a direct `/messages` request bypassing the extension to isolate the issue.

## Project Structure

```
opencode-go-provider/
├── src/
│   ├── extension.ts          # Entry point
│   ├── provider.ts           # LanguageModelChatProvider
│   ├── types.ts              # Types + FALLBACK_MODELS
│   ├── api.ts                # HTTP client + retry
│   ├── openai-conversion.ts  # OpenAI message conversion
│   ├── anthropic-conversion.ts # Anthropic message conversion
│   ├── streaming/
│   │   ├── openai.ts         # OpenAI SSE parser
│   │   ├── anthropic.ts      # Anthropic SSE parser
│   │   └── shared.ts         # Shared streaming utilities
│   ├── message-parts.ts      # Type guards + part extractors
│   ├── tokenizer.ts          # Token estimator
│   ├── tool-parser.ts        # Text-embedded tool call parser
│   ├── tool-repair.ts        # Tool argument repair + dedup
│   ├── tools.ts              # Language model tool registration
│   ├── mcp.ts                # MCP client
│   ├── guidance.ts           # System prompt guidance
│   ├── output-channel.ts     # Debug logging
│   ├── constants.ts          # Constants + workarounds
│   └── utils.ts              # Re-export hub
├── tests/                    # Jest test files
├── scripts/                  # Repro & measurement scripts
├── docs/                     # Documentation
└── images/                   # Extension icon
```

## CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`):
1. **Lint** — ESLint
2. **Compile** — TypeScript `tsc`
3. **Test** — Jest with coverage
4. **Package** — VSIX creation (on tag)

Coverage reports are uploaded as artifacts on each CI run.
