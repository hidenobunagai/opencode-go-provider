import * as vscode from "vscode";

const BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * OpenCode Go MCP Client for making HTTP-based MCP tool calls.
 * Used internally to provide image analysis capabilities for non-vision models.
 */
export class OcGoMcpClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Read the API key fresh from SecretStorage on every call to handle key rotation. */
  private async getApiKey(): Promise<string> {
    return (await this.secrets.get("opencode-go.apiKey")) ?? "";
  }

  /**
   * Analyze an image using OpenCode Go Vision model (MiMo-V2-Omni).
   * Used to add image processing capabilities for non-vision models.
   *
   * @param imageData Base64-encoded image in data URL format (e.g. "data:image/png;base64,...")
   * @param prompt    What to analyze in the image
   * @returns         Image analysis result text
   */
  async analyzeImage(imageData: string, prompt: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error("OpenCode Go API key not found");
    }

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "mimo-v2-omni",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageData } },
            ],
          },
        ],
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "Failed to analyze image";
  }
}
