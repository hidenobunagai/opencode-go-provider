// streaming/sse.ts — shared SSE response body reader
import { STREAM_READ_TIMEOUT_MS } from "../constants";
import { debugLog } from "../output-channel";

/** 1 MB safety cap on the line assembly buffer. */
const MAX_SSE_BUFFER_SIZE = 1024 * 1024;

/**
 * Read an SSE response body line by line.
 *
 * Shared by the OpenAI and Anthropic streaming paths.  Handles the per-read
 * timeout (a stalled stream is cancelled so the caller's retry loop can
 * re-establish a new connection), the buffer safety cap, and final-buffer
 * flushing.  Yields raw lines; callers are responsible for interpreting
 * `data:` prefixes, `[DONE]` markers, and JSON parsing.
 */
export async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        debugLog("readSseLines", "Stream read timed out — cancelling");
        return;
      }

      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (buffer.length + text.length > MAX_SSE_BUFFER_SIZE) {
        debugLog("readSseLines", "SSE buffer exceeded 1 MB — flushing");
        buffer = "";
      }
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield line;
      }
    }

    // Flush decoder internal state and emit any remaining lines
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) {
      yield line;
    }
  } finally {
    reader.releaseLock();
  }
}
