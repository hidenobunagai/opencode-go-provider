import {
  buildInvalidToolCallFallback,
  buildToolCallCanonicalKey,
  getMissingRequiredToolArguments,
  getToolSchemaMap,
  repairToolArguments,
} from "../src/tool-repair";

describe("repairToolArguments", () => {
  it("does not invent a query for grep_search", () => {
    const repaired = repairToolArguments(
      "grep_search",
      { isRegexp: undefined },
      { filePath: "/workspace/src/example.ts" },
      { required: ["query", "isRegexp"] },
    );

    expect(repaired).toEqual({ isRegexp: false });
  });

  it("fills editor context for read_file when available", () => {
    const repaired = repairToolArguments(
      "read_file",
      {},
      { filePath: "/workspace/src/example.ts", startLine: 5, endLine: 12 },
      { required: ["filePath", "startLine", "endLine"] },
    );

    expect(repaired).toEqual({
      filePath: "/workspace/src/example.ts",
      startLine: 5,
      endLine: 12,
    });
  });

  it("coerces string '5' to number 5 when schema expects number", () => {
    const repaired = repairToolArguments(
      "read_file",
      { filePath: "/f", startLine: "5", endLine: "12" },
      undefined,
      {
        required: ["filePath", "startLine", "endLine"],
        propertyTypes: { startLine: "number", endLine: "number" },
      },
    );

    expect(repaired).toMatchObject({ startLine: 5, endLine: 12 });
    expect(typeof (repaired as Record<string, unknown>).startLine).toBe("number");
    expect(typeof (repaired as Record<string, unknown>).endLine).toBe("number");
  });

  it("coerces string 'true'/'false' to boolean when schema expects boolean", () => {
    const repaired = repairToolArguments(
      "some_tool",
      { isRegexp: "true", includeIgnoredFiles: "false" },
      undefined,
      { required: [], propertyTypes: { isRegexp: "boolean", includeIgnoredFiles: "boolean" } },
    );

    expect((repaired as Record<string, unknown>).isRegexp).toBe(true);
    expect((repaired as Record<string, unknown>).includeIgnoredFiles).toBe(false);
  });

  it("does not coerce when value is already correct type", () => {
    const repaired = repairToolArguments("some_tool", { startLine: 10, name: "hello" }, undefined, {
      required: [],
      propertyTypes: { startLine: "number", name: "string" },
    });

    expect((repaired as Record<string, unknown>).startLine).toBe(10);
    expect((repaired as Record<string, unknown>).name).toBe("hello");
  });

  it("matches tool name case-insensitively for read_file", () => {
    const repaired = repairToolArguments(
      "Read_File",
      {},
      { filePath: "/workspace/src/example.ts", startLine: 3, endLine: 8 },
      { required: ["filePath", "startLine", "endLine"] },
    );

    expect(repaired).toMatchObject({
      filePath: "/workspace/src/example.ts",
      startLine: 3,
      endLine: 8,
    });
  });

  it("matches tool name case-insensitively for run_in_terminal", () => {
    const repaired = repairToolArguments(
      "Run_In_Terminal",
      { command: "ls", explanation: "", goal: undefined, mode: null, timeout: "30" },
      undefined,
      {
        required: ["command", "explanation", "goal", "mode", "timeout"],
        propertyTypes: { timeout: "number" },
      },
    );

    expect(repaired).toMatchObject({
      command: "ls",
      explanation: "Run command in terminal",
      goal: "Execute command",
      mode: "sync",
      timeout: 30,
    });
  });
});

describe("buildToolCallCanonicalKey", () => {
  it("returns the same key regardless of object key order", () => {
    const key1 = buildToolCallCanonicalKey("read_file", { b: 2, a: 1 });
    const key2 = buildToolCallCanonicalKey("read_file", { a: 1, b: 2 });
    expect(key1).toBe(key2);
  });

  it("normalizes tool name to lowercase", () => {
    const key1 = buildToolCallCanonicalKey("Read_File", { path: "/f" });
    const key2 = buildToolCallCanonicalKey("read_file", { path: "/f" });
    expect(key1).toBe(key2);
  });

  it("returns different keys for different arguments", () => {
    const key1 = buildToolCallCanonicalKey("read_file", { filePath: "/a" });
    const key2 = buildToolCallCanonicalKey("read_file", { filePath: "/b" });
    expect(key1).not.toBe(key2);
  });
});

describe("getToolSchemaMap", () => {
  it("stores schemas under lowercase tool names", () => {
    const map = getToolSchemaMap({
      tools: [
        {
          name: "Read_File",
          description: "",
          inputSchema: {
            type: "object",
            properties: { filePath: { type: "string" }, startLine: { type: "number" } },
            required: ["filePath"],
          },
        },
      ],
    } as any);

    expect(map.has("read_file")).toBe(true);
    expect(map.has("Read_File")).toBe(false);
    expect(map.get("read_file")?.propertyTypes).toEqual({
      filePath: "string",
      startLine: "number",
    });
  });
});

describe("getMissingRequiredToolArguments", () => {
  it("returns missing required arguments for incomplete tool inputs", () => {
    expect(
      getMissingRequiredToolArguments({ isRegexp: false }, { required: ["query", "isRegexp"] }),
    ).toEqual(["query"]);
  });
});

describe("buildInvalidToolCallFallback", () => {
  it("mentions the actual missing argument names", () => {
    expect(
      buildInvalidToolCallFallback([
        {
          name: "grep_search",
          required: ["query", "isRegexp"],
          missing: ["query"],
        },
      ]),
    ).toContain("`query`");
  });
});
