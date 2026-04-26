describe("utils tokenizer fallback", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock("@dqbd/tiktoken");
  });

  it("loads utils and falls back when @dqbd/tiktoken is unavailable", () => {
    jest.doMock("@dqbd/tiktoken", () => {
      throw new Error("Cannot find module '@dqbd/tiktoken'");
    });

    expect(() => {
      jest.isolateModules(() => {
        const { estimateTokens } = require("../src/utils") as typeof import("../src/utils");
        expect(estimateTokens("hello")).toBe(3);
      });
    }).not.toThrow();
  });
});
