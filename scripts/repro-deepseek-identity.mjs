const BASE_URL = "https://opencode.ai/zen/go/v1";

async function main() {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENCODE_GO_API_KEY");
    process.exitCode = 1;
    return;
  }

  const model = process.env.OPENCODE_GO_MODEL ?? "deepseek-v4-flash";
  const prompt = process.argv.slice(2).join(" ").trim() || "テストです。モデル名を教えてください。";

  const requestBody = {
    model,
    max_tokens: 1024,
    stream: true,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };

  const response = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "User-Agent": "opencode-go-provider/repro",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    console.error(`HTTP ${response.status} ${response.statusText}`);
    console.error(await response.text());
    process.exitCode = 1;
    return;
  }

  if (!response.body) {
    console.error("No response body");
    process.exitCode = 1;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "{}" || trimmed.startsWith("event:")) {
        continue;
      }

      const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!jsonStr || jsonStr === "{}" || jsonStr === "[DONE]" || !jsonStr.startsWith("{")) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text ?? "";
      }
    }
  }

  console.log(`Model: ${model}`);
  console.log(`Prompt: ${prompt}`);
  console.log("---");
  console.log(text.trim() || "(empty response)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
