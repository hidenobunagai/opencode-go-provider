import {
  BASE_RETRY_DELAY_MS,
  BASE_URL,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  STREAM_READ_TIMEOUT_MS,
} from "./constants";
import { debugLog } from "./output-channel";
import { OcGoChatCompletionResponse, OcGoChatRequest, OcGoStreamResponse } from "./types";

/**
 * Determine whether an HTTP status code is safe to retry.
 * Retries on 429 (rate limit), 502, 503, 504 (server errors).
 * Never retries on 400, 401, 403, 404, 422 (client errors).
 */
function isRetryableHttpError(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Read Retry-After header value in milliseconds.
 * Supports both seconds (integer) and HTTP-date formats.
 */
function getRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const httpDate = Date.parse(raw);
  if (Number.isFinite(httpDate)) {
    const delay = httpDate - Date.now();
    return delay > 0 ? delay : undefined;
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

function buildChatCompletionHeaders(apiKey: string, userAgent?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(userAgent ? { "User-Agent": userAgent } : {}),
  };
}

async function createChatCompletionResponse(
  apiKey: string,
  requestBody: OcGoChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  const response = await fetchWithRetry(
    `${BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: buildChatCompletionHeaders(apiKey, userAgent),
      body: JSON.stringify(requestBody),
      signal: combinedSignal,
    },
    5,
  ).finally(() => clearTimeout(timeoutId));

  return response;
}

async function throwChatCompletionError(response: Response): Promise<never> {
  const rawBody = await response.text();
  let detail = "";

  // Parse response body for structured error info
  try {
    const body = JSON.parse(rawBody) as {
      error?: { message?: string; code?: string; type?: string };
    };
    if (body.error?.message) {
      detail = body.error.message;
    }
  } catch {
    // Non-JSON body — use first 500 chars of raw text
    if (rawBody.trim().length > 0) {
      detail = rawBody.trim().slice(0, 500);
    }
  }

  if (response.status === 401 || response.status === 403) {
    const guide =
      'Run "OpenCode Go: Manage OpenCode Go API Key" from the Command Palette to update your API key.';
    throw new Error(
      `OpenCode Go API authentication failed (${response.status}). Your API key may be invalid or expired.\n${guide}\n${detail}`,
    );
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const retryInfo = retryAfter ? `Retry after ${retryAfter}. ` : "";
    throw new Error(
      `OpenCode Go rate limit reached (429). ${retryInfo}The request will be retried automatically.\n${detail}`,
    );
  }

  if (response.status === 400) {
    if (
      detail.toLowerCase().includes("token") &&
      (detail.toLowerCase().includes("limit") || detail.toLowerCase().includes("exceed"))
    ) {
      throw new Error(
        `OpenCode Go token limit exceeded. Try reducing conversation history, splitting the request, or switching to a model with a larger context window.\n${detail}`,
      );
    }
    throw new Error(
      `OpenCode Go API error (400): The request was invalid.\n${detail || rawBody.trim().slice(0, 500)}`,
    );
  }

  if (response.status >= 500 && response.status < 600) {
    throw new Error(
      `OpenCode Go server error (${response.status}). The service may be experiencing issues.\n${detail}`,
    );
  }

  throw new Error(
    `OpenCode Go API error (${response.status} ${response.statusText})\n${detail || rawBody.trim().slice(0, 500)}`,
  );
}

export async function requestChatCompletion(
  apiKey: string,
  requestBody: OcGoChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
): Promise<OcGoChatCompletionResponse> {
  const response = await createChatCompletionResponse(apiKey, requestBody, signal, userAgent);
  if (!response.ok) {
    await throwChatCompletionError(response);
  }
  return (await response.json()) as OcGoChatCompletionResponse;
}

export async function* streamChatCompletion(
  apiKey: string,
  requestBody: OcGoChatRequest,
  signal?: AbortSignal,
  userAgent?: string,
): AsyncGenerator<OcGoStreamResponse, void, unknown> {
  const response = await createChatCompletionResponse(apiKey, requestBody, signal, userAgent);

  if (!response.ok) {
    await throwChatCompletionError(response);
  }

  if (!response.body) {
    throw new Error("No response body from OpenCode Go API");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let malformedSseCount = 0;
  const MALFORMED_SSE_WARN_THRESHOLD = 10;
  const MAX_SSE_BUFFER_SIZE = 1024 * 1024; // 1 MB safety cap

  try {
    while (true) {
      // Race reader.read() against a per-read timeout so the generator
      // never hangs indefinitely on a stalled connection.
      let readTimedOut = false;
      const readPromise = reader.read();
      const timeoutId = setTimeout(() => {
        readTimedOut = true;
        reader.cancel().catch(() => {});
      }, STREAM_READ_TIMEOUT_MS);

      const { done, value } = await readPromise;
      clearTimeout(timeoutId);

      if (readTimedOut) {
        debugLog("streamChatCompletion", "Stream read timed out — cancelling");
        return;
      }

      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (buffer.length + text.length > MAX_SSE_BUFFER_SIZE) {
        debugLog("streamChatCompletion", "SSE buffer exceeded 1 MB — flushing");
        buffer = "";
      }
      buffer += text;
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
