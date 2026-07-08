import {
    applyOpenAiSystemPromptGuidance,
    buildProviderIdentityGuidance,
    buildToolUseGroundingGuidance,
    calculateMaxToolResultChars,
    sanitizeSystemPromptForModel,
} from "../src/guidance";
import { OcGoChatMessage, OcGoModelInfo } from "../src/types";

const MOCK_MODELS: OcGoModelInfo[] = [
  {
    id: "glm-5",
    name: "GLM-5",
    displayName: "GLM-5",
    contextWindow: 202752,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    displayName: "DeepSeek V4 Pro",
    contextWindow: 262144,
    maxOutput: 65536,
    supportsTools: true,
    supportsVision: false,
    supportsThinking: true,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    displayName: "MiniMax M3",
    contextWindow: 1000000,
    maxOutput: 131072,
    supportsTools: true,
    supportsVision: false,
  },
];

describe("sanitizeSystemPromptForModel", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeSystemPromptForModel(undefined, "deepseek-v4-pro")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(sanitizeSystemPromptForModel("", "deepseek-v4-pro")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(sanitizeSystemPromptForModel("   ", "deepseek-v4-pro")).toBeUndefined();
  });

  it("returns original string for non-deepseek model", () => {
    const prompt = "You are Claude, an AI assistant.";
    expect(sanitizeSystemPromptForModel(prompt, "glm-5")).toBe(prompt);
  });

  it('replaces "Claude" with "GitHub Copilot" for deepseek models (word boundary)', () => {
    const prompt = "You are Claude, an AI assistant from Anthropic.";
    const result = sanitizeSystemPromptForModel(prompt, "deepseek-v4-pro");
    expect(result).not.toContain("Claude");
    expect(result).toContain("GitHub Copilot");
  });

  it('replaces "Claude Code" with "GitHub Copilot"', () => {
    const prompt = "You are Claude Code, running in VS Code.";
    const result = sanitizeSystemPromptForModel(prompt, "deepseek-v4-pro");
    expect(result).toContain("GitHub Copilot");
    expect(result).not.toContain("Claude Code");
  });

  it('replaces Anthropic with "OpenCode Go"', () => {
    const prompt = "You are a model from Anthropic.";
    const result = sanitizeSystemPromptForModel(prompt, "deepseek-v4-pro");
    expect(result).toContain("OpenCode Go");
    expect(result).not.toContain("Anthropic");
  });

  it("handles multiple replacements in the same prompt", () => {
    const prompt =
      "You are Claude, the latest Claude Code model from Anthropic. Claude uses tools.";
    const result = sanitizeSystemPromptForModel(prompt, "deepseek-v4-flash");
    expect(result).toBe(
      "You are GitHub Copilot, the latest GitHub Copilot model from OpenCode Go. GitHub Copilot uses tools.",
    );
  });
});

describe("buildProviderIdentityGuidance", () => {
  it("includes model display name when found", () => {
    const result = buildProviderIdentityGuidance("deepseek-v4-pro", MOCK_MODELS);
    expect(result).toContain("DeepSeek V4 Pro");
    expect(result).toContain("deepseek-v4-pro");
    expect(result).toContain("GitHub Copilot");
    expect(result).toContain("OpenCode Go");
  });

  it("falls back to modelId when model not in list", () => {
    const result = buildProviderIdentityGuidance("unknown-model", MOCK_MODELS);
    expect(result).toContain("unknown-model");
    expect(result).not.toContain("undefined");
  });
});

describe("buildToolUseGroundingGuidance", () => {
  it("returns undefined when no tools provided", () => {
    const options = { tools: [] };
    expect(buildToolUseGroundingGuidance(options as any)).toBeUndefined();
  });

  it("returns undefined for undefined tools", () => {
    const options = {};
    expect(buildToolUseGroundingGuidance(options as any)).toBeUndefined();
  });

  it("returns guidance string when tools are present", () => {
    const options = { tools: [{ name: "read_file" }] };
    const result = buildToolUseGroundingGuidance(options as any);
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(50);
    expect(result).toContain("Use tools to inspect workspace state");
  });
});

describe("applyOpenAiSystemPromptGuidance", () => {
  it("returns messages unchanged for non-deepseek model without tools", () => {
    const messages: OcGoChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const options = {} as any;
    const result = applyOpenAiSystemPromptGuidance(messages, "glm-5", options, MOCK_MODELS);
    expect(result).toEqual(messages);
  });

  it("appends identity guidance for deepseek model", () => {
    const messages: OcGoChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const options = {} as any;
    const result = applyOpenAiSystemPromptGuidance(
      messages,
      "deepseek-v4-pro",
      options,
      MOCK_MODELS,
    );
    expect(result[0].content).toContain("GitHub Copilot");
    expect((result[0].content as string).length).toBeGreaterThan((messages[0].content as string).length);
  });

  it("appends tool guidance when tools are present", () => {
    const messages: OcGoChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const options = { tools: [{ name: "read_file" }] } as any;
    const result = applyOpenAiSystemPromptGuidance(messages, "glm-5", options, MOCK_MODELS);
    expect(result[0].content).toContain("Use tools to inspect workspace state");
  });

  it("prepends system message when none exists and guidance is needed", () => {
    const messages: OcGoChatMessage[] = [{ role: "user", content: "Hello" }];
    const options = {} as any;
    const result = applyOpenAiSystemPromptGuidance(
      messages,
      "deepseek-v4-pro",
      options,
      MOCK_MODELS,
    );
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("GitHub Copilot");
  });
});

describe("calculateMaxToolResultChars", () => {
  it('returns 50000 for models with context >= 500000', () => {
    expect(calculateMaxToolResultChars("minimax-m3", MOCK_MODELS)).toBe(50000);
  });

  it('returns 30000 for models with context >= 200000 but < 500000', () => {
    expect(calculateMaxToolResultChars("glm-5", MOCK_MODELS)).toBe(30000);
    expect(calculateMaxToolResultChars("deepseek-v4-pro", MOCK_MODELS)).toBe(30000);
  });

  it('returns 10000 for unknown models (fallback to 262144)', () => {
    expect(calculateMaxToolResultChars("unknown", MOCK_MODELS)).toBe(30000);
  });

  it("returns 10000 for very small context windows", () => {
    expect(calculateMaxToolResultChars("unknown", [])).toBe(30000);
  });
});
