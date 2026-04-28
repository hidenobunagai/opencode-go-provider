import { BASE_RETRY_DELAY_MS, BASE_URL, MAX_RETRY_DELAY_MS } from "./constants";
import { debugLog } from "./output-channel";
import { OcGoChatRequest, OcGoStreamResponse } from "./types";

/**
 * Determine whether an HTTP status code is safe to retry.
 * Retries on 429 (rate limit), 502, 503, 504 (server errors).
 * Never retries on 400, 401, 403, 404, 422 (client errors).
 */
function isRetryableHttpError(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Read Retry-After header value (seconds) if present.
 */
function getRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return undefined;
}

/**
 * Calculate delay with exponential backoff and full jitter.
 * This prevents thundering herd when multiple clients retry simultaneously.
 */
function calculateRetryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined && retryAfter > 0) {
    // Add jitter to server-provided retry-after (±25%)
    // Do not cap server-provided retry-after with MAX_RETRY_DELAY_MS
    const jitter = retryAfter * 0.25 * (Math.random() * 2 - 1);
    return Math.max(Math.round(retryAfter + jitter), 0);
  }

  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  // Full jitter: random delay between 0 and cappedDelay
  return Math.round(Math.random() * cappedDelay);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableHttpError(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (i < retries - 1) {
        const retryAfter = getRetryAfterMs(response);
        const delay = calculateRetryDelay(i, retryAfter);
        debugLog(
          "fetchWithRetry",
          `Attempt ${i + 1} failed with ${response.status}, retrying after ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === "AbortError") {
        throw lastError;
      }
      if (i < retries - 1) {
        const delay = calculateRetryDelay(i);
        debugLog(
          "fetchWithRetry",
          `Attempt ${i + 1} failed with network error, retrying after ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new Error("Network request failed after retries");
}

export async function* streamChatCompletion(
  apiKey: string,
  requestBody: OcGoChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
): AsyncGenerator<OcGoStreamResponse, void, unknown> {
  const response = await fetchWithRetry(
    `${BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      body: JSON.stringify(requestBody),
      signal,
    },
    // For chat completions, we might want to try slightly more times since they are high-value actions
    5,
  );

  if (!response.ok) {
    const text = await response.text();
    let message = `OpenCode Go API error: ${response.status} ${response.statusText}`;
    if (response.status === 401 || response.status === 403) {
      message = `Authentication failed. Your API key may be invalid or expired.\n${message}`;
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      message = `Rate limited. ${retryAfter ? `Retry after ${retryAfter}s. ` : ""}\n${message}`;
    } else if (response.status >= 500 && response.status < 600) {
      message = `Server error. The OpenCode Go service may be experiencing issues.\n${message}`;
    }
    throw new Error(`${message}\n${text}`);
  }

  if (!response.body) {
    throw new Error("No response body from OpenCode Go API");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let malformedSseCount = 0;
  const MALFORMED_SSE_WARN_THRESHOLD = 10;

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
          malformedSseCount++;
          debugLog("streamChatCompletion", `Malformed SSE line: ${data.slice(0, 200)}`);
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
        malformedSseCount++;
        debugLog("streamChatCompletion", `Malformed SSE line: ${data.slice(0, 200)}`);
      }
    }

    if (malformedSseCount >= MALFORMED_SSE_WARN_THRESHOLD) {
      debugLog(
        "streamChatCompletion",
        `Received ${malformedSseCount} malformed SSE lines (threshold: ${MALFORMED_SSE_WARN_THRESHOLD})`,
      );
    }
  } finally {
    reader.releaseLock();
  }
}
