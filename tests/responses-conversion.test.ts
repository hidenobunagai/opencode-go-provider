import * as vscode from "vscode";
import { convertMessagesToResponses, convertToolsToResponses } from "../src/responses-conversion";
import { OcGoChatMessage } from "../src/types";

describe("convertMessagesToResponses", () => {
  it("hoists system messages into instructions", () => {
    const messages: OcGoChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];
    const { input, instructions } = convertMessagesToResponses(messages);
    expect(instructions).toBe("You are a helpful assistant.");
    expect(input).toEqual([{ type: "message", role: "user", content: "Hi" }]);
  });

  it("joins multiple system messages with blank lines", () => {
    const messages: OcGoChatMessage[] = [
      { role: "system", content: "First." },
      { role: "system", content: "Second." },
    ];
    const { input, instructions } = convertMessagesToResponses(messages);
    expect(instructions).toBe("First.\n\nSecond.");
    expect(input).toEqual([]);
  });

  it("converts user content parts to input_text/input_image", () => {
    const messages: OcGoChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    const { input } = convertMessagesToResponses(messages);
    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look at this" },
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
    ]);
  });

  it("converts assistant tool calls into function_call items", () => {
    const messages: OcGoChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ];
    const { input } = convertMessagesToResponses(messages);
    expect(input).toEqual([
      { type: "message", role: "assistant", content: [] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
    ]);
  });

  it("keeps assistant text alongside tool calls", () => {
    const messages: OcGoChatMessage[] = [
      {
        role: "assistant",
        content: "Reading the file.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
    ];
    const { input } = convertMessagesToResponses(messages);
    expect(input).toEqual([
      { type: "message", role: "assistant", content: "Reading the file." },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    ]);
  });

  it("skips empty messages", () => {
    const messages: OcGoChatMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
      { role: "system", content: "" },
    ];
    const { input, instructions } = convertMessagesToResponses(messages);
    expect(input).toEqual([]);
    expect(instructions).toBeUndefined();
  });
});

describe("convertToolsToResponses", () => {
  function makeOptions(toolMode?: unknown) {
    return {
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      toolMode,
    } as any;
  }

  it("converts tools to Responses API function format", () => {
    const { tools, tool_choice } = convertToolsToResponses(makeOptions());
    expect(tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: expect.any(String),
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(tool_choice).toBe("auto");
  });

  it("maps required tool mode to required choice", () => {
    (vscode as any).LanguageModelChatToolMode = { Required: 2 };
    const { tool_choice } = convertToolsToResponses(makeOptions(2));
    expect(tool_choice).toBe("required");
  });

  it("defaults parameters for tools without an inputSchema (strict backends)", () => {
    const { tools } = convertToolsToResponses({
      tools: [{ name: "no_schema_tool", description: "No schema" }],
    } as any);
    // Meta's Muse Spark /responses backend rejects function tools with no
    // `parameters` ("did not match any supported type"), so it must be defaulted.
    expect(tools).toEqual([
      {
        type: "function",
        name: "no_schema_tool",
        description: expect.any(String),
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("returns empty config when no tools are provided", () => {
    const { tools, tool_choice } = convertToolsToResponses({ tools: [] } as any);
    expect(tools).toBeUndefined();
    expect(tool_choice).toBeUndefined();
  });
});
