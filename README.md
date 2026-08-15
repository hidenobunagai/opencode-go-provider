# OpenCode Go Provider

VS Code extension to use OpenCode Go models in Copilot Chat with your own OpenCode Go subscription.

## Requirements

- VS Code 1.104.0 or later
- GitHub Copilot extension installed and active
- An OpenCode Go API key ([get one here](https://opencode.ai/))

## Installation

### From Source

1. Clone this repository.
2. Run `bun install --ignore-scripts && bun run compile`.
3. Press `F5` in VS Code to launch the Extension Development Host.

### From VSIX

1. Run `bun install --ignore-scripts && bun run package:vsix`.
2. Install the generated `.vsix` file via the Extensions view (`Install from VSIX...`).

## Setup

1. Open Copilot Chat (`Cmd/Ctrl + Alt + I`) and open the model picker.
2. Choose **Manage Models** and add or configure **OpenCode Go**.
3. Enter your OpenCode Go API key when prompted.
4. If needed, you can still run `OpenCode Go: Manage OpenCode Go API Key` from the Command Palette.
5. Select **OpenCode Go** in Copilot Chat and choose a model.

## Supported Models

At runtime the extension fetches the current model list from the OpenCode Go API (`GET /models`) and infers each model's capabilities automatically, so newly released models usually work without an extension update. A bundled `FALLBACK_MODELS` list (in `src/types.ts`) is used when the API cannot be reached or no API key is configured yet. Currently bundled fallback models include:

- GLM-5, GLM-5.1, **GLM-5.2**, **GLM-5.3**
- DeepSeek V4 Pro, DeepSeek V4 Flash
- Kimi K2.5, Kimi K2.6, Kimi K2.7 Code, **Kimi K3**
- MiMo-V2-Pro, MiMo-V2-Omni, MiMo-V2.5-Pro, MiMo-V2.5
- MiniMax M2.5, MiniMax M2.7, **MiniMax M3**
- Qwen3.5 Plus, Qwen3.6 Plus, Qwen3.7 Plus, **Qwen3.7 Max**, **Qwen3.8 Max**
- **Grok 4.5**
- **GPT 5.6 Luna**
- **Hy3**, HY3 Preview

## Usage

1. Open Copilot Chat (`Cmd/Ctrl + Alt + I`).
2. Select **OpenCode Go** from the provider selector.
3. Choose a model (e.g., Kimi K2.6) and start chatting.

## Documentation

- [Architecture](docs/architecture.md) — Module map, data flow, API formats, and design decisions
- [Contributing](docs/contributing.md) — Development setup, code style, adding models, and debugging
- [Supported Models](docs/models.md) — Full model list, capabilities, and context window details

## Development

```bash
bun install --ignore-scripts
bun run compile
bun run lint
bun run test -- --runInBand
```

Press `F5` in VS Code to launch the Extension Development Host.

### Available Scripts

- `bun run compile` – Compile TypeScript
- `bun run watch` – Compile with file watching
- `bun run test` – Run tests
- `bun run lint` – Lint check with ESLint
- `bun run lint:fix` – Auto-fix with ESLint
- `bun run format` – Format with Prettier
- `bun run package:vsix` – Create VSIX package

## Marketplace Packaging

```bash
bun run package:vsix
```

The command above produces a `.vsix` that can be uploaded in the VS Code Marketplace publisher portal.

## Privacy

- Your API key is stored securely in VS Code and synced with the extension's SecretStorage compatibility path when needed.
- Chat requests are sent to `https://opencode.ai/zen/go/v1`.
