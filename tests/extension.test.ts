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

describe("activate", () => {
  beforeEach(() => {
    registeredCommands.clear();
    jest.clearAllMocks();
  });

  it("registers the language model provider and commands", async () => {
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

    expect(mockRegisterLanguageModelChatProvider).toHaveBeenCalled();
    expect(registeredCommands.has("opencode-go.manage")).toBe(true);
    expect(registeredCommands.has("opencode-go.toggleDebugLogging")).toBe(true);
    expect(registeredCommands.has("opencode-go.openDebugLog")).toBe(true);
    expect(registeredCommands.has("opencode-go.refreshModels")).toBe(false);
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
  });
});
