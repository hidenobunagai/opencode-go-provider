import { OcGoAnalyzeImageTool, registerOcGoTools } from "../src/tools";

jest.mock("vscode", () => ({
  LanguageModelToolResult: class {
    constructor(public content: Array<{ value: string }>) {}
  },
  LanguageModelTextPart: class {
    constructor(public value: string) {}
  },
  Disposable: {
    from: jest.fn(() => ({ dispose: jest.fn() })),
  },
  lm: {
    registerTool: jest.fn(() => ({ dispose: jest.fn() })),
  },
}));

jest.mock("../src/mcp", () => ({
  OcGoMcpClient: jest.fn().mockImplementation(() => ({
    analyzeImage: jest.fn().mockResolvedValue("Analyzed result"),
  })),
}));

describe("OcGoAnalyzeImageTool", () => {
  let tool: OcGoAnalyzeImageTool;
  let secrets: { get: jest.Mock };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })),
  };

  beforeEach(() => {
    secrets = { get: jest.fn() };
    tool = new OcGoAnalyzeImageTool(secrets as any, "test-ua");
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("opencode_go_analyze_image");
    expect(tool.description).toContain("Analyze an image");
    expect(tool.tags).toContain("vision");
  });

  it("invokes analyzeImage successfully", async () => {
    const result = await tool.invoke(
      {
        input: { image_data: "data:image/png;base64,abc", prompt: "What is this?" },
      } as any,
      token as any,
    );
    expect((result.content[0] as any).value).toBe("Analyzed result");
  });

  it("handles analyzeImage errors gracefully", async () => {
    const { OcGoMcpClient } = require("../src/mcp");
    OcGoMcpClient.mockImplementationOnce(() => ({
      analyzeImage: jest.fn().mockRejectedValue(new Error("API down")),
    }));
    const failingTool = new OcGoAnalyzeImageTool(secrets as any, "test-ua");
    const result = await failingTool.invoke(
      {
        input: { image_data: "data:image/png;base64,abc", prompt: "What?" },
      } as any,
      token as any,
    );
    expect((result.content[0] as any).value).toContain("Failed to analyze image");
    expect((result.content[0] as any).value).toContain("API down");
  });

  it("prepareInvocation returns invocation message", async () => {
    const prepared = await tool.prepareInvocation!(
      { input: { image_data: "", prompt: "" } } as any,
      token as any,
    );
    expect(prepared).toEqual({ invocationMessage: "Analyzing image with OpenCode Go Vision..." });
  });
});

describe("registerOcGoTools", () => {
  it("returns a disposable", () => {
    const secrets = { get: jest.fn() } as any;
    const disposable = registerOcGoTools(secrets, "test-ua");
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
  });
});
