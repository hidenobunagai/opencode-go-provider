import { OcGoMcpClient } from "../src/mcp";

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("OcGoMcpClient", () => {
  let secrets: { get: jest.Mock };
  let client: OcGoMcpClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = { get: jest.fn() };
    client = new OcGoMcpClient(secrets as any);
  });

  it("analyzes an image successfully", async () => {
    secrets.get.mockResolvedValue("test-key");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A cat sitting on a mat" } }],
      }),
    });

    const result = await client.analyzeImage("data:image/png;base64,abc", "What is this?");
    expect(result).toBe("A cat sitting on a mat");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/chat/completions"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: expect.stringContaining("mimo-v2-omni"),
      }),
    );
  });

  it("throws when no API key is configured", async () => {
    secrets.get.mockResolvedValue(undefined);
    await expect(client.analyzeImage("data:image/png;base64,abc", "What?")).rejects.toThrow(
      "OpenCode Go API key not found",
    );
  });

  it("throws on API error", async () => {
    secrets.get.mockResolvedValue("test-key");
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    });

    await expect(client.analyzeImage("data:image/png;base64,abc", "What?")).rejects.toThrow(
      "Vision API error: 500 Internal error",
    );
  });

  it("returns fallback text when response has no content", async () => {
    secrets.get.mockResolvedValue("test-key");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const result = await client.analyzeImage("data:image/png;base64,abc", "What?");
    expect(result).toBe("Failed to analyze image");
  });
});
