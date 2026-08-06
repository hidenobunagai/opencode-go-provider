import * as vscode from "vscode";
import { requestChatCompletion } from "./api";

/**
 * OpenCode Go MCP Client for making HTTP-based MCP tool calls.
 * Used internally to provide image analysis capabilities for non-vision models.
 */
export class OcGoMcpClient {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent?: string,
  ) {}

  /** Read the API key fresh from SecretStorage unless a request-scoped key is provided. */
  private async getApiKey(apiKeyOverride?: string): Promise<string> {
    const normalizedApiKey = apiKeyOverride?.trim();
    if (normalizedApiKey) {
      return normalizedApiKey;
    }
    return (await this.secrets.get("opencode-go.apiKey"))?.trim() ?? "";
  }

  /**
   * Analyze an image using OpenCode Go Vision model (MiMo-V2-Omni).
   * Used to add image processing capabilities for non-vision models.
   *
   * @param imageData Base64-encoded image in data URL format (e.g. "data:image/png;base64,...")
   * @param prompt    What to analyze in the image
   * @returns         Image analysis result text
   */
  async analyzeImage(
    imageData: string,
    prompt: string,
    signal?: AbortSignal,
    apiKeyOverride?: string,
  ): Promise<string> {
    const apiKey = await this.getApiKey(apiKeyOverride);
    if (!apiKey) {
      throw new Error("OpenCode Go API key not found");
    }

    const data = await requestChatCompletion(
      apiKey,
      {
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
      },
      signal,
      this.userAgent,
    );

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Vision API returned no message content");
    }
    return content;
  }
}
