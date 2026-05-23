import * as vscode from "vscode";
import { streamChatCompletion } from "../src/api";
import * as outputChannel from "../src/output-channel";
import { OcGoChatModelProvider } from "../src/provider";

jest.mock("../src/api", () => ({
  streamChatCompletion: jest.fn(),
  fetchWithRetry: jest.fn(),
}));

jest.mock("vscode", () => ({
  SecretStorage: class {},
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 0 },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  LanguageModelToolCallPart: class {
    constructor(
      public callId: string,
      public name: string,
      public input: Record<string, unknown>,
    ) {}
  },
  LanguageModelToolResultPart: class {
    constructor(
      public callId: string,
      public content: unknown[],
    ) {}
  },
  window: {
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
    showInputBox: jest.fn(),
  },
  workspace: {
    workspaceFolders: undefined,
  },
  LanguageModelError: {
    NoPermissions: (msg: string) => new Error(msg),
    NotFound: (msg: string) => new Error(msg),
    Blocked: (msg: string) => new Error(msg),
  },
  CancellationError: class extends Error {},
  EventEmitter: class {
    event = jest.fn();
    fire = jest.fn();
  },
  Memento: class {},
}));

describe("OcGoChatModelProvider", () => {
  let secrets: vscode.SecretStorage;
  let provider: OcGoChatModelProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = {
      get: jest.fn(),
      store: jest.fn(),
      delete: jest.fn(),
      onDidChange: jest.fn(),
    } as unknown as vscode.SecretStorage;
    provider = new OcGoChatModelProvider(secrets, "test-ua");
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);
  });

  it("provideLanguageModelChatInformation returns bundled fallback models", async () => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0].name).toBeDefined();
  });

  it("correctly identifies model capabilities via Map lookup", async () => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    const deepseekPro = infos.find((i: any) => i.id === "deepseek-v4-pro");
    expect(deepseekPro).toBeDefined();
    expect(deepseekPro?.maxOutputTokens).toBe(65536);

    const kimi = infos.find((i: any) => i.id === "kimi-k2.6");
    expect(kimi).toBeDefined();
    expect(kimi?.maxOutputTokens).toBe(262144);

    const missing = infos.find((i: any) => i.id === "nonexistent-model");
    expect(missing).toBeUndefined();
  });

  it("syncs a configured API key from provider configuration", async () => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: " configured-api-key " } } as any,
      token as any,
    );

    expect(secrets.store).toHaveBeenCalledWith("opencode-go.apiKey", "configured-api-key");
  });

  it("clears the compatibility secret when configured API key is removed", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("stale-api-key");

    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: { apiKey: "   " } } as any,
      token as any,
    );

    expect(secrets.delete).toHaveBeenCalledWith("opencode-go.apiKey");
  });

  it("preserves the compatibility secret when configuration omits apiKey", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("stored-api-key");

    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatInformation(
      { silent: true, configuration: {} } as any,
      token as any,
    );

    expect(secrets.delete).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("provideLanguageModelChatInformation returns empty array on cancellation", async () => {
    const token = {
      isCancellationRequested: true,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true } as any,
      token as any,
    );
    expect(infos).toEqual([]);
  });

  it("provideLanguageModelChatResponse streams text parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello" } }] };
      yield { choices: [{ delta: { content: " world" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
    );
    expect(progress.report).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "Hello world" }));
  });

  it("throws when message exceeds token limit", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        { id: "kimi-k2.6", maxInputTokens: 1, maxOutputTokens: 65536 } as any,
        [
          {
            role: 1,
            content: [{ value: "This is a very long message that exceeds the token limit" }],
          },
        ] as any,
        { modelOptions: {} } as any,
        progress,
        token as any,
      ),
    ).rejects.toThrow("Message exceeds token limit");
  });

  it("prompts for an API key during chat and continues the request when one is provided", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue("new-api-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from OpenCode Go" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect((vscode as any).window.showInputBox).toHaveBeenCalled();
    expect(secrets.store).toHaveBeenCalledWith("opencode-go.apiKey", "new-api-key");
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "new-api-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
    );
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Hello from OpenCode Go" }),
    );
  });

  it("uses a configured API key from model configuration without prompting", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from configuration" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {}, modelConfiguration: { apiKey: "configured-api-key" } } as any,
      progress,
      token as any,
    );

    expect((vscode as any).window.showInputBox).not.toHaveBeenCalled();
    expect(secrets.store).toHaveBeenCalledWith("opencode-go.apiKey", "configured-api-key");
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "configured-api-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
    );
  });

  it("falls back to provider configuration when model configuration has no API key", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Hello from provider configuration" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        configuration: { apiKey: "provider-api-key" },
        modelConfiguration: {},
      } as any,
      progress,
      token as any,
    );

    expect((vscode as any).window.showInputBox).not.toHaveBeenCalled();
    expect(streamChatCompletion).toHaveBeenCalledWith(
      "provider-api-key",
      expect.objectContaining({ model: "kimi-k2.6", stream: true }),
      expect.any(AbortSignal),
      "test-ua",
    );
  });

  it("returns setup guidance in chat when no API key is available", async () => {
    (secrets.get as jest.Mock).mockResolvedValue(undefined);
    ((vscode as any).window.showInputBox as jest.Mock).mockResolvedValue(undefined);

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.stringContaining("OpenCode Go API key") }),
    );
  });

  it("streams tool call parts", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports.length).toBe(1);
    expect(toolCallReports[0][0].callId).toBe("call_1");
    expect(toolCallReports[0][0].name).toBe("get_weather");
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("streams Anthropic text deltas from raw JSON lines", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{}\n"));
        controller.enqueue(
          encoder.encode(
            '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":2}}\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    });

    const mockResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
      body: stream,
    };

    (require("../src/api").fetchWithRetry as jest.Mock).mockResolvedValue(mockResponse);

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "minimax-m2.7", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string")
      .join("");

    expect(emittedText).toBe("Hello world");
  });

  it("parses DeepSeek XML-style tool calls from OpenAI text deltas", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                'I\'ll start by understanding the provider\'s capabilities.\n\n<tool_calls>\n<tool_call name="Skill">\n<tool_parameter name="skill">using-super',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content: "powers</tool_parameter>\n</tool_call>\n</tool_calls>",
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "Skill",
            description: "Load a skill",
            inputSchema: {
              type: "object",
              properties: { skill: { type: "string" } },
              required: ["skill"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string")
      .join("");
    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);

    expect(emittedText).toBe("I'll start by understanding the provider's capabilities.\n\n");
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("Skill");
    expect(toolCallReports[0][0].input).toEqual({ skill: "using-superpowers" });
  });

  it("anchors DeepSeek OpenAI system prompts with provider identity guidance", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: (vscode as any).LanguageModelChatMessageRole.System,
          content: [
            new vscode.LanguageModelTextPart("You are Claude Code running inside Anthropic tools."),
          ],
        },
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("Who are you?")],
        },
      ] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    const systemMessages = requestBody.messages.filter((message: any) => message.role === "system");

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).not.toContain(
      "You are Claude Code running inside Anthropic tools.",
    );
    expect(systemMessages[0].content).toContain(
      "You are GitHub Copilot using the OpenCode Go provider",
    );
    expect(systemMessages[0].content).toContain("DeepSeek V4 Flash");
    expect(systemMessages[0].content).toContain(
      "Answer identity/model questions as GitHub Copilot",
    );
    expect(systemMessages[0].content).not.toContain("Claude");
    expect(systemMessages[0].content).not.toContain("Anthropic tools");
  });

  it("adds DeepSeek-specific grounding guidance when tools are available", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [
            new vscode.LanguageModelTextPart(
              "まずワークスペース一覧を見てから最新ファイルを読んで要約して",
            ),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List a directory",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    const systemMessages = requestBody.messages.filter((message: any) => message.role === "system");

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain(
      "Use tools to inspect workspace state before answering.",
    );
    expect(systemMessages[0].content).toContain(
      "Never claim to have read files or listed directories without calling the corresponding tool first.",
    );
    expect(systemMessages[0].content).toContain(
      "If tool use is needed, emit the tool call directly.",
    );
    expect(systemMessages[0].content).toContain(
      "Base claims only on tool outputs you actually received.",
    );
    expect(systemMessages[0].content).toContain(
      "For read_file, always provide filePath and line ranges from editor context.",
    );
    expect(systemMessages[0].content).toContain(
      "Do not treat planning output as evidence about workspace structure or file contents.",
    );
  });

  it("adds tool grounding guidance for non-DeepSeek models too", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [
            new vscode.LanguageModelTextPart(
              "まずワークスペース一覧を見てから最新ファイルを読んで要約して",
            ),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List a directory",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    const systemMessages = requestBody.messages.filter((message: any) => message.role === "system");

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain(
      "For read_file, always provide filePath and line ranges from editor context.",
    );
    expect(systemMessages[0].content).toContain("If unknown, ask.");
  });

  it("logs outgoing OpenAI requests for DeepSeek models", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const prevDebug = process.env.OPENCODE_GO_DEBUG;
    process.env.OPENCODE_GO_DEBUG = "1";

    const debugSpy = jest.spyOn(outputChannel, "debugLog").mockImplementation(() => undefined);
    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(debugSpy).toHaveBeenCalledWith(
      "Outgoing request messages",
      expect.objectContaining({
        messages: expect.any(Array),
        tools: expect.any(Array),
        tool_choice: "auto",
      }),
    );

    process.env.OPENCODE_GO_DEBUG = prevDebug;
    debugSpy.mockRestore();
  });

  it("emits text that appears before a tool call in the same response", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "Let me check " } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(2);
    expect(progress.report.mock.calls[0][0]).toEqual(
      expect.objectContaining({ value: "Let me check " }),
    );
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ callId: "call_1", name: "get_weather" }),
    );
  });

  it("emits text that appears after a tool call in the same response", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
      yield { choices: [{ delta: { content: "Now I have the weather." } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(2);
    expect(progress.report.mock.calls[0][0]).toEqual(
      expect.objectContaining({ callId: "call_1", name: "get_weather" }),
    );
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ value: "Now I have the weather." }),
    );
  });

  it("sends required tool choice when tool mode requires a tool", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
        toolMode: 2,
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody.tool_choice).toBe("required");
  });

  it("routes DeepSeek tool calls through chat completions with explicit auto tool choice", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());
    global.fetch = jest.fn();

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody).toEqual(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        tool_choice: "auto",
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "get_weather" }),
          }),
        ]),
      }),
    );
  });

  it("maps DeepSeek max thinking variants to xhigh reasoning_effort", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-pro:max", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody).toEqual(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        reasoning_effort: "xhigh",
      }),
    );
  });

  it("reduces DeepSeek Flash reasoning_effort across retries without emitting retry text", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    let attempt = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      attempt += 1;
      return (async function* () {
        if (attempt < 3) {
          yield { choices: [{ delta: { reasoning_content: "thinking" } }] };
          return;
        }

        yield { choices: [{ delta: { content: "done" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash:max", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(3);
    expect(
      (streamChatCompletion as jest.Mock).mock.calls.map((call) => call[1]?.reasoning_effort),
    ).toEqual(["xhigh", "high", "medium"]);

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string");

    expect(emittedText).toEqual([
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      "done",
    ]);
  });

  it("returns a fallback text when all DeepSeek retries end with reasoning-only output", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const captureSpy = jest.spyOn(outputChannel, "captureLog").mockImplementation(() => undefined);

    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      return (async function* () {
        yield { choices: [{ delta: { reasoning_content: "thinking" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash:max", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(4);

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string");

    expect(emittedText).toEqual([
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      "The model completed internal reasoning but returned no visible response. Please retry. If this keeps happening, try a lower reasoning setting.",
    ]);

    expect(captureSpy).toHaveBeenCalledWith(
      "OpenAI exhausted no-output retries",
      expect.objectContaining({
        model: "deepseek-v4-flash",
        attempts: expect.arrayContaining([
          expect.objectContaining({
            attempt: 1,
            requestBody: expect.objectContaining({
              model: "deepseek-v4-flash",
              reasoning_effort: "xhigh",
            }),
          }),
          expect.objectContaining({
            attempt: 4,
            requestBody: expect.objectContaining({
              model: "deepseek-v4-flash",
              reasoning_effort: "low",
            }),
          }),
        ]),
      }),
    );

    captureSpy.mockRestore();
  });

  it("returns a fallback text when the model yields no visible output at all", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {};
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string");

    expect(emittedText).toEqual(["The model returned no visible response. Please retry."]);
  });

  it("retries silent DeepSeek responses before succeeding", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    let attempt = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      attempt += 1;
      return (async function* () {
        if (attempt < 3) {
          return;
        }

        yield { choices: [{ delta: { content: "done" } }] };
      })();
    });

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash:max", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(3);
    expect(
      (streamChatCompletion as jest.Mock).mock.calls.map((call) => call[1]?.reasoning_effort),
    ).toEqual(["xhigh", "high", "medium"]);

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string");

    expect(emittedText).toEqual(["done"]);
  });

  it("does not retry when visible text is buffered alongside reasoning output", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { reasoning_content: "thinking" } }] };
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-flash:max", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      { modelOptions: {} } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const emittedText = progress.report.mock.calls
      .map((call: any[]) => call[0]?.value)
      .filter((value: unknown): value is string => typeof value === "string");

    expect(emittedText).toEqual([
      '<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\n',
      "thinking",
      "\n</details>\n\n",
      "done",
    ]);
  });

  it("retries incomplete tool calls even when no reasoning content is emitted", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    let attempt = 0;
    (streamChatCompletion as jest.Mock).mockImplementation(() => {
      attempt += 1;
      return (async function* () {
        if (attempt === 1) {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city": ' },
                    },
                  ],
                },
              },
            ],
          };
          return;
        }

        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                  },
                ],
              },
            },
          ],
        };
      })();
    });

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    expect(streamChatCompletion).toHaveBeenCalledTimes(2);

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0]).toEqual(
      expect.objectContaining({
        callId: "call_1",
        name: "get_weather",
        input: { city: "Tokyo" },
      }),
    );
  });

  it("assembles tool call arguments split across chunks", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city": ' },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"Tokyo"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Hi" }] }] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports.length).toBe(1);
    expect(toolCallReports[0][0].input).toEqual({ city: "Tokyo" });
  });

  it("does not emit tool calls with empty arguments when schema requires fields", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(0);
  });

  it("returns a text fallback when all tool calls are skipped as invalid", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");
    const captureSpy = jest.spyOn(outputChannel, "captureLog").mockImplementation(() => undefined);

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toContain("filePath");
    expect(textReports[0][0].value).toContain("read_file");
    expect(captureSpy).not.toHaveBeenCalled();

    captureSpy.mockRestore();
  });

  it("returns a text fallback when invalid tool calls are preceded by whitespace content", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: " " } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);
    expect(textReports).toHaveLength(1);
    expect(textReports[0][0].value).toContain("filePath");
    expect(textReports[0][0].value).toContain("read_file");
  });

  it("emits a tool call parsed from text-embedded control tokens", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/example.md"}<|tool_call_end|>',
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("preserves text order around a text-embedded tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                'Before <|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/example.md"}<|tool_call_end|> after',
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    expect(progress.report.mock.calls).toHaveLength(3);
    expect(progress.report.mock.calls[0][0]).toEqual(expect.objectContaining({ value: "Before " }));
    expect(progress.report.mock.calls[1][0]).toEqual(
      expect.objectContaining({ name: "read_file" }),
    );
    expect(progress.report.mock.calls[2][0]).toEqual(expect.objectContaining({ value: " after" }));
  });

  it("emits a tool call when text-embedded control tokens are split across chunks", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/tmp/exa',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content: 'mple.md"}<|tool_call_end|>',
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Read the file" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: { filePath: { type: "string" } },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    const textReports = progress.report.mock.calls.filter((c: any) => c[0]?.value);

    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
    expect(textReports).toHaveLength(0);
  });

  it("repairs empty read_file arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 158 to line 158.\n</editorContext>\n<userRequest>ツールを使ってファイルを読み込んでみてください</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 158,
      endLine: 158,
    });
  });

  it("repairs missing read_file line arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: '{"filePath":"/tmp/example.md"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the current selection</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 42,
      endLine: 45,
    });
  });

  it("does not inject selection lines when read_file line arguments are optional", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: '{"filePath":"/tmp/example.md"}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 42 to line 45.\n</editorContext>\n<userRequest>Read the whole file</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("repairs read_file with the current file path even when no selection lines are provided", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Read the open file</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
              },
              required: ["filePath"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({ filePath: "/tmp/example.md" });
  });

  it("defaults read_file line arguments when the schema requires a range but chat only provides the current file", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:0",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<editorContext>\nThe user's current file is /tmp/example.md. \n</editorContext>\n<userRequest>Check the current file</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 1,
      endLine: 200,
    });
  });

  it("repairs list_dir with the current working directory from chat context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "list_dir:0",
                  type: "function",
                  function: { name: "list_dir", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<context>\nCwd: /tmp/workspace\n</context>\n<userRequest>List files in the current directory</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "list_dir",
            description: "List files in a directory",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("list_dir");
    expect(toolCallReports[0][0].input).toEqual({ path: "/tmp/workspace" });
  });

  it("waits for later streamed arguments before validating a tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "grep_search:0",
                  type: "function",
                  function: { name: "grep_search" },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"query":"causal","isRegexp":false}' },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [{ role: 1, content: [{ value: "Test the memory tool" }] }] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "grep_search",
            description: "Search notes by text",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query",
                },
                isRegexp: {
                  type: "boolean",
                  description: "Whether query is a regular expression",
                },
              },
              required: ["query", "isRegexp"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("grep_search");
    expect(toolCallReports[0][0].input).toEqual({ query: "causal", isRegexp: false });
  });

  it("repairs text-embedded read_file arguments from editor context", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              content:
                "<|tool_call_begin|>read_file<|tool_call_argument_begin|>{}<|tool_call_end|>",
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 1,
          content: [
            {
              value:
                "<editorContext>\nThe user's current file is /tmp/example.md. The current selection is from line 10 to line 12.\n</editorContext>\n<userRequest>Read the selected lines</userRequest>",
            },
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0].name).toBe("read_file");
    expect(toolCallReports[0][0].input).toEqual({
      filePath: "/tmp/example.md",
      startLine: 10,
      endLine: 12,
    });
  });

  it("suppresses an immediate duplicate of the just-completed tool call", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":158,"endLine":158}',
                  },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("read_file:0", [
              new (vscode as any).LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(0);
  });

  it("allows the same tool call again after an intervening user message", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "read_file:1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"filePath":"/tmp/example.md","startLine":158,"endLine":158}',
                  },
                },
              ],
            },
          },
        ],
      };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelToolCallPart("read_file:0", "read_file", {
              filePath: "/tmp/example.md",
              startLine: 158,
              endLine: 158,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("read_file:0", [
              new (vscode as any).LanguageModelTextPart("**③ パネル・データ分析（差分の差分法）**"),
            ]),
          ],
        },
        {
          role: 1,
          content: [new (vscode as any).LanguageModelTextPart("Read that same line again.")],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const toolCallReports = progress.report.mock.calls.filter((c: any) => c[0]?.callId);
    expect(toolCallReports).toHaveLength(1);
    expect(toolCallReports[0][0]).toEqual(
      expect.objectContaining({ callId: "read_file:1", name: "read_file" }),
    );
  });

  it("sends non-empty reasoning_content for assistant tool call history", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "kimi-k2.6", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelTextPart("Let me check"),
            new (vscode as any).LanguageModelToolCallPart("call_1", "get_weather", {
              city: "Tokyo",
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("call_1", [
              new (vscode as any).LanguageModelTextPart("Sunny, 25C"),
            ]),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: {} }],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];
    expect(requestBody).toBeDefined();
    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: " ",
          tool_calls: expect.any(Array),
        }),
      ]),
    );
  });

  it("sends reasoning_content for DeepSeek OpenAI assistant tool call history", async () => {
    (secrets.get as jest.Mock).mockResolvedValue("test-key");

    const mockStream = async function* () {
      yield { choices: [{ delta: { content: "done" } }] };
    };
    (streamChatCompletion as jest.Mock).mockReturnValue(mockStream());

    const progress = { report: jest.fn() };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
    };

    await provider.provideLanguageModelChatResponse(
      { id: "deepseek-v4-pro", maxInputTokens: 100000, maxOutputTokens: 65536 } as any,
      [
        {
          role: 2,
          content: [
            new (vscode as any).LanguageModelTextPart("Let me check"),
            new (vscode as any).LanguageModelToolCallPart("call_1", "read_file", {
              filePath: "/tmp/example.ts",
              startLine: 1,
              endLine: 2,
            }),
          ],
        },
        {
          role: 1,
          content: [
            new (vscode as any).LanguageModelToolResultPart("call_1", [
              new (vscode as any).LanguageModelTextPart("const x = 1;"),
            ]),
          ],
        },
      ] as any,
      {
        modelOptions: {},
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            inputSchema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                startLine: { type: "number" },
                endLine: { type: "number" },
              },
              required: ["filePath", "startLine", "endLine"],
            },
          },
        ],
      } as any,
      progress,
      token as any,
    );

    const requestBody = (streamChatCompletion as jest.Mock).mock.calls.at(-1)?.[1];

    expect(requestBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: " ",
        }),
      ]),
    );
  });
});
