import * as vscode from "vscode";

const OUTPUT_CHANNEL_NAME = "OpenCode Go";

/** Module-private output channel. Lazily created on first access. */
let _channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return _channel;
}

/** Dispose the output channel and reset state. Safe to call during deactivation. */
export function disposeOutputChannel(): void {
  if (_channel) {
    _channel.dispose();
    _channel = undefined;
  }
}

export function debugEnabled(): boolean {
  return process.env.OPENCODE_GO_DEBUG === "1";
}

function appendChannelLine(prefix: string, label: string, value: unknown, ensureChannel = false) {
  const message = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const channel = ensureChannel ? getOutputChannel() : _channel;
  if (channel) {
    channel.appendLine(`[OpenCode Go ${prefix}] ${label}: ${message}`);
    return;
  }
  console.log(`[OpenCode Go ${prefix}] ${label}:`, value);
}

export function debugLog(label: string, value: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  appendChannelLine("Debug", label, value);
}

export function captureLog(label: string, value: unknown): void {
  appendChannelLine("Capture", label, value, true);
}
