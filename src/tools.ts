import * as vscode from "vscode";
import { OcGoMcpClient } from "./mcp";

/**
 * Tool for analyzing images using the OpenCode Go Vision model (MiMo-V2-Omni).
 * Non-vision models can delegate image content to this tool for analysis.
 */
export class OcGoAnalyzeImageTool implements vscode.LanguageModelTool<{
  image_data: string;
  prompt: string;
}> {
  static readonly id = "opencode_go_analyze_image";

  readonly name = OcGoAnalyzeImageTool.id;
  readonly description =
    "Analyze an image using OpenCode Go Vision model. Use this tool when you need to " +
    "understand or describe the content of an image, extract text from images (OCR), " +
    "or answer questions about visual content. Returns a detailed analysis of the image.";
  readonly tags = ["vision", "image", "ocr", "analysis"];

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      image_data: {
        type: "string",
        description:
          "Base64-encoded image data URL (e.g., 'data:image/png;base64,...'). The image to analyze.",
      },
      prompt: {
        type: "string",
        description:
          "The question or instruction about what to analyze in the image. Be specific about what you want to know.",
      },
    },
    required: ["image_data", "prompt"],
  };

  private readonly _mcpClient: OcGoMcpClient;

  constructor(secrets: vscode.SecretStorage, userAgent?: string) {
    this._mcpClient = new OcGoMcpClient(secrets, userAgent);
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ image_data: string; prompt: string }>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { image_data, prompt } = options.input;
    const abortController = new AbortController();
    const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());
    try {
      const result = await this._mcpClient.analyzeImage(image_data, prompt, abortController.signal);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new vscode.CancellationError();
      }
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Failed to analyze image: ${errorMessage}`),
      ]);
    } finally {
      cancellationSubscription.dispose();
    }
  }

  prepareInvocation?(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<{
      image_data: string;
      prompt: string;
    }>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Analyzing image with OpenCode Go Vision..." };
  }
}

/**
 * Register all OpenCode Go tools with the Language Model API.
 * @param secrets VS Code secret storage for API key access
 * @returns Disposable for the tool registrations
 */
export function registerOcGoTools(
  secrets: vscode.SecretStorage,
  userAgent?: string,
): vscode.Disposable {
  const analyzeImageTool = new OcGoAnalyzeImageTool(secrets, userAgent);
  return vscode.Disposable.from(vscode.lm.registerTool(OcGoAnalyzeImageTool.id, analyzeImageTool));
}
