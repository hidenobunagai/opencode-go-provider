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

The extension uses the source-controlled `FALLBACK_MODELS` list bundled in this repository. When OpenCode Go adds new models, this extension must be updated and republished. Current bundled models include:

- GLM-5, GLM-5.1
- DeepSeek V4 Pro, DeepSeek V4 Flash
- Kimi K2.5, **Kimi K2.6**
- MiMo-V2-Pro, MiMo-V2-Omni, MiMo-V2.5-Pro, MiMo-V2.5
- MiniMax M2.5, MiniMax M2.7
- Qwen3.5 Plus, Qwen3.6 Plus

## Usage

1. Open Copilot Chat (`Cmd/Ctrl + Alt + I`).
2. Select **OpenCode Go** from the provider selector.
3. Choose a model (e.g., Kimi K2.6) and start chatting.

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
- `bun run repro:deepseek -- "What model are you?"` – Check DeepSeek upstream response without the extension
- `bun run repro:compare -- "What model are you?"` – Compare DeepSeek and reference model responses side by side
- `bun run repro:compare:json -- "What model are you?"` – Output comparison results as JSON

## Troubleshooting

### DeepSeek Claiming a Different Model Name

To isolate whether the model identity issue is in the extension, run:

```bash
export OPENCODE_GO_API_KEY="your-api-key"
bun run repro:deepseek -- "What model are you?"
```

This script sends a `/messages` request directly to `deepseek-v4-flash` without going through the extension. If it still returns Claude or another model name, the cause is on the OpenCode Go side or upstream routing, not this extension.

To compare with a reference model at the same time, run:

```bash
export OPENCODE_GO_API_KEY="your-api-key"
bun run repro:compare -- "What model are you?"
```

To compare with a different combination, use `--models` with comma-separated IDs:

```bash
bun run repro:deepseek -- --models deepseek-v4-flash,glm-5,qwen3.6-plus "What model are you?"
```

To save results as JSON, add `--json` and redirect:

```bash
export OPENCODE_GO_API_KEY="your-api-key"
bun run repro:compare:json -- "What model are you?" > deepseek-compare.json
```

The same works for any combination of models:

```bash
bun run repro:deepseek -- --json --models deepseek-v4-flash,glm-5,qwen3.6-plus "What model are you?" > compare.json
```

## Marketplace Packaging

```bash
bun run package:vsix
```

The command above produces a `.vsix` that can be uploaded in the VS Code Marketplace publisher portal.

## Privacy

- Your API key is stored securely in VS Code and synced with the extension's SecretStorage compatibility path when needed.
- Chat requests are sent to `https://opencode.ai/zen/go/v1`.
