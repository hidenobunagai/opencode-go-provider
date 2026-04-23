import { BASE_URL } from "./constants";
import { OcGoChatRequest, OcGoStreamResponse } from "./types";

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, init);
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === "AbortError") {
        throw lastError;
      }
      if (i < retries - 1) {
        const delay = Math.min(1000 * Math.pow(2, i), 8000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new Error("Network request failed after retries");
}

export async function fetchModels(
  apiKey: string,
  signal?: AbortSignal,
  userAgent?: string,
): Promise<Array<{ id: string; name: string }> | null> {
  try {
    const response = await fetchWithRetry(`${BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      signal,
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { data?: Array<{ id: string; name: string }> };
    return data.data ?? null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    console.error("[OpenCode Go API] fetchModels failed:", error);
    return null;
  }
}

export async function* streamChatCompletion(
  apiKey: string,
  requestBody: OcGoChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
): AsyncGenerator<OcGoStreamResponse, void, unknown> {
  const response = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(userAgent ? { "User-Agent": userAgent } : {}),
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `OpenCode Go API error: ${response.status} ${response.statusText}`;
    if (response.status === 401 || response.status === 403) {
      message = `Authentication failed. Your API key may be invalid or expired.\n${message}`;
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      message = `Rate limited. ${retryAfter ? `Retry after ${retryAfter}s. ` : ""}\n${message}`;
    }
    throw new Error(`${message}\n${text}`);
  }

  if (!response.body) {
    throw new Error("No response body from OpenCode Go API");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as OcGoStreamResponse;
          yield parsed;
        } catch {
          // Ignore malformed lines
        }
      }
    }

    // Flush decoder internal state and process any remaining lines
    const remaining = decoder.decode();
    buffer += remaining;
    const finalLines = buffer.split("\n");
    for (const line of finalLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as OcGoStreamResponse;
        yield parsed;
      } catch {
        // Ignore malformed lines
      }
    }
  } finally {
    reader.releaseLock();
  }
}
