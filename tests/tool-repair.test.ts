import {
  buildInvalidToolCallFallback,
  getMissingRequiredToolArguments,
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
        { name: "grep_search", required: ["query", "isRegexp"], missing: ["query"] },
      ]),
    ).toContain("`query`");
  });
});
