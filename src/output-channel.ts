import * as vscode from "vscode";

const OUTPUT_CHANNEL_NAME = "OpenCode Go";

function getGlobalOutputChannel(): vscode.OutputChannel | undefined {
  const globalWindow = globalThis as typeof globalThis & {
    __opencodeGoOutputChannel?: vscode.OutputChannel;
  };
  return globalWindow.__opencodeGoOutputChannel;
}

function setGlobalOutputChannel(channel: vscode.OutputChannel): void {
  const globalWindow = globalThis as typeof globalThis & {
    __opencodeGoOutputChannel?: vscode.OutputChannel;
  };
  globalWindow.__opencodeGoOutputChannel = channel;
}

export function getOutputChannel(): vscode.OutputChannel {
  let channel = getGlobalOutputChannel();
  if (!channel) {
    channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    setGlobalOutputChannel(channel);
  }
  return channel;
}

export function debugEnabled(): boolean {
  return process.env.OPENCODE_GO_DEBUG === "1";
}

export function debugLog(label: string, value: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  const message = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const channel = getGlobalOutputChannel();
  if (channel) {
    channel.appendLine(`[OpenCode Go Debug] ${label}: ${message}`);
    return;
  }
  console.log(`[OpenCode Go Debug] ${label}:`, value);
}
