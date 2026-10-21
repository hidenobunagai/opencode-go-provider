#!/usr/bin/env bun
/**
 * Sync from Pi's opencode-go.json to opencode-go-provider.
 * - Compares Pi's provider data (contextWindow/maxTokens/vision/api/thinkingLevelMap)
 *   with FALLBACK_MODELS in src/types.ts and docs/models.md tables.
 * - Default: --check (report diff). With --write, updates src/types.ts and docs/models.md.
 *
 * Pi source: the latest published pi-ai from npm/CDN, falling back to the newest local
 * copy when offline (see scripts/pi-ai-source.ts).
 *
 * Usage:
 *   bun scripts/sync-from-pi.ts            # check
 *   bun scripts/sync-from-pi.ts --write    # update files
 *   bun run sync:pi                        # alias for --check
 *   bun run sync:pi:write                  # alias for --write
 */
import fs from "fs";
import path from "path";
import {
  loadDecisions,
  resolveEfforts,
  unverifiedEfforts,
  type EffortDecisionSet,
} from "./effort-decisions";
import { loadPiAiData } from "./pi-ai-source";

const WRITE = process.argv.includes("--write");

type PiModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
};

type PiData = Record<string, Record<string, PiModel>>;

function log(...args: unknown[]) {
  console.log(...args);
}

function flattenPi(data: PiData): Map<string, PiModel> {
  const map = new Map<string, PiModel>();
  for (const apiGroup of Object.values(data)) {
    for (const [key, model] of Object.entries(apiGroup)) {
      // pi-ai's keys carry a kind prefix (`chat:gpt-5.2`, `classifier:jev-1.13`) while
      // FALLBACK_MODELS writes the bare id. Keyed on the raw key every lookup missed, so the
      // whole comparison was a silent no-op (measured 2026-10-04: 0 of 29 ids matched).
      map.set(model.id || key.replace(/^[a-z-]+:/, ""), model);
    }
  }
  return map;
}

function piThinkingToEfforts(m: PiModel): string[] | null {
  // Returns supported efforts (excluding "off") where map value is string
  // If map is null/undefined => null (meaning generic / provider default)
  if (!m.reasoning) return null; // no thinking
  const map = m.thinkingLevelMap;
  if (!map) return null; // no explicit map => generic
  const efforts: string[] = [];
  for (const k of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const v = (map as Record<string, string | null>)[k];
    if (typeof v === "string") efforts.push(k);
  }
  // If map exists but all are null (e.g. kimi-k2.6), return [] => no UI
  // Detect case where map has only nulls
  const hasAnyString = efforts.length > 0;
  const hasMapKeys = Object.keys(map).length > 0;
  if (!hasAnyString && hasMapKeys) return []; // explicitly no levels
  return efforts;
}

function shouldIgnoreTypesDiff(id: string, field: string): boolean {
  // MiniMax M2.7 is intentionally kept as Anthropic in the extension for
  // backward compatibility with the OpenCode Go proxy's /messages endpoint,
  // even though Pi's current data lists it as openai-completions. Keep the
  // extension's historical behavior and silence the sync diff.
  if (id === "minimax-m2.7" && field === "apiFormat") return true;
  return false;
}

function shouldIgnoreDocsDiff(id: string, field: string): boolean {
  if (id === "minimax-m2.7" && field === "API") return true;
  return false;
}

function piApiToOurs(api: string): string {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "responses";
  return "openai";
}

/**
 * Pi transport names this extension has no client for (`google-generative-ai`,
 * `typesafe-system-one`). `piApiToOurs` would fold them into `openai` and the model would be
 * listed and then fail at request time, so a model we would have to add is reported as
 * skipped instead. Models already in the catalog are still compared field by field — their
 * stored format is a deliberate choice, not something this list decides.
 */
const UNSUPPORTED_PI_APIS = new Set(["google-generative-ai", "typesafe-system-one"]);

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Renders one `FALLBACK_MODELS` entry from Pi's data, for a model the catalog lacks. */
function renderModelBlock(piId: string, piModel: PiModel, efforts: string[] | null): string {
  const apiFormat = piApiToOurs(piModel.api);
  const supportsVision = piModel.input.includes("image");
  // Mirrors the rule the field-by-field path applies: no ladder evidence means no effort UI.
  const supportsThinking = piModel.reasoning && (efforts === null || efforts.length > 0);
  const lines = [
    "  {",
    `    id: "${piId}",`,
    `    name: "${piModel.name}",`,
    `    displayName: "${piModel.name}",`,
    `    contextWindow: ${piModel.contextWindow},`,
    `    maxOutput: ${piModel.maxTokens},`,
    "    supportsTools: true,",
    `    supportsVision: ${supportsVision},`,
    `    apiFormat: "${apiFormat}",`,
    `    supportsThinking: ${supportsThinking},`,
  ];
  if (efforts !== null && efforts.length > 0) {
    lines.push(`    supportedReasoningEfforts: [${efforts.map((e) => `"${e}"`).join(", ")}],`);
  }
  lines.push("  },");
  return lines.join("\n");
}

/** Appends rendered blocks to the end of `FALLBACK_MODELS`, before its closing `];`. */
function appendModelBlocks(content: string, blocks: string[]): string {
  if (blocks.length === 0) return content;
  const anchor = content.match(/export const FALLBACK_MODELS[^=]*=\s*\[/);
  if (!anchor || anchor.index === undefined) {
    throw new Error("FALLBACK_MODELS not found in src/types.ts");
  }
  const close = content.lastIndexOf("\n];");
  if (close < anchor.index) {
    throw new Error("FALLBACK_MODELS closing bracket not found in src/types.ts");
  }
  return `${content.slice(0, close)}\n${blocks.join("\n")}${content.slice(close)}`;
}

// --- src/types.ts sync ---
function syncTypes(
  piMap: Map<string, PiModel>,
  typesPath: string,
  write: boolean,
  decisions: EffortDecisionSet = {},
): { changed: number; diffs: string[]; skipped: string[] } {
  let content = fs.readFileSync(typesPath, "utf8");
  const original = content;
  const diffs: string[] = [];
  const skipped: string[] = [];
  let changed = 0;
  // A model Pi serves that the catalog has never carried has no block to compare field by
  // field, so the loop below used to skip it in silence and the gate still exited 0 — the
  // extension kept shipping a stale model list while every daily run reported "no drift"
  // (measured 2026-10-20: 15 models had piled up since the 2026-10-05 release). Count them
  // as drift, and build the blocks on --write so the gate can actually close the gap.
  const newBlocks: string[] = [];

  // Find all fallback blocks via regex for each id that exists in Pi
  for (const [piId, piModel] of piMap.entries()) {
    // Only sync if this id exists in FALLBACK
    const idRegex = new RegExp(`id:\\s*"${piId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    if (!idRegex.test(content)) {
      if (UNSUPPORTED_PI_APIS.has(piModel.api)) {
        // Not drift: no amount of --write makes a transport we cannot speak work. Shown
        // separately so the daily run does not keep waking an agent over a dead end.
        skipped.push(`${piId} (${piModel.api})`);
        continue;
      }
      const efforts = resolveEfforts(
        piId,
        piModel.reasoning,
        piThinkingToEfforts(piModel),
        decisions,
      ).efforts;
      diffs.push(`${piId}: missing from FALLBACK_MODELS — new in Pi, not in the catalog yet`);
      newBlocks.push(renderModelBlock(piId, piModel, efforts));
      continue;
    }

    // Extract block for this id
    const blockRegex = new RegExp(
      `\\{\\s*id:\\s*"${piId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]*?\\},`,
      "m",
    );
    const match = content.match(blockRegex);
    if (!match) continue;
    let block = match[0];
    const originalBlock = block;

    // Expected values from Pi
    const expCtx = piModel.contextWindow;
    const expMax = piModel.maxTokens;
    const expVision = piModel.input.includes("image");
    const expApi = piApiToOurs(piModel.api);
    const expThinking = piModel.reasoning;
    // null => Pi is generic and no decision exists: leave the entry alone rather than guess
    const expEfforts = resolveEfforts(
      piId,
      piModel.reasoning,
      piThinkingToEfforts(piModel),
      decisions,
    ).efforts;

    // Helper to replace or insert field
    const replaceField = (field: string, value: string, isString = false) => {
      const valStr = isString ? `"${value}"` : value;
      const re = new RegExp(`${field}:\\s*[^,\\n]+,`);
      if (re.test(block)) {
        const before = block;
        block = block.replace(re, `${field}: ${valStr},`);
        if (before !== block) diffs.push(`${piId}: ${field} updated`);
      }
    };

    // Context / max
    const ctxMatch = block.match(/contextWindow:\s*(\d+),/);
    if (ctxMatch && Number(ctxMatch[1]) !== expCtx) {
      diffs.push(`${piId}: contextWindow ${ctxMatch[1]} -> ${expCtx}`);
      block = block.replace(/contextWindow:\s*\d+,/, `contextWindow: ${expCtx},`);
    }
    const maxMatch = block.match(/maxOutput:\s*(\d+),/);
    if (maxMatch && Number(maxMatch[1]) !== expMax) {
      diffs.push(`${piId}: maxOutput ${maxMatch[1]} -> ${expMax}`);
      block = block.replace(/maxOutput:\s*\d+,/, `maxOutput: ${expMax},`);
    }

    // apiFormat
    const apiMatch = block.match(/apiFormat:\s*"([^"]+)",/);
    const apiVal = apiMatch?.[1];
    if (apiVal !== expApi && !shouldIgnoreTypesDiff(piId, "apiFormat")) {
      // Pi openai -> our openai, but fallback may omit apiFormat (defaults to openai)
      // Only report if mismatch or if Pi is non-openai
      if (expApi !== "openai" || apiVal) {
        if (apiVal) {
          if (apiVal !== expApi) {
            diffs.push(`${piId}: apiFormat ${apiVal} -> ${expApi}`);
            block = block.replace(/apiFormat:\s*"[^"]+",/, `apiFormat: "${expApi}",`);
          }
        } else if (expApi !== "openai") {
          diffs.push(`${piId}: apiFormat missing -> ${expApi}`);
          // insert after supportsVision or before contextWindow
          block = block.replace(/(supportsVision:\s*[^,]+,)/, `$1\n    apiFormat: "${expApi}",`);
        }
      }
    }

    // supportsVision
    const visionMatch = block.match(/supportsVision:\s*(true|false),/);
    if (visionMatch) {
      const cur = visionMatch[1] === "true";
      if (cur !== expVision) {
        diffs.push(`${piId}: supportsVision ${cur} -> ${expVision}`);
        block = block.replace(/supportsVision:\s*(true|false),/, `supportsVision: ${expVision},`);
      }
    }

    // supportsThinking
    const thinkingMatch = block.match(/supportsThinking:\s*(true|false),?/);
    const curThinking = thinkingMatch ? thinkingMatch[1] === "true" : false;
    if (curThinking !== expThinking) {
      // For kimi-k2.6 etc, Pi reasoning true but map all null => we treat as no UI (false)
      // piThinkingToEfforts returns [] for those, which we handle below
      // So we should set supportsThinking based on expThinking && expEfforts !== []
      const shouldThink =
        expThinking && expEfforts !== null && expEfforts.length !== 0
          ? true
          : expThinking
            ? expEfforts === null
              ? true
              : expEfforts.length > 0
            : false;
      // Actually for kimi-k2.6, expThinking true but efforts [] => should be false
      const finalThink = expEfforts !== null ? expEfforts.length > 0 : expThinking;
      // For models where Pi has no map, we keep as true (generic)
      const targetThinking = expThinking && expEfforts === null ? curThinking : finalThink;
      if (curThinking !== targetThinking) {
        diffs.push(`${piId}: supportsThinking ${curThinking} -> ${targetThinking}`);
        if (thinkingMatch) {
          block = block.replace(
            /supportsThinking:\s*(true|false),?/,
            `supportsThinking: ${targetThinking},`,
          );
        } else {
          // add
          block = block.replace(
            /apiFormat:\s*"[^"]+",/,
            `$&\n    supportsThinking: ${targetThinking},`,
          );
        }
      }
    }

    // supportedReasoningEfforts
    if (expEfforts !== null) {
      // Pi has explicit map (including [] meaning no levels)
      const shouldHaveEfforts = expEfforts.length > 0;
      const hasEfforts = /supportedReasoningEfforts:\s*\[/.test(block);
      if (!shouldHaveEfforts) {
        // should have no thinking UI => ensure supportsThinking false and no efforts
        if (hasEfforts) {
          diffs.push(`${piId}: remove supportedReasoningEfforts (Pi has no levels)`);
          block = block.replace(/\s*supportedReasoningEfforts:\s*\[[^\]]*\],?\n/, "\n");
        }
      } else {
        const expStr = `[${expEfforts.map((e) => `"${e}"`).join(", ")}]`;
        if (hasEfforts) {
          const curMatch = block.match(/supportedReasoningEfforts:\s*\[([^\]]*)\]/);
          const cur = curMatch ? curMatch[1] : "";
          const curNorm = cur.replace(/\s/g, "").replace(/"/g, "");
          const expNorm = expEfforts.join(",");
          if (curNorm !== expNorm) {
            diffs.push(`${piId}: supportedReasoningEfforts [${cur}] -> [${expEfforts.join(",")}]`);
            block = block.replace(
              /supportedReasoningEfforts:\s*\[[^\]]*\],?/,
              `supportedReasoningEfforts: ${expStr},`,
            );
          }
        } else {
          // insert after supportsThinking
          diffs.push(`${piId}: add supportedReasoningEfforts ${expStr}`);
          if (block.includes("supportsThinking:")) {
            block = block.replace(
              /(supportsThinking:\s*(true|false),?)/,
              `$1\n    supportedReasoningEfforts: ${expStr},`,
            );
          } else {
            block = block.replace(
              /(apiFormat:\s*"[^"]+",)/,
              `$1\n    supportedReasoningEfforts: ${expStr},`,
            );
          }
        }
      }
    } else {
      // Pi has no map (null) => generic, we keep existing generic? No diff
      // But if our fallback has specific efforts for a model that Pi has no map for (e.g. glm-5.1), we keep as is
      // So no action
    }

    if (block !== originalBlock) {
      content = content.replace(match[0], block);
      changed++;
    }
  }

  if (newBlocks.length > 0) {
    content = appendModelBlocks(content, newBlocks);
    changed += newBlocks.length;
  }

  if (write && changed > 0) {
    fs.writeFileSync(typesPath, content, "utf8");
    log(`Updated ${typesPath} (${changed} blocks)`);
  }
  return { changed, diffs, skipped };
}

// --- docs/models.md sync ---
function syncDocs(
  piMap: Map<string, PiModel>,
  typesPath: string,
  docsPath: string,
  write: boolean,
  decisions: EffortDecisionSet = {},
): { changed: number; diffs: string[] } {
  // Load current fallback to generate expected tables
  // Instead of parsing TS, we can generate expected rows from Pi + existing fallback
  // Simpler: regenerate tables from PiMap + fallback combined
  // For this sync, we update Context/Max/Thinking/API columns based on Pi's values where available
  let content = fs.readFileSync(docsPath, "utf8");
  const original = content;
  const diffs: string[] = [];
  let changed = 0;

  // Load fallback via dynamic import of TS (compile to JS in memory)
  // We'll just parse src/types.ts for fallback entries to get current values,
  // but for docs we want to ensure docs reflect Pi where Pi exists
  // So we will scan docs for each Pi model row and update its cells

  for (const [piId, piModel] of piMap.entries()) {
    const displayName = piId
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    // Find row in docs: | DisplayName |  |  |  |  |  |  |
    // Use a regex that matches the row with this displayName (case-insensitive for display?)
    // The docs uses DisplayName as in fallback: e.g. "GLM-5.1", "Kimi K2.6", "Muse Spark 1.2 Contributor"
    // We need to map Pi id to docs display: use same logic as fallback displayName but docs may have different.
    // Safer: search for row containing piId's display parts? Instead, search for row where first cell contains model id's pretty name.
    // We'll try to match by id's displayName lowercased
    const piDisplay = piId
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    // Also try fallback's displayName mapping: e.g. "Muse Spark 1.2 Contributor" vs piDisplay "Muse Spark 1.2 Contributor" matches
    // We'll search for `| ${piDisplay} |` or `| ${piModel.name} |`
    const candidates = [piDisplay, piModel.name];
    let rowRegex: RegExp | null = null;
    let rowMatch: RegExpMatchArray | null = null;
    for (const cand of candidates) {
      const escaped = cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\|\\s*${escaped}\\s*\\|([^\\n]*\\n)`, "i");
      const m = content.match(re);
      if (m) {
        rowRegex = re;
        rowMatch = m;
        break;
      }
    }
    if (!rowMatch || !rowRegex) {
      // Try broader: find row with piId in tooltip? Skip
      continue;
    }
    const fullRow = rowMatch[0];
    // Parse row: | Model | Context | Max | Vision | Tools | Thinking | API |
    const cells = fullRow.split("|").map((c) => c.trim());
    // cells[0] empty, [1] Model, [2] Context, [3] Max, [4] Vision, [5] Tools, [6] Thinking, [7] API
    if (cells.length < 8) continue;

    const expCtxStr = formatNumber(piModel.contextWindow);
    const expMaxStr = formatNumber(piModel.maxTokens);
    const expVision = piModel.input.includes("image") ? "✓" : "✗";
    const expApi =
      piApiToOurs(piModel.api) === "anthropic"
        ? "Anthropic"
        : piApiToOurs(piModel.api) === "responses"
          ? "Responses"
          : "OpenAI";
    const expEfforts = resolveEfforts(
      piId,
      piModel.reasoning,
      piThinkingToEfforts(piModel),
      decisions,
    ).efforts;
    let expThinking: string;
    if (!piModel.reasoning) expThinking = "✗";
    else if (expEfforts === null)
      expThinking = "✓"; // generic
    else if (expEfforts.length === 0) expThinking = "✗";
    else expThinking = `✓ (\`${expEfforts.join(",")}\`)`;

    // Compare and update if different
    const curCtx = cells[2];
    const curMax = cells[3];
    const curVision = cells[4];
    const curThinking = cells[6];
    const curApi = cells[7];

    let newRow = fullRow;
    let rowChanged = false;
    if (curCtx !== expCtxStr) {
      diffs.push(`${piId}: docs Context ${curCtx} -> ${expCtxStr}`);
      newRow = newRow.replace(`| ${curCtx} |`, `| ${expCtxStr} |`);
      rowChanged = true;
    }
    if (curMax !== expMaxStr) {
      diffs.push(`${piId}: docs Max ${curMax} -> ${expMaxStr}`);
      newRow = newRow.replace(`| ${curMax} |`, `| ${expMaxStr} |`);
      rowChanged = true;
    }
    if (curVision !== expVision) {
      diffs.push(`${piId}: docs Vision ${curVision} -> ${expVision}`);
      // need to replace the vision cell: it's 4th column. Use split approach
      // Simpler: replace the exact row's vision segment
      const visionRe = new RegExp(
        `(\\|\\s*${cells[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*${curCtx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*${curMax.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*)${curVision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\|)`,
      );
      // fallback simple
      newRow = newRow.replace(`| ${curVision} |`, `| ${expVision} |`);
      rowChanged = true;
    }
    if (curApi !== expApi && !shouldIgnoreDocsDiff(piId, "API")) {
      diffs.push(`${piId}: docs API ${curApi} -> ${expApi}`);
      newRow = newRow.replace(`| ${curApi} |`, `| ${expApi} |`);
      rowChanged = true;
    }
    // Thinking is more complex due to backticks
    if (curThinking !== expThinking) {
      // Only update if Pi has explicit map; if Pi map is null (generic), keep docs as is (don't force)
      if (expEfforts !== null) {
        diffs.push(`${piId}: docs Thinking ${curThinking} -> ${expThinking}`);
        newRow = newRow.replace(`| ${curThinking} |`, `| ${expThinking} |`);
        rowChanged = true;
      }
    }

    if (rowChanged) {
      content = content.replace(fullRow, newRow);
      changed++;
    }
  }

  if (write && changed > 0) {
    fs.writeFileSync(docsPath, content, "utf8");
    log(`Updated ${docsPath} (${changed} rows)`);
  }
  return { changed, diffs };
}

async function main() {
  const typesPath = path.resolve(import.meta.dir, "../src/types.ts");
  const docsPath = path.resolve(import.meta.dir, "../docs/models.md");

  log(`🔍 Sync from Pi — ${WRITE ? "WRITE" : "CHECK"} mode`);
  const { data, source } = await loadPiAiData<PiData>("opencode-go.json");
  log(`Source: ${source}`);
  const piMap = flattenPi(data);
  log(`Pi models: ${piMap.size}`);

  // Researched ladders win over Pi's map; without the file every model falls back to Pi.
  const decisionsPath = path.resolve(import.meta.dir, "../docs/effort-decisions.json");
  const decisions = loadDecisions(decisionsPath);
  const decided = Object.keys(decisions).length;
  if (decided > 0) log(`Effort decisions: ${decided} (${decisionsPath})`);

  // Types sync
  const typesRes = syncTypes(piMap, typesPath, WRITE, decisions);
  // Docs sync
  const docsRes = syncDocs(piMap, typesPath, docsPath, WRITE, decisions);

  const allDiffs = [...typesRes.diffs, ...docsRes.diffs];
  if (allDiffs.length === 0) {
    log("✅ No differences — already in sync with Pi");
  } else {
    log(`\nDifferences (${allDiffs.length}):`);
    for (const d of allDiffs.slice(0, 50)) log(`  - ${d}`);
    if (allDiffs.length > 50) log(`  ... and ${allDiffs.length - 50} more`);
    if (!WRITE) {
      log(`\nRun with --write to apply: bun scripts/sync-from-pi.ts --write`);
      log(`Or: bun run sync:pi:write`);
    } else {
      log(`\n✅ Applied ${typesRes.changed} type blocks and ${docsRes.changed} doc rows`);
      log(`Next: bun run test && bun run compile`);
    }
  }
  if (typesRes.skipped.length > 0) {
    log(
      `\nℹ️  ${typesRes.skipped.length} Pi model(s) have no client here, so they are neither in the catalog nor part of the diff: ${typesRes.skipped.join(", ")}`,
    );
  }
  if (!WRITE && allDiffs.length > 0) {
    // Report the ladder gaps here too: exiting on the field diffs alone would send the agent off
    // to `--write` and it would never learn which models still need research.
    const unverifiedNow = unverifiedEfforts(
      [...piMap.keys()].filter((id) =>
        new RegExp(`id:\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(
          fs.readFileSync(typesPath, "utf8"),
        ),
      ),
      piMap,
      piThinkingToEfforts,
      decisions,
    );
    if (unverifiedNow.length > 0) {
      log(`\n⚠️  ${unverifiedNow.length} catalog models rest on no ladder evidence as well:`);
      log(`  ${unverifiedNow.join(", ")}`);
    }
    process.exit(1);
  }

  // Warning only, unlike commandcode-goat-provider where it is drift. The Go gateway needs an
  // active subscription to answer a single request (measured 2026-10-21: every id returns "An
  // active OpenCode Go subscription is required"), and this owner does not hold one, so a ladder
  // that neither pi-ai nor models.dev states cannot be measured here at all. Failing the gate
  // over it would wake the daily agent every morning for work it has no way to finish. Keep the
  // list visible so a gap is not forgotten, and leave the shipped ladder alone rather than
  // replacing it with a guess.
  const syncedIds = [...piMap.keys()].filter((id) =>
    new RegExp(`id:\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(
      fs.readFileSync(typesPath, "utf8"),
    ),
  );
  const unverified = unverifiedEfforts(syncedIds, piMap, piThinkingToEfforts, decisions);
  if (unverified.length > 0) {
    log(
      `\n⚠️  ${unverified.length} catalog models rest on no ladder evidence (Pi is generic, no decision):`,
    );
    log(`  ${unverified.join(", ")}`);
    log(
      `  Left as they are: measuring them needs an OpenCode Go subscription, which this repo does not have.`,
    );
    log(
      `  Record { efforts, source, decided } in docs/effort-decisions.json only when vendor docs actually state a ladder, and only from this gateway — a ladder from another gateway (Command Code, OpenRouter, ...) does not carry over.`,
    );
  }
}

await main();
