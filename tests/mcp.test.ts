import { OcGoMcpClient } from "../src/mcp";

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("OcGoMcpClient", () => {
  let secrets: { get: jest.Mock };
  let client: OcGoMcpClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = { get: jest.fn() };
    client = new OcGoMcpClient(secrets as any, "test-ua");
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
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "User-Agent": "test-ua",
        }),
        body: expect.stringContaining("mimo-v2-omni"),
      }),
    );
  });

  it("uses a request-scoped API key override when provided", async () => {
    secrets.get.mockResolvedValue("stored-key");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A cat sitting on a mat" } }],
      }),
    });

    const result = await client.analyzeImage(
      "data:image/png;base64,abc",
      "What is this?",
      undefined,
      "request-key",
    );

    expect(result).toBe("A cat sitting on a mat");
    expect(secrets.get).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/chat/completions"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer request-key",
          "User-Agent": "test-ua",
        }),
      }),
    );
  });

  it("trims the stored API key fallback for image analysis", async () => {
    secrets.get.mockResolvedValue(" trimmed-key ");
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
        headers: expect.objectContaining({
          Authorization: "Bearer trimmed-key",
          "User-Agent": "test-ua",
        }),
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
      statusText: "Internal Server Error",
      headers: { get: () => null },
      text: async () => "Internal error",
    });

    await expect(client.analyzeImage("data:image/png;base64,abc", "What?")).rejects.toThrow(
      "OpenCode Go API error: 500 Internal Server Error",
    );
  });

  it("throws when response has no content", async () => {
    secrets.get.mockResolvedValue("test-key");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    await expect(client.analyzeImage("data:image/png;base64,abc", "What?")).rejects.toThrow(
      "Vision API returned no message content",
    );
  });
});
