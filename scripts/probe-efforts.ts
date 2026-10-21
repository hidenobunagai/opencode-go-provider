#!/usr/bin/env bun
/**
 * Live probe: which thinking-effort rungs does a model actually accept?
 *
 *   bun scripts/probe-efforts.ts <model-id> [<model-id> ...]
 *
 * ## What each path can and cannot prove
 *
 * 1. **`opencode run -m <provider>/<id>#<rung>`** — OpenCode accepts a rung as a "#variant".
 *    An unsupported one is rejected before any request is sent, which makes an *empty* result
 *    decisive: no variant works means the model has no ladder. This also reaches the free
 *    models, which the HTTP API refuses outright (`FreeTierError`: the free tier only works
 *    from inside OpenCode). It is the only way to measure a model like `big-pickle`.
 *
 *    **It is not independent evidence of a ladder.** OpenCode builds those variants from
 *    models.dev's `reasoning_options` for the provider (verified 2026-10-21: on every model
 *    tried, the accepted set equals models.dev's `effort.values` exactly — e.g.
 *    `deepseek-v4.1-flash-free` → low/high/max, `big-pickle` → none). So a non-empty variant
 *    list corroborates models.dev, not the vendor. Use it to settle "is there a ladder at all"
 *    and to read the free-tier models; take the rungs from the vendor's docs.
 *
 * 2. **`POST /chat/completions` with `reasoning_effort`** — needs a funded key, and the gateway
 *    returns 200 for rungs the vendor does not offer, so it proves reachability only. When the
 *    account cannot call the model at all it says so instead of printing a table of 403s.
 *
 * Cost: an *invalid* rung is rejected in ~0.2s, but a *valid* one runs a real inference (~9s),
 * so probing a model with a full ladder takes minutes. Probe one or two models at a time.
 *
 * Exit status: 1 when `opencode` is missing, because then the only path left is the HTTP one
 * and that one refuses the free tier.
 *
 * Kept byte-compatible with opencode-zen-provider/scripts/probe-efforts.ts apart from
 * PROVIDER and BASE_URL; change both together.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PROVIDER = "opencode-go";
const BASE_URL = "https://opencode.ai/zen/go/v1";
const RUNGS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Concurrently-run variant checks; each spawns an OpenCode server, so keep it small. */
const CONCURRENCY = 7;

/**
 * The key is never read from OpenCode's own store: `opencode auth list` hides it and there is no
 * supported way to borrow it for a plain fetch. Export it for the one run instead
 * (`OPENCODE_API_KEY=... bun scripts/probe-efforts.ts <id>`). Path 1 needs no key at all.
 */
function apiKey(): string | undefined {
  return process.env.OPENCODE_API_KEY || undefined;
}

/** Asks OpenCode to run the model at one rung. `#max` is what OpenCode calls a rung. */
async function viaVariant(model: string, rung: string): Promise<boolean> {
  try {
    // No `--standalone`: a private server costs ~5-8 minutes of startup per rung, which made a
    // seven-rung probe take nine minutes. The shared background service answers in well under a
    // second and gives the same verdict (the variant is validated before any request is sent).
    await exec(
      "opencode",
      ["run", "--auto", "-m", `${PROVIDER}/${model}#${rung}`, "Reply with: OK"],
      { timeout: 180_000 },
    );
    return true;
  } catch {
    // "Variant unavailable" and a genuine request failure look the same here; the model-level
    // conclusion below only relies on *every* rung failing, so a flake cannot create a ladder.
    return false;
  }
}

/** Runs `tasks` with at most CONCURRENCY in flight, preserving order. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** One `reasoning_effort` request. Returns the HTTP status and the gateway's message. */
async function viaHttp(
  key: string,
  model: string,
  rung: string,
): Promise<{ status: number; note?: string }> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with: OK" }],
      max_tokens: 16,
      reasoning_effort: rung,
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => ({ status: 0, text: async () => String(e) }) as Response);
  const text = await res.text().catch(() => "");
  if (res.status === 200) return { status: 200 };
  let note = text.slice(0, 160);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } };
    note = [parsed.error?.type, parsed.error?.message].filter(Boolean).join(": ") || note;
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, note };
}

/** True when the gateway refused the account or the model rather than this rung. */
function isAccountBlock(note: string): boolean {
  return /FreeTierError|Model access is disabled|Insufficient account funds|subscription is required|MissingSessionID/i.test(
    note,
  );
}

async function probe(model: string, key: string | undefined): Promise<void> {
  console.log(`\n=== ${model}`);

  const accepted = await pool(
    RUNGS,
    CONCURRENCY,
    async (rung): Promise<{ rung: string; ok: boolean }> => ({
      rung,
      ok: await viaVariant(model, rung),
    }),
  );
  const ladder = accepted.filter((r) => r.ok).map((r) => r.rung);

  // Only an empty result is a conclusion: it means the model exposes no effort rung at all,
  // which is how the free stealth models look and there are no vendor docs to consult.
  console.log(
    ladder.length > 0
      ? `  → ladder (variant): ${ladder.join(", ")}  [corroborates models.dev, not the vendor]`
      : "  → ladder (variant): none — the model exposes no effort rung at all",
  );

  if (!key) {
    console.log("  (OPENCODE_API_KEY not set — skipped the HTTP path)");
    return;
  }

  const results: { rung: string; ok: boolean; note?: string }[] = [];
  for (const rung of RUNGS) {
    const { status, note } = await viaHttp(key, model, rung);
    results.push({ rung, ok: status === 200, note });
  }
  const blocked = results.filter((r) => r.note && isAccountBlock(r.note));
  if (blocked.length === results.length) {
    // Not evidence about the ladder: the account cannot call this model at all. Saying so is the
    // point — a table of uniform 403s once read like a measured ladder.
    console.log(
      `  → HTTP path unusable for this model (${blocked[0].note}); no conclusion about the ladder.`,
    );
    return;
  }
  const viaHttpAccepted = results.filter((r) => r.ok).map((r) => r.rung);
  console.log(
    `  → accepted (HTTP): ${viaHttpAccepted.length > 0 ? viaHttpAccepted.join(", ") : "none"} [reachability only]`,
  );
}

async function main(): Promise<void> {
  const models = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (models.length === 0) {
    console.error("usage: bun scripts/probe-efforts.ts <model-id> [<model-id> ...]");
    process.exit(2);
  }

  // Fail fast and loudly when OpenCode is missing: without it only the HTTP path is left, and
  // that path refuses the free tier outright.
  try {
    await exec("opencode", ["--version"], { timeout: 15_000 });
  } catch {
    console.error(
      "`opencode` is not runnable. The API rejects free-tier models outright, so the variant path " +
        "is the only way to measure them — install OpenCode, or probe a paid model with OPENCODE_API_KEY.",
    );
    process.exit(1);
  }

  const key = apiKey();
  if (!key) {
    console.log(
      "No OPENCODE_API_KEY: measuring with OpenCode variants only (the free tier works).",
    );
  }

  for (const model of models) {
    try {
      await probe(model, key);
    } catch (error) {
      console.log(`  probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\nRecord the result in docs/effort-decisions.json with the source you used.");
  console.log(
    'An empty ladder means "the vendor exposes no effort parameter" — write "efforts": [].',
  );
}

if (import.meta.main) void main();
