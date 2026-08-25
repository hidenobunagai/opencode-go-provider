import * as vscode from "vscode";
import { buildStatusBarText, fetchOpenCodeGoUsage, monthlyPercent } from "./usage";

const HIGH_USAGE_THRESHOLD = 80;

/**
 * Always-visible OpenCode Go quota in the VS Code status bar.
 * Mirrors Pi's go-usage extension: persistent footer line + warning toast
 * when monthly usage is high.
 *
 * Refresh triggers (wired in extension.ts):
 *  - on activate (if an API key exists)
 *  - after every chat response completes (provider event)
 *  - on API key change
 *  - on demand via the `opencode-go.showUsage` command
 */
export class OcGoUsageStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private _lastMonthlyPercent: number | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
  ) {
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._item.command = "opencode-go.showUsage";
    this._item.name = "OpenCode Go Usage";
    this._item.tooltip = "OpenCode Go quota — click for details";
  }

  /** Re-fetch usage and update the status bar. Returns the full line or null. */
  async refresh(): Promise<string | null> {
    const apiKey = (await this.secrets.get("opencode-go.apiKey"))?.trim();
    if (!apiKey) {
      this._item.hide();
      return null;
    }

    const { line, usage, error } = await fetchOpenCodeGoUsage(apiKey, this.userAgent);
    if (!line || !usage) {
      if (error) {
        this._item.text = "$(error) Go usage err";
        this._item.tooltip = `OpenCode Go quota fetch failed: ${error}. Click to retry.`;
        this._item.backgroundColor = undefined;
        this._item.show();
      } else {
        this._item.hide();
      }
      return null;
    }

    const text = buildStatusBarText(usage);
    this._item.text = text ? `$(gauge) ${text}` : "$(gauge) Go usage";
    this._item.tooltip = `${line}\nClick for details`;
    const monthly = monthlyPercent(usage);
    this._item.backgroundColor =
      monthly !== undefined && monthly >= HIGH_USAGE_THRESHOLD
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this._item.show();

    // Warn once per crossing into the high zone (not on every refresh,
    // which would spam toasts after every chat message).
    if (
      monthly !== undefined &&
      monthly >= HIGH_USAGE_THRESHOLD &&
      (this._lastMonthlyPercent === undefined || this._lastMonthlyPercent < HIGH_USAGE_THRESHOLD)
    ) {
      void vscode.window.showWarningMessage(`OpenCode Go monthly usage is at ${monthly}%: ${line}`);
    }
    this._lastMonthlyPercent = monthly;
    return line;
  }

  /** Show the full quota line in a notification (used by the command / click). */
  async showUsage(): Promise<void> {
    const line = await this.refresh();
    if (line) {
      void vscode.window.showInformationMessage(line);
    } else {
      void vscode.window.showInformationMessage(
        "OpenCode Go usage is unavailable. Configure an API key to see quota.",
      );
    }
  }

  dispose(): void {
    this._item.dispose();
  }
}
