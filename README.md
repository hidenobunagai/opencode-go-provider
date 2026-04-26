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
4. Select **OpenCode Go** in Copilot Chat and choose a model.

## Supported Models

The extension dynamically fetches available models from OpenCode Go. Fallback models include:

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

- `bun run compile` – TypeScript コンパイル
- `bun run watch` – ファイル変更監視付きコンパイル
- `bun run test` – テスト実行
- `bun run lint` – ESLint チェック
- `bun run lint:fix` – ESLint 自動修正
- `bun run format` – Prettier フォーマット
- `bun run package:vsix` – VSIX パッケージ作成
- `bun run repro:deepseek -- "テストです。モデル名を教えてください。"` – DeepSeek の上流応答を拡張機能抜きで確認

## Troubleshooting

### DeepSeek が別モデル名を名乗る場合

拡張機能の送信モデルを切り分けるには、次を実行してください。

```bash
export OPENCODE_GO_API_KEY="your-api-key"
bun run repro:deepseek -- "テストです。モデル名を教えてください。"
```

このスクリプトは拡張機能を介さずに `deepseek-v4-flash` へ直接 `/messages` リクエストを送ります。ここでも Claude など別モデル名を返す場合、原因は OpenCode Go 側または上流ルーティングであり、この拡張機能ではありません。

## Marketplace Packaging

```bash
bun run package:vsix
```

The command above produces a `.vsix` that can be uploaded in the VS Code Marketplace publisher portal.

## Privacy

- Your API key is stored securely in VS Code's built-in SecretStorage.
- Chat requests are sent to `https://opencode.ai/zen/go/v1`.
