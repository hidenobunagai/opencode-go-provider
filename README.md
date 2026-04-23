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

1. Open the Command Palette (`Cmd/Ctrl + Shift + P`).
2. Run `OpenCode Go: Manage OpenCode Go API Key`.
3. Enter your OpenCode Go API key, or leave blank and press Enter to clear an existing key.
4. The extension refreshes the available model list in the background on startup. You can also run `OpenCode Go: Refresh Models` at any time.

## Supported Models

The extension dynamically fetches available models from OpenCode Go. Fallback models include:

- GLM-5, GLM-5.1
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
bun run test -- --runInBand
```

Press `F5` in VS Code to launch the Extension Development Host.

## Marketplace Packaging

```bash
bun run package:vsix
```

The command above produces a `.vsix` that can be uploaded in the VS Code Marketplace publisher portal.

## Privacy

- Your API key is stored securely in VS Code's built-in SecretStorage.
- Chat requests are sent to `https://opencode.ai/zen/go/v1`.
