import * as vscode from "vscode";
import { OcGoChatMessage } from "../src/types";
import {
  convertMessages,
  convertTools,
  estimateMessagesTokens,
  estimateTokens,
  preloadTiktoken,
  extractReasoningContent,
} from "../src/utils";

describe("convertMessages", () => {
  it("converts user text message", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart("Hello")],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toEqual<OcGoChatMessage[]>([{ role: "user", content: "Hello" }]);
  });

  it("converts assistant text message", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [new vscode.LanguageModelTextPart("Hi there")],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toEqual<OcGoChatMessage[]>([{ role: "assistant", content: "Hi there" }]);
  });

  it("converts system text message", () => {
    const messages = [
      {
        role: (vscode as any).LanguageModelChatMessageRole.System,
        content: [new vscode.LanguageModelTextPart("Be helpful")],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toEqual<OcGoChatMessage[]>([{ role: "system", content: "Be helpful" }]);
  });

  it("handles empty messages", () => {
    const messages = [{ role: vscode.LanguageModelChatMessageRole.User, content: [] }];
    const result = convertMessages(messages as any);
    expect(result).toEqual<OcGoChatMessage[]>([{ role: "user", content: "" }]);
  });

  it("converts image parts to base64", () => {
    const imageData = new Uint8Array([1, 2, 3]);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [{ mimeType: "image/png", data: imageData }],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const content = result[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("extracts reasoning content from details block", () => {
    const rawText = `<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\nThinking process here\n</details>\n\nActual response here`;
    const result = extractReasoningContent(rawText);
    expect(result.content).toBe("Actual response here");
    expect(result.reasoningContent).toBe("Thinking process here");
  });

  it("extracts reasoning content from markdown blockquote", () => {
    const rawText = `> **[思考プロセス (Thinking Process)]**\n> Thinking process line 1\n> Thinking process line 2\n\n---\n\nActual response here`;
    const result = extractReasoningContent(rawText);
    expect(result.content).toBe("Actual response here");
    expect(result.reasoningContent).toBe("Thinking process line 1\nThinking process line 2");
  });

  it("converts assistant message with reasoning details block", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new vscode.LanguageModelTextPart(
            `<details data-reasoning="true">\n<summary>思考プロセス (Thinking Process)</summary>\n\nThinking process here\n</details>\n\nActual response here`,
          ),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toEqual<OcGoChatMessage[]>([
      {
        role: "assistant",
        content: "Actual response here",
        reasoning_content: "Thinking process here",
      },
    ]);
  });

  it("uses cached reasoning content if no block is present in text", () => {
    const { reasoningCache } = require("../src/openai-conversion");
    reasoningCache.set("Actual response here", "Cached thinking process");

    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [new vscode.LanguageModelTextPart("Actual response here")],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result[0].reasoning_content).toBe("Cached thinking process");
    reasoningCache.clear();
  });
});

describe("estimateTokens", () => {
  it("estimates tokens for ASCII text", () => {
    expect(estimateTokens("Hello world")).toBeGreaterThan(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates tokens for multiple messages", () => {
    const messages = [
      { content: [new vscode.LanguageModelTextPart("Hello")] },
      { content: [new vscode.LanguageModelTextPart("world")] },
    ];
    expect(estimateMessagesTokens(messages as any)).toBe(
      estimateTokens("Hello") + estimateTokens("world"),
    );
  });
});

describe("convertTools", () => {
  it("returns empty object when no tools", () => {
    const result = convertTools({ tools: [] } as any);
    expect(result).toEqual({});
  });

  it("converts VS Code tools to OpenCode Go format", () => {
    const result = convertTools({
      tools: [
        {
          name: "test_tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as any);
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0].type).toBe("function");
    expect(result.tools?.[0].function.name).toBe("test_tool");
    expect(result.tool_choice).toBe("auto");
  });

  it("augments tool descriptions with required parameter guidance", () => {
    const result = convertTools({
      tools: [
        {
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Absolute path to the file" },
              offset: { type: "number" },
            },
            required: ["filePath"],
          },
        },
      ],
    } as any);
    expect(result.tools).toHaveLength(1);
    const description = result.tools?.[0].function.description ?? "";
    expect(description).toContain("Required arguments");
    expect(description).toContain("filePath");
    expect(description).toContain("Return a valid JSON object");
  });

  it("includes enum choices for required string arguments", () => {
    const result = convertTools({
      tools: [
        {
          name: "memory",
          description: "Manage persistent memory",
          inputSchema: {
            type: "object",
            properties: {
              command: {
                type: "string",
                enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
                description: "Memory operation to perform",
              },
              path: {
                type: "string",
                description: "Target memory path",
              },
            },
            required: ["command"],
          },
        },
      ],
    } as any);

    const description = result.tools?.[0].function.description ?? "";
    expect(description).toContain("command");
    expect(description).toContain("Required arguments");
    expect(description).toContain("Allowed values");
    expect(description).toContain("view");
    expect(description).toContain("create");
  });
});

describe("convertMessages with tools", () => {
  it("converts tool call parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new vscode.LanguageModelTextPart("Let me check"),
          new vscode.LanguageModelToolCallPart("call_1", "get_weather", { city: "Tokyo" }),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].reasoning_content).toBe(" ");
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls?.[0].function.name).toBe("get_weather");
  });

  it("converts tool result parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart("Sunny, 25C"),
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_1");
    expect(result[0].content).toBe("Sunny, 25C");
  });

  it("converts structured tool result parts via value field", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { value: { filePath: "/tmp/a.txt", content: "hello" } },
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].tool_call_id).toBe("call_1");
    expect(result[0].content).toContain("filePath");
    expect(result[0].content).toContain("/tmp/a.txt");
    expect(result[0].content).toContain("hello");
  });

  it("drops cache-control metadata from tool result parts", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { mimeType: "cache_control", data: "ZXBoZW1lcmFs" },
            new vscode.LanguageModelTextPart("real result"),
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("real result");
  });

  it("decodes base64 json data parts in tool results", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({ filePath: "/tmp/a.txt", content: "hello" }),
      "utf8",
    );
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { $mid: 24, mimeType: "application/json", data: jsonBytes.toString("base64") },
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toContain("filePath");
    expect(result[0].content).toContain("/tmp/a.txt");
    expect(result[0].content).toContain("hello");
  });

  it("keeps plain text data strings unchanged even if they look like base64", () => {
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            { $mid: 24, mimeType: "text/plain", data: "eyJ9" },
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("eyJ9");
  });

  it("truncates tool result content when maxToolResultChars is set", () => {
    const longContent = "a".repeat(100);
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart(longContent),
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any, { maxToolResultChars: 50 });
    expect(result[0].content).toBe("a".repeat(50) + "…");
  });

  it("does not truncate when content is within limit", () => {
    const shortContent = "short content";
    const messages = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelToolResultPart("call_1", [
            new vscode.LanguageModelTextPart(shortContent),
          ]),
        ],
      },
    ];
    const result = convertMessages(messages as any, { maxToolResultChars: 100 });
    expect(result[0].content).toBe(shortContent);
  });
});

describe("applyReasoningContentWorkaround", () => {
  it("adds reasoning_content for Kimi K2.6", () => {
    const { applyReasoningContentWorkaround } = require("../src/utils");
    const messages: OcGoChatMessage[] = [{ role: "assistant", content: "Hello" }];
    const result = applyReasoningContentWorkaround(messages, "kimi-k2.6");
    expect(result[0].reasoning_content).toBe(" ");
  });

  it("adds reasoning_content for DeepSeek V4 Pro", () => {
    const { applyReasoningContentWorkaround } = require("../src/utils");
    const messages: OcGoChatMessage[] = [{ role: "assistant", content: "Hello" }];
    const result = applyReasoningContentWorkaround(messages, "deepseek-v4-pro");
    expect(result[0].reasoning_content).toBe(" ");
  });

  it("does not add reasoning_content for other models", () => {
    const { applyReasoningContentWorkaround } = require("../src/utils");
    const messages: OcGoChatMessage[] = [{ role: "assistant", content: "Hello" }];
    const result = applyReasoningContentWorkaround(messages, "glm-5");
    expect(result[0].reasoning_content).toBeUndefined();
  });

  it("preserves existing reasoning_content", () => {
    const { applyReasoningContentWorkaround } = require("../src/utils");
    const messages: OcGoChatMessage[] = [
      { role: "assistant", content: "Hello", reasoning_content: "existing" },
    ];
    const result = applyReasoningContentWorkaround(messages, "kimi-k2.6");
    expect(result[0].reasoning_content).toBe("existing");
  });
});

describe("preloadTiktoken", () => {
  it("does not throw when called", () => {
    expect(() => preloadTiktoken()).not.toThrow();
  });

  it("is idempotent", () => {
    preloadTiktoken();
    expect(() => preloadTiktoken()).not.toThrow();
  });
});
