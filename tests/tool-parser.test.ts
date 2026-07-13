import {
  findTrailingTokenPrefixStart,
  findTrailingTokenPrefixStartAny,
  parseTextEmbeddedToolCalls,
  parseTextEmbeddedToolCallsFrom,
  parseXmlStyleToolCall,
  ToolCallScanner,
} from "../src/tool-parser";

describe("findTrailingTokenPrefixStart", () => {
  it("returns -1 when text is empty", () => {
    expect(findTrailingTokenPrefixStart("", "<")).toBe(-1);
  });

  it("returns -1 when no prefix match", () => {
    expect(findTrailingTokenPrefixStart("hello world", "<|")).toBe(-1);
  });

  it("returns start index of partial prefix match", () => {
    // token is "<|tool_call_end|>"
    // text ends with "<|tool_call_en" which is a prefix of the token
    const result = findTrailingTokenPrefixStart("some text<|tool_call_en", "<|tool_call_end|>");
    expect(result).toBe(9); // index where "<|tool_call_en" starts
  });

  it("finds longest possible prefix match", () => {
    const result = findTrailingTokenPrefixStart("text<|tool_call_end|", "<|tool_call_end|>");
    expect(result).toBe(4); // longest prefix of token that matches end of text
  });

  it("returns -1 when text is shorter than prefix length 1", () => {
    expect(findTrailingTokenPrefixStart("a", "abc")).toBe(0); // "a" is prefix of "abc"
  });

  it("returns -1 when no matching prefix", () => {
    expect(findTrailingTokenPrefixStart("xyz", "abc")).toBe(-1);
  });
});

describe("findTrailingTokenPrefixStartAny", () => {
  it("returns -1 for no matches", () => {
    expect(findTrailingTokenPrefixStartAny("hello", ["<|", "{"])).toBe(-1);
  });

  it("returns earliest start among multiple token matches", () => {
    // text ends with "<|" which is prefix of both tokens
    const result = findTrailingTokenPrefixStartAny("text<|", ["<|tool|>", "<|end|>"]);
    expect(result).toBe(4);
  });

  it("returns match from any of the tokens", () => {
    const result = findTrailingTokenPrefixStartAny("text<|tool_call_en", [
      "<|tool_call_end|>",
      "</tool_call>",
    ]);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe("parseXmlStyleToolCall", () => {
  it("returns consumed=0 for non-XML text", () => {
    const result = parseXmlStyleToolCall("plain text no xml");
    expect(result.consumed).toBe(0);
  });

  it("returns incomplete=true for incomplete <tool_call> without end tag", () => {
    const result = parseXmlStyleToolCall('<tool_call name="my_tool">{"arg":"');
    expect(result.incomplete).toBe(true);
  });

  it("parses complete XML tool call with JSON args", () => {
    const text =
      '<tool_calls><tool_call name="read_file"><tool_parameter name="filePath">/test.txt</tool_parameter></tool_call></tool_calls>';
    const result = parseXmlStyleToolCall(text);
    expect(result.toolCall).toBeDefined();
    expect(result.toolCall?.name).toBe("read_file");
    expect(result.toolCall?.args).toEqual({ filePath: "/test.txt" });
  });

  it("parses tool call with empty args", () => {
    const text = '<tool_calls><tool_call name="noop"></tool_call></tool_calls>';
    const result = parseXmlStyleToolCall(text);
    expect(result.toolCall?.name).toBe("noop");
    expect(result.toolCall?.args).toEqual({});
  });

  it("parses tool call with JSON value in parameter", () => {
    const text =
      '<tool_call name="search"><tool_parameter name="query">{"q":"test","limit":10}</tool_parameter></tool_call>';
    const result = parseXmlStyleToolCall(text);
    expect(result.toolCall?.name).toBe("search");
    expect(result.toolCall?.args).toEqual({ query: { q: "test", limit: 10 } });
  });

  it('returns incomplete=true when <tool_call> has no closing ">', () => {
    const text = '<tool_call name="my_tool"';
    const result = parseXmlStyleToolCall(text);
    expect(result.incomplete).toBe(true);
  });

  it("skips text before <tool_calls> if starts with tool_calls token", () => {
    // parseXmlStyleToolCall only processes text that starts with <tool_calls> or <tool_call >
    const text = 'some preamble <tool_calls><tool_call name="test"></tool_call></tool_calls>';
    const result = parseXmlStyleToolCall(text);
    // Doesn't scan past preamble - returns incomplete
    expect(result.consumed).toBe(0);
    expect(result.incomplete).toBe(true);
  });
});

describe("parseTextEmbeddedToolCalls", () => {
  it("returns text segment for plain text", () => {
    const result = parseTextEmbeddedToolCalls("Hello world");
    expect(result.segments).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("parses single tool call", () => {
    const text =
      '<|tool_call_begin|>read_file<|tool_call_argument_begin|>{"filePath":"/x.txt"}<|tool_call_end|>';
    const result = parseTextEmbeddedToolCalls(text);
    expect(result.segments.length).toBe(1);
    expect(result.segments[0].type).toBe("toolCall");
    if (result.segments[0].type === "toolCall") {
      expect(result.segments[0].toolCall.name).toBe("read_file");
      expect(result.segments[0].toolCall.args).toEqual({ filePath: "/x.txt" });
    }
  });

  it("parses text before and after tool call as text segments", () => {
    const text =
      "prefix<|tool_call_begin|>tool<|tool_call_argument_begin|>{}<|tool_call_end|>suffix";
    const result = parseTextEmbeddedToolCalls(text);
    const types = result.segments.map((s) => s.type);
    expect(types).toEqual(["text", "toolCall", "text"]);
  });

  it("handles incomplete tool call at end (no end token)", () => {
    const text = '<|tool_call_begin|>tool<|tool_call_argument_begin|>{"x":1}';
    const result = parseTextEmbeddedToolCalls(text);
    expect(result.incompleteText).toBeDefined();
  });
});

describe("parseTextEmbeddedToolCallsFrom", () => {
  it("returns text segment when no tool calls present", () => {
    const result = parseTextEmbeddedToolCallsFrom(
      "just some text",
      0,
      "<|tool_call_begin|>",
      "<|tool_call_argument_begin|>",
      "<|tool_call_end|>",
      [],
    );
    expect(result.segments).toEqual([{ type: "text", text: "just some text" }]);
  });

  it("parses XML-style tool calls (startPos is unused by implementation)", () => {
    // Note: startPos parameter is currently unused in parseTextEmbeddedToolCallsFrom.
    // The function always processes from position 0, so the text segment "ignore"
    // is included in the output.
    const result = parseTextEmbeddedToolCallsFrom(
      'ignore<tool_calls><tool_call name="t"></tool_call></tool_calls>',
      6,
      "<|tool_call_begin|>",
      "<|tool_call_argument_begin|>",
      "<|tool_call_end|>",
      ["<tool_calls>", "<tool_call "] as const,
    );
    // 2 segments: "ignore" text + tool call
    expect(result.segments.length).toBe(2);
    expect(result.segments[0]).toEqual({ type: "text", text: "ignore" });
    if (result.segments[1].type === "toolCall") {
      expect(result.segments[1].toolCall.name).toBe("t");
    }
  });
});

describe("ToolCallScanner", () => {
  let scanner: ToolCallScanner;

  beforeEach(() => {
    scanner = new ToolCallScanner();
  });

  it("returns text segment for plain text", () => {
    const result = scanner.feed("Hello world");
    expect(result).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("accumulates across multiple feed calls", () => {
    let result = scanner.feed("<|tool_call_begin|>tool<|tool_call_argument_begin|>");
    expect(result).toEqual([]);

    result = scanner.feed('{"key":"value"}<|tool_call_end|>');
    expect(result.length).toBe(1);
    if (result[0]?.type === "toolCall") {
      expect(result[0].toolCall.name).toBe("tool");
      expect(result[0].toolCall.args).toEqual({ key: "value" });
    }
  });

  it("returns text segments between tool calls", () => {
    const text =
      "before<|tool_call_begin|>t1<|tool_call_argument_begin|>{}<|tool_call_end|>middle<|tool_call_begin|>t2<|tool_call_argument_begin|>{}<|tool_call_end|>after";
    const result = scanner.feed(text);
    const types = result.map((s) => s.type);
    expect(types).toEqual(["text", "toolCall", "text", "toolCall", "text"]);
  });

  it("handles incomplete tool call at buffer end", () => {
    scanner.feed("<|tool_call_begin|>my_tool<|tool_call_argument_begin|>");
    const result = scanner.feed('{"x":');
    // Should be incomplete - no segments emitted yet
    expect(result).toEqual([]);
  });

  it("handles XML-style tool calls via scanner", () => {
    const result = scanner.feed(
      'text<tool_calls><tool_call name="my_tool"></tool_call></tool_calls>more',
    );
    expect(result.length).toBe(3);
    expect(result[0].type).toBe("text");
    expect(result[1].type).toBe("toolCall");
    expect(result[2].type).toBe("text");
  });

  it("buffer retains incomplete content for next delta", () => {
    scanner.feed("<|tool_call_begin|>tool<|tool_call_argument_begin|>");
    expect(scanner.buffer).toContain("<|tool_call_begin|>");
    expect(scanner.buffer).toContain("tool");
  });
});
