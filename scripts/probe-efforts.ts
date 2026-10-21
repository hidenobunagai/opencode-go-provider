#!/usr/bin/env bun
/**
 * Live probe: how does a model react to each `reasoning_effort` rung on the OpenCode gateway?
 *
 *   bun scripts/probe-efforts.ts <model-id> [<model-id> ...]
 *
 * Supplementary evidence only (see docs/contributing.md "Thinking efforts"). The gateway
 * accepts the `reasoning_effort` enum for every model, so HTTP 200 proves nothing about a
 * model's real ladder — the vendor's own docs decide that. What a probe does establish:
 *   - whether the model reasons at all by default, and
 *   - whether the gateway rejects a rung the vendor does not offer (the useful signal).
 * Token counts per rung are printed but are too noisy from one sample to pick rungs from.
 *
 * Key: OPENCODE_API_KEY, else the `opencode-go` entry of `opencode auth`. Each run spends a
 * few requests per model.
 *
 * Kept byte-compatible with opencode-zen-provider/scripts/probe-efforts.ts apart from
 * BASE_URL; change both together.
 */
const BASE_URL = "https://opencode.ai/zen/go/v1";
const RUNGS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PROMPT = "What is the sum of the digits of 2^50? Reply with the number only.";

/**
 * The key is never read from OpenCode's own store: `opencode auth list` hides it and there is no
 * supported way to borrow it for a plain fetch. Export it for the one run instead
 * (`OPENCODE_API_KEY=... bun scripts/probe-efforts.ts <id>`), or skip the probe — vendor docs
 * are the primary evidence and this is only a corroboration.
 */
function apiKey(): string {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) {
    throw new Error(
      "OPENCODE_API_KEY is not set. Export it for this run, or skip the probe and decide from the vendor docs.",
    );
  }
  return key;
}

type Result = { rung: string; status: number; reasoningTokens?: number; error?: string };

async function call(key: string, model: string, rung?: string): Promise<Result> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: 4096,
  };
  if (rung) body.reasoning_effort = rung;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => ({ status: 0, text: async () => String(e) }) as Response);
  const text = await res.text();
  if (res.status !== 200) {
    return { rung: rung ?? "(omitted)", status: res.status, error: text.slice(0, 300) };
  }
  try {
    const body = JSON.parse(text) as {
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    return {
      rung: rung ?? "(omitted)",
      status: 200,
      reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
    };
  } catch {
    return { rung: rung ?? "(omitted)", status: 200 };
  }
}

async function main(): Promise<void> {
  const models = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (models.length === 0) {
    console.error("usage: bun scripts/probe-efforts.ts <model-id> [<model-id> ...]");
    process.exit(2);
  }
  const key = apiKey();
  for (const model of models) {
    console.log(`\n=== ${model}`);
    for (const rung of [undefined, ...RUNGS]) {
      const r = await call(key, model, rung);
      const tokens =
        r.reasoningTokens === undefined ? "" : ` reasoning_tokens=${r.reasoningTokens}`;
      const err = r.error ? `  ${r.error}` : "";
      console.log(`  ${r.rung.padEnd(10)} ${r.status}${tokens}${err}`);
      // A rejected rung is the signal; keep going so the whole ladder is visible in one run.
    }
  }
  console.log(
    "\nNote: 200 for every rung does not mean every rung exists — take the ladder from the vendor docs.",
  );
}

if (import.meta.main) void main();
