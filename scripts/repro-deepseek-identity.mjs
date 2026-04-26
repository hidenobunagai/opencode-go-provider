const BASE_URL = "https://opencode.ai/zen/go/v1";

function parseArgs(argv) {
  let rawModels = process.env.OPENCODE_GO_MODELS ?? process.env.OPENCODE_GO_MODEL;
  const promptParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, models: [], prompt: "" };
    }
    if ((arg === "--models" || arg === "--model") && argv[index + 1]) {
      rawModels = argv[index + 1];
      index += 1;
      continue;
    }
    promptParts.push(arg);
  }

  const models = Array.from(
    new Set(
      (rawModels ?? "deepseek-v4-flash")
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );

  const prompt = promptParts.join(" ").trim() || "テストです。モデル名を教えてください。";
  return { help: false, models, prompt };
}

async function fetchModelResponse(apiKey, model, prompt) {
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
    return {
      ok: false,
      text: `HTTP ${response.status} ${response.statusText}\n${await response.text()}`,
    };
  }

  if (!response.body) {
    return { ok: false, text: "No response body" };
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

  return { ok: true, text: text.trim() || "(empty response)" };
}

async function main() {
  const { help, models, prompt } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log("Usage: bun run repro:deepseek -- [--models deepseek-v4-flash,kimi-k2.6] [prompt]");
    console.log("Examples:");
    console.log('  bun run repro:deepseek -- "テストです。モデル名を教えてください。"');
    console.log(
      '  bun run repro:deepseek -- --models deepseek-v4-flash,kimi-k2.6 "テストです。モデル名を教えてください。"',
    );
    return;
  }

  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    console.error("Missing OPENCODE_GO_API_KEY");
    process.exitCode = 1;
    return;
  }

  console.log(`Models: ${models.join(", ")}`);
  console.log(`Prompt: ${prompt}`);
  console.log("---");

  for (const model of models) {
    const result = await fetchModelResponse(apiKey, model, prompt);
    console.log(`\n=== ${model} ===`);
    console.log(result.text);
    if (!result.ok) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
