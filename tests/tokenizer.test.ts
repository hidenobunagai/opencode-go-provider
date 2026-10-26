import * as vscode from "vscode";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimatePartTokens,
  estimateTokens,
  IMAGE_BASELINE_TOKENS,
  TOOL_CALL_BASE_TOKENS,
} from "../src/tokenizer";

describe("estimateTokens", () => {
  it("calculates tokens accurately for mixed English and Japanese CJK text", () => {
    // 4 CJK chars (、世界。) + 5 Latin chars (Hello) = 4 + ceil(5/2) = 7
    expect(estimateTokens("Hello、世界。")).toBe(7);
    // 5 CJK chars (こんにちは) = 5
    expect(estimateTokens("こんにちは")).toBe(5);
    // 11 Latin chars ("Hello world") = ceil(11/2) = 6
    expect(estimateTokens("Hello world")).toBe(6);
  });

  it("returns zero for empty string and whitespace-only inputs", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
    expect(estimateTokens("\t\n  \r\n")).toBe(0);
  });
});

describe("estimatePartTokens and estimateMessageTokens", () => {
  it("estimates tokens for LanguageModelTextPart", () => {
    const textPart = new vscode.LanguageModelTextPart("Hello world");
    expect(estimatePartTokens(textPart)).toBe(6);
  });

  it("adds tool name and JSON argument tokens plus TOOL_CALL_BASE_TOKENS for LanguageModelToolCallPart", () => {
    const toolCall = new vscode.LanguageModelToolCallPart("call_1", "read_file", {
      path: "main.ts",
    });
    // name "read_file": 9 chars -> ceil(9/2) = 5
    // JSON '{"path":"main.ts"}': 17 chars -> ceil(17/2) = 9
    // base: TOOL_CALL_BASE_TOKENS = 8
    // total = 8 + 5 + 9 = 22
    const expected =
      TOOL_CALL_BASE_TOKENS +
      estimateTokens("read_file") +
      estimateTokens(JSON.stringify({ path: "main.ts" }));
    expect(expected).toBe(22);
    expect(estimatePartTokens(toolCall)).toBe(expected);
  });

  it("accumulates tokens accurately for LanguageModelToolResultPart with multiline and large output", () => {
    const multilineText = "line 1\nline 2\nline 3\nline 4";
    const largeText = "x".repeat(5000);
    const toolResult = new vscode.LanguageModelToolResultPart("call_1", [
      new vscode.LanguageModelTextPart(multilineText),
      new vscode.LanguageModelTextPart(largeText),
    ]);

    const expectedContent = `${multilineText}\n${largeText}`.trim();
    const expectedTokens = estimateTokens(expectedContent);
    expect(expectedTokens).toBeGreaterThan(2500);
    expect(estimatePartTokens(toolResult)).toBe(expectedTokens);
  });

  it("returns IMAGE_BASELINE_TOKENS for image parts", () => {
    const imagePart = {
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3, 4]),
    };
    expect(IMAGE_BASELINE_TOKENS).toBe(1000);
    expect(estimatePartTokens(imagePart as any)).toBe(IMAGE_BASELINE_TOKENS);
  });

  it("returns 0 for unknown/unsupported parts", () => {
    const unknownPart = { foo: "bar" };
    expect(estimatePartTokens(unknownPart as any)).toBe(0);
  });

  it("estimates tokens for data parts", () => {
    const dataPart = {
      mimeType: "text/plain",
      data: Buffer.from("data content text"),
    };
    expect(estimatePartTokens(dataPart as any)).toBe(estimateTokens("data content text"));
  });

  it("handles tool call with missing or circular args gracefully", () => {
    const toolCallNoArgs = new vscode.LanguageModelToolCallPart(
      "call_2",
      "run_cmd",
      undefined as any,
    );
    expect(estimatePartTokens(toolCallNoArgs)).toBe(
      TOOL_CALL_BASE_TOKENS + estimateTokens("run_cmd") + estimateTokens("{}"),
    );

    const toolCallNoName = { callId: "call_3", name: undefined as any, input: {} };
    expect(estimatePartTokens(toolCallNoName as any)).toBe(0);

    const circular: any = {};
    circular.self = circular;
    const toolCallCircular = new vscode.LanguageModelToolCallPart("call_3", "cmd", circular);
    expect(estimatePartTokens(toolCallCircular)).toBeGreaterThan(0);
  });

  it("handles non-array or missing content in estimateMessageTokens and estimateMessagesTokens", () => {
    expect(estimateMessageTokens(null as any)).toBe(0);
    expect(estimateMessageTokens({ content: null as any })).toBe(0);
    expect(estimateMessagesTokens(null as any)).toBe(0);
  });

  it("calculates sum of tokens across mixed messages with text, tool calls, and tool results", () => {
    const textPart = new vscode.LanguageModelTextPart("Please read this file.");
    const toolCallPart = new vscode.LanguageModelToolCallPart("call_1", "read_file", {
      path: "src/index.ts",
    });
    const toolResultPart = new vscode.LanguageModelToolResultPart("call_1", [
      new vscode.LanguageModelTextPart("export const a = 1;\nexport const b = 2;"),
    ]);

    const message1 = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [textPart],
    };
    const message2 = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [toolCallPart],
    };
    const message3 = {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [toolResultPart],
    };

    const msg1Tokens = estimateMessageTokens(message1);
    const msg2Tokens = estimateMessageTokens(message2);
    const msg3Tokens = estimateMessageTokens(message3);

    expect(msg1Tokens).toBe(estimatePartTokens(textPart));
    expect(msg2Tokens).toBe(estimatePartTokens(toolCallPart));
    expect(msg3Tokens).toBe(estimatePartTokens(toolResultPart));

    const total = estimateMessagesTokens([message1, message2, message3]);
    expect(total).toBe(msg1Tokens + msg2Tokens + msg3Tokens);
  });
});
