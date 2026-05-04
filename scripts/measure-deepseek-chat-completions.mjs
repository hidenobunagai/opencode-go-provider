const BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_MODELS = "deepseek-v4-flash:max,deepseek-v4-pro:max";
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_PROMPT =
  "まず慎重に考えてから、日本語で結論だけを1文で答えてください。あなたが利用中のモデル系統を簡潔に説明し、最後に OK で終えてください。";
const API_KEY_PLACEHOLDER = "YOUR_OPENCODE_GO_API_KEY_HERE";

function parseArgs(argv) {
  let rawModels = process.env.OPENCODE_GO_MODELS ?? DEFAULT_MODELS;
  let attempts = Number.parseInt(process.env.OPENCODE_GO_ATTEMPTS ?? String(DEFAULT_ATTEMPTS), 10);
  let temperature = Number.parseFloat(
    process.env.OPENCODE_GO_TEMPERATURE ?? String(DEFAULT_TEMPERATURE),
  );
  let json = false;
  const promptParts = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return {
        help: true,
        json: false,
        models: [],
        attempts: DEFAULT_ATTEMPTS,
        temperature: DEFAULT_TEMPERATURE,
        prompt: DEFAULT_PROMPT,
      };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if ((arg === "--models" || arg === "--model") && argv[index + 1]) {
      rawModels = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--attempts" && argv[index + 1]) {
      attempts = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === "--temperature" && argv[index + 1]) {
      temperature = Number.parseFloat(argv[index + 1]);
      index += 1;
      continue;
    }
    promptParts.push(arg);
  }

  const models = Array.from(
    new Set(
      String(rawModels)
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );

  return {
    help: false,
    json,
    models,
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE,
    prompt: promptParts.join(" ").trim() || DEFAULT_PROMPT,
  };
}

function parseModelSpec(label) {
  const [model, variant] = label.split(":");
  const normalizedVariant = variant?.trim().toLowerCase();
  const effortMap = {
    max: "xhigh",
    high: "high",
    medium: "medium",
    low: "low",
  };

  return {
    label,
    model,
    reasoningEffort: normalizedVariant ? effortMap[normalizedVariant] : undefined,
  };
}

function getApiKey() {
  const apiKey = process.env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey || apiKey === API_KEY_PLACEHOLDER) {
    return undefined;
  }
  return apiKey;
}

async function runOnce(spec, prompt, temperature) {
  const startedAt = Date.now();
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "Missing OPENCODE_GO_API_KEY",
      elapsedMs: 0,
    };
  }

  const requestBody = {
    model: spec.model,
    stream: true,
    temperature,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
  };

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "opencode-go-provider/live-measure",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: (await response.text()).trim().slice(0, 500),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (!response.body) {
    return {
      ok: false,
      error: "No response body",
      elapsedMs: Date.now() - startedAt,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let toolCallChunks = 0;
  let finishReason = null;
  let malformedSseCount = 0;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) return;
    const data = trimmed.slice(6);
    if (!data || data === "[DONE]") return;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      malformedSseCount += 1;
      return;
    }

    const choice = parsed?.choices?.[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
    }
    if (choice?.delta?.reasoning_content) {
      reasoning += choice.delta.reasoning_content;
    }
    if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
      toolCallChunks += choice.delta.tool_calls.length;
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    }

    buffer += decoder.decode();
    const finalLines = buffer.split("\n");
    for (const line of finalLines) {
      processLine(line);
    }
  } finally {
    reader.releaseLock();
  }

  const normalizedText = text.trim();
  const visible = normalizedText.length > 0 || toolCallChunks > 0;

  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    textChars: normalizedText.length,
    reasoningChars: reasoning.length,
    toolCallChunks,
    malformedSseCount,
    finishReason,
    visible,
    reasoningOnly: !visible && reasoning.length > 0,
    silent: !visible && reasoning.length === 0,
    preview: normalizedText.slice(0, 160),
  };
}

function summarizeAttempts(attempts) {
  const successes = attempts.filter((attempt) => attempt.ok);
  return {
    success: successes.length,
    errors: attempts.length - successes.length,
    visible: successes.filter((attempt) => attempt.visible).length,
    reasoningOnly: successes.filter((attempt) => attempt.reasoningOnly).length,
    silent: successes.filter((attempt) => attempt.silent).length,
    avgElapsedMs: successes.length
      ? Math.round(successes.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) / successes.length)
      : 0,
  };
}

function printHelp() {
  console.log("Usage: bun run measure:deepseek -- [--models a,b] [--attempts 5] [--temperature 0.2] [--json] [prompt]");
  console.log("Examples:");
  console.log("  bun run measure:deepseek");
  console.log('  bun run measure:deepseek -- --attempts 10 --models deepseek-v4-flash:max,deepseek-v4-pro:max');
  console.log('  bun run measure:deepseek -- --json "日本語で一文だけ答えてください。最後にOKで終えてください。"');
  console.log("");
  console.log("Environment variables:");
  console.log("  OPENCODE_GO_API_KEY       OpenCode Go API key for /chat/completions");
  console.log("  OPENCODE_GO_MODELS        Default model list (comma-separated)");
  console.log("  OPENCODE_GO_ATTEMPTS      Default attempt count");
  console.log("  OPENCODE_GO_TEMPERATURE   Default temperature");
}

async function main() {
  const { help, json, models, attempts, temperature, prompt } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    endpoint: `${BASE_URL}/chat/completions`,
    prompt,
    attemptsPerModel: attempts,
    temperature,
    models: [],
  };

  for (const label of models) {
    const spec = parseModelSpec(label);
    const results = [];
    for (let index = 0; index < attempts; index += 1) {
      results.push({ attempt: index + 1, ...(await runOnce(spec, prompt, temperature)) });
    }
    summary.models.push({
      label,
      requestModel: spec.model,
      reasoningEffort: spec.reasoningEffort ?? null,
      stats: summarizeAttempts(results),
      attempts: results,
    });
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Endpoint: ${summary.endpoint}`);
  console.log(`Prompt: ${summary.prompt}`);
  console.log(`Attempts per model: ${summary.attemptsPerModel}`);
  console.log(`Temperature: ${summary.temperature}`);
  console.log("---");

  for (const model of summary.models) {
    console.log(`\n=== ${model.label} ===`);
    console.log(
      `success=${model.stats.success}/${attempts} visible=${model.stats.visible} reasoningOnly=${model.stats.reasoningOnly} silent=${model.stats.silent} errors=${model.stats.errors} avgElapsedMs=${model.stats.avgElapsedMs}`,
    );
    for (const attempt of model.attempts) {
      if (!attempt.ok) {
        console.log(`  [${attempt.attempt}] ERROR status=${attempt.status ?? "n/a"} elapsed=${attempt.elapsedMs}ms ${attempt.error}`);
        continue;
      }
      console.log(
        `  [${attempt.attempt}] visible=${attempt.visible} reasoningOnly=${attempt.reasoningOnly} silent=${attempt.silent} finish=${attempt.finishReason ?? "null"} textChars=${attempt.textChars} reasoningChars=${attempt.reasoningChars} elapsed=${attempt.elapsedMs}ms preview=${JSON.stringify(attempt.preview)}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
