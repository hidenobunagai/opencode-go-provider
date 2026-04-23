import * as vscode from "vscode";
import { fetchModels } from "./api";
import { EXTENSION_VERSION } from "./constants";
import { debugLog, getOutputChannel } from "./output-channel";
import { OcGoChatModelProvider } from "./provider";
import { registerOcGoTools } from "./tools";

let _provider: OcGoChatModelProvider | null = null;

async function refreshModelsFromApi(
  context: vscode.ExtensionContext,
  ua: string,
  options: { showMessages: boolean },
): Promise<void> {
  const apiKey = await context.secrets.get("opencode-go.apiKey");
  if (!apiKey) {
    if (options.showMessages) {
      vscode.window.showWarningMessage("No OpenCode Go API key configured.");
    }
    return;
  }

  try {
    const models = await fetchModels(apiKey, undefined, ua);
    if (models && models.length > 0) {
      await context.globalState.update("opencode-go.models", models);
      _provider?.fireModelInfoChanged();
      debugLog("refreshModels", `Refreshed ${models.length} models from OpenCode Go API.`);
      if (options.showMessages) {
        vscode.window.showInformationMessage(`Refreshed ${models.length} OpenCode Go models.`);
      }
      return;
    }

    debugLog("refreshModels", "Model refresh returned no models.");
    if (options.showMessages) {
      vscode.window.showWarningMessage("Failed to refresh models from OpenCode Go API.");
    }
  } catch (error) {
    debugLog("refreshModels", `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    if (options.showMessages) {
      vscode.window.showErrorMessage(
        `Failed to refresh models: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const ua = `opencode-go-provider/${EXTENSION_VERSION} VSCode/${vscode.version}`;
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  const debugEnabled = context.globalState.get<boolean>("opencode-go.debug", false);
  process.env.OPENCODE_GO_DEBUG = debugEnabled ? "1" : "0";
  debugLog("activate", `Extension activated. Debug logging ${debugEnabled ? "enabled" : "disabled"}.`);
  const provider = new OcGoChatModelProvider(context.secrets, ua, context.globalState);
  _provider = provider;

  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === "opencode-go.apiKey") {
        _provider?.fireModelInfoChanged();
      }
    }),
  );

  const registration = vscode.lm.registerLanguageModelChatProvider("opencode-go", provider);
  context.subscriptions.push(registration);
  context.subscriptions.push(registerOcGoTools(context.secrets));
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.manage", async () => {
      const existing = await context.secrets.get("opencode-go.apiKey");
      const apiKey = await vscode.window.showInputBox({
        title: "OpenCode Go API Key",
        prompt: existing ? "Update your OpenCode Go API key" : "Enter your OpenCode Go API key",
        ignoreFocusOut: true,
        password: true,
        value: existing ?? "",
        placeHolder: "Enter your OpenCode Go API key...",
      });
      if (apiKey === undefined) {
        return;
      }
      if (!apiKey.trim()) {
        await context.secrets.delete("opencode-go.apiKey");
        vscode.window.showInformationMessage("OpenCode Go API key cleared.");
        _provider?.fireModelInfoChanged();
        return;
      }
      await context.secrets.store("opencode-go.apiKey", apiKey.trim());
      vscode.window.showInformationMessage("OpenCode Go API key saved.");
      _provider?.fireModelInfoChanged();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.refreshModels", async () => {
      await refreshModelsFromApi(context, ua, { showMessages: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.toggleDebugLogging", async () => {
      const current = context.globalState.get<boolean>("opencode-go.debug", false);
      const next = !current;
      await context.globalState.update("opencode-go.debug", next);
      process.env.OPENCODE_GO_DEBUG = next ? "1" : "0";
      debugLog("toggleDebug", `Debug logging ${next ? "enabled" : "disabled"}.`);
      vscode.window.showInformationMessage(
        `OpenCode Go debug logging ${next ? "enabled" : "disabled"}.`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-go.openDebugLog", () => {
      const output = getOutputChannel();
      output.show(true);
    }),
  );

  void refreshModelsFromApi(context, ua, { showMessages: false });
}

export function deactivate() {
  _provider = null;
}
