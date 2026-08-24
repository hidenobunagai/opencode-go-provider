#!/usr/bin/env bun
/**
 * Sync from Pi's opencode-go.json to opencode-go-provider.
 * - Compares Pi's provider data (contextWindow/maxTokens/vision/api/thinkingLevelMap)
 *   with FALLBACK_MODELS in src/types.ts and docs/models.md tables.
 * - Default: --check (report diff). With --write, updates src/types.ts and docs/models.md.
 *
 * Pi source resolution:
 *  1) Local pi-ai install (global bun, deepseek-harness pnpm, cache)
 *  2) Fallback fetch from unpkg/jsdelivr
 *
 * Usage:
 *   bun scripts/sync-from-pi.ts            # check
 *   bun scripts/sync-from-pi.ts --write    # update files
 *   bun run sync:pi                        # alias for --check
 *   bun run sync:pi:write                  # alias for --write
 */
import fs from "fs";
import path from "path";
import os from "os";

const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

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
function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

function findPiJsonLocal(): string | null {
  const homedir = os.homedir();
  const candidates = [
    path.join(homedir, ".bun/install/global/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json"),
    path.join(homedir, ".bun/install/cache"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      // search inside cache for pi-ai
      try {
        const entries = fs.readdirSync(c);
        for (const e of entries) {
          if (e.includes("pi-ai")) {
            const p = path.join(c, e, "dist/providers/data/opencode-go.json");
            if (fs.existsSync(p)) return p;
            // also try nested
            const nested = findFileRecursive(path.join(c, e), "opencode-go.json");
            if (nested) return nested;
          }
        }
      } catch {}
    }
  }
  // search in deepseek-harness pnpm store
  const harnessPaths = [
    path.join(homedir, "Projects/deepseek-harness/node_modules"),
    path.join(homedir, "Projects/opencode-go-provider/node_modules"),
  ];
  for (const base of harnessPaths) {
    if (!fs.existsSync(base)) continue;
    const found = findFileRecursive(base, "opencode-go.json");
    if (found && found.includes("pi-ai")) return found;
  }
  // also try via bun pm view? fallback to find command
  try {
    const proc = Bun.spawnSync(["find", homedir + "/.bun", "-name", "opencode-go.json", "-path", "*pi-ai*"], {
      stdout: "pipe",
    });
    const out = proc.stdout.toString().trim().split("\n").filter(Boolean);
    if (out.length > 0) {
      // prefer global
      const sorted = out.sort((a, b) => a.length - b.length);
      return sorted[0];
    }
  } catch {}
  return null;
}

function findFileRecursive(dir: string, filename: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === filename) return full;
      if (ent.isDirectory() && !ent.name.startsWith(".") && ent.name !== "node_modules") {
        // shallow one level for pi-ai
        if (full.includes("pi-ai") && ent.name === "opencode-go.json") return full;
      }
    }
    // deeper search for pi-ai folder
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const sub = path.join(dir, ent.name);
        if (sub.includes("pi-ai") || ent.name === "@earendil-works" || ent.name === ".pnpm") {
          const res = findFileRecursive(sub, filename);
          if (res) return res;
        }
      }
    }
  } catch {}
  return null;
}

async function loadPiData(): Promise<{ data: PiData; source: string }> {
  const local = findPiJsonLocal();
  if (local && fs.existsSync(local)) {
    vlog(`Found Pi JSON locally: ${local}`);
    const data = JSON.parse(fs.readFileSync(local, "utf8")) as PiData;
    return { data, source: local };
  }
  // fallback fetch from CDN
  const urls = [
    "https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai/dist/providers/data/opencode-go.json",
    "https://unpkg.com/@earendil-works/pi-ai/dist/providers/data/opencode-go.json",
  ];
  for (const url of urls) {
    try {
      vlog(`Fetching Pi JSON from ${url}`);
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as PiData;
        return { data, source: url };
      }
    } catch (e) {
      vlog(`Fetch failed ${url}: ${e}`);
    }
  }
  throw new Error("Could not locate Pi opencode-go.json locally or via CDN");
}

function flattenPi(data: PiData): Map<string, PiModel> {
  const map = new Map<string, PiModel>();
  for (const apiGroup of Object.values(data)) {
    for (const [id, model] of Object.entries(apiGroup)) {
      map.set(id, model);
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

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// --- src/types.ts sync ---
function syncTypes(
  piMap: Map<string, PiModel>,
  typesPath: string,
  write: boolean,
): { changed: number; diffs: string[] } {
  let content = fs.readFileSync(typesPath, "utf8");
  const original = content;
  const diffs: string[] = [];
  let changed = 0;

  // Find all fallback blocks via regex for each id that exists in Pi
  for (const [piId, piModel] of piMap.entries()) {
    // Only sync if this id exists in FALLBACK
    const idRegex = new RegExp(`id:\\s*"${piId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    if (!idRegex.test(content)) continue;

    // Extract block for this id
    const blockRegex = new RegExp(`\\{\\s*id:\\s*"${piId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]*?\\},`, "m");
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
    const expEfforts = piThinkingToEfforts(piModel); // null => generic, [] => no UI, string[] => specific

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
      const shouldThink = expThinking && expEfforts !== null && expEfforts.length !== 0 ? true : expThinking ? (expEfforts === null ? true : expEfforts.length > 0) : false;
      // Actually for kimi-k2.6, expThinking true but efforts [] => should be false
      const finalThink = expEfforts !== null ? expEfforts.length > 0 : expThinking;
      // For models where Pi has no map, we keep as true (generic)
      const targetThinking = expThinking && expEfforts === null ? curThinking : finalThink;
      if (curThinking !== targetThinking) {
        diffs.push(`${piId}: supportsThinking ${curThinking} -> ${targetThinking}`);
        if (thinkingMatch) {
          block = block.replace(/supportsThinking:\s*(true|false),?/, `supportsThinking: ${targetThinking},`);
        } else {
          // add
          block = block.replace(/apiFormat:\s*"[^"]+",/, `$&\n    supportsThinking: ${targetThinking},`);
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
            block = block.replace(/supportedReasoningEfforts:\s*\[[^\]]*\],?/, `supportedReasoningEfforts: ${expStr},`);
          }
        } else {
          // insert after supportsThinking
          diffs.push(`${piId}: add supportedReasoningEfforts ${expStr}`);
          if (block.includes("supportsThinking:")) {
            block = block.replace(/(supportsThinking:\s*(true|false),?)/, `$1\n    supportedReasoningEfforts: ${expStr},`);
          } else {
            block = block.replace(/(apiFormat:\s*"[^"]+",)/, `$1\n    supportedReasoningEfforts: ${expStr},`);
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

  if (write && changed > 0) {
    fs.writeFileSync(typesPath, content, "utf8");
    log(`Updated ${typesPath} (${changed} blocks)`);
  }
  return { changed, diffs };
}

// --- docs/models.md sync ---
function syncDocs(
  piMap: Map<string, PiModel>,
  typesPath: string,
  docsPath: string,
  write: boolean,
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
    const expApi = piApiToOurs(piModel.api) === "anthropic" ? "Anthropic" : piApiToOurs(piModel.api) === "responses" ? "Responses" : "OpenAI";
    const expEfforts = piThinkingToEfforts(piModel);
    let expThinking: string;
    if (!piModel.reasoning) expThinking = "✗";
    else if (expEfforts === null) expThinking = "✓"; // generic
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
      const visionRe = new RegExp(`(\\|\\s*${cells[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*${curCtx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*${curMax.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*)${curVision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\|)`);
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
  const { data, source } = await loadPiData();
  log(`Source: ${source}`);
  const piMap = flattenPi(data);
  log(`Pi models: ${piMap.size}`);

  // Types sync
  const typesRes = syncTypes(piMap, typesPath, WRITE);
  // Docs sync
  const docsRes = syncDocs(piMap, typesPath, docsPath, WRITE);

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
  if (!WRITE && allDiffs.length > 0) process.exit(1);
}

await main();
