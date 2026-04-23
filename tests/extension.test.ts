import { fetchModels } from "../src/api";
import { OcGoChatModelProvider } from "../src/provider";

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const mockCreateOutputChannel = jest.fn(() => ({
  appendLine: jest.fn(),
  show: jest.fn(),
  dispose: jest.fn(),
}));
const mockShowInformationMessage = jest.fn();
const mockShowWarningMessage = jest.fn();
const mockShowErrorMessage = jest.fn();
const mockRegisterCommand = jest.fn(
  (command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return { dispose: jest.fn() };
  },
);
const mockRegisterLanguageModelChatProvider = jest.fn(() => ({ dispose: jest.fn() }));

jest.mock("../src/api", () => ({
  fetchModels: jest.fn(),
}));

jest.mock("../src/provider", () => ({
  OcGoChatModelProvider: jest.fn().mockImplementation(() => ({
    fireModelInfoChanged: jest.fn(),
  })),
}));

jest.mock("../src/tools", () => ({
  registerOcGoTools: jest.fn(() => ({ dispose: jest.fn() })),
}));

jest.mock("vscode", () => ({
  version: "1.104.0",
  window: {
    createOutputChannel: mockCreateOutputChannel,
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInputBox: jest.fn(),
  },
  commands: {
    registerCommand: mockRegisterCommand,
  },
  lm: {
    registerLanguageModelChatProvider: mockRegisterLanguageModelChatProvider,
  },
}));

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("activate", () => {
  beforeEach(() => {
    registeredCommands.clear();
    jest.clearAllMocks();
  });

  it("refreshes cached models in the background on activation when an API key exists", async () => {
    const models = [{ id: "kimi-k2.6", name: "Kimi K2.6" }];
    (fetchModels as jest.Mock).mockResolvedValue(models);

    const secrets = {
      get: jest.fn(async (key: string) => (key === "opencode-go.apiKey" ? "test-key" : undefined)),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "opencode-go.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    const providerInstance = (OcGoChatModelProvider as jest.Mock).mock.results[0]?.value;
    expect(fetchModels).toHaveBeenCalledWith(
      "test-key",
      undefined,
      "opencode-go-provider/0.1.0 VSCode/1.104.0",
    );
    expect(globalState.update).toHaveBeenCalledWith("opencode-go.models", models);
    expect(providerInstance.fireModelInfoChanged).toHaveBeenCalled();
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
  });

  it("does not attempt a background refresh on activation when no API key is configured", async () => {
    const secrets = {
      get: jest.fn(async () => undefined),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const globalState = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === "opencode-go.debug" ? false : fallback,
      ),
      update: jest.fn(async () => undefined),
    };
    const context = {
      secrets,
      globalState,
      subscriptions: [] as Array<{ dispose(): void }>,
    };

    const { activate } = await import("../src/extension");
    activate(context as never);
    await flushAsyncWork();

    expect(fetchModels).not.toHaveBeenCalled();
    expect(globalState.update).not.toHaveBeenCalledWith("opencode-go.models", expect.anything());
  });
});
