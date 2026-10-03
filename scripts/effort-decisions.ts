/**
 * Researched thinking-effort ladders, recorded per model in `docs/effort-decisions.json`.
 *
 * Pi's `thinkingLevelMap` is the default source of a ladder, but Pi carries only the generic
 * "reasoning: true" default for many models — nothing then says which effort rungs the vendor
 * actually offers, and the extension would ship whatever it had. A decision records that
 * research (vendor doc / probe result) and wins over Pi, so a researched ladder also survives
 * a Pi regression. `docs/contributing.md` has the "Thinking efforts" section this file backs.
 *
 * Shape, one entry per model id:
 *   {
 *     "mimo-v2.6-flash": {
 *       "efforts": ["low", "medium", "high"],
 *       "source": "https://platform.xiaomimimo.com/docs/reasoning (2026-10-04 probe: low/high rejected)",
 *       "decided": "2026-10-04"
 *     }
 *   }
 *
 * `efforts: []` is a decision too: it says the vendor offers no effort ladder, so the entry
 * must not show an effort picker. Kept I/O-free apart from reading the file, so Jest can
 * exercise it with fixtures.
 */
import fs from "fs";

/** Gateway rung order, the order a ladder is written in. */
export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface EffortDecision {
  efforts: string[];
  /** Where the ladder comes from: vendor doc URL, probe result, ... */
  source: string;
  /** ISO date the decision was recorded. */
  decided: string;
}

export type EffortDecisionSet = Record<string, EffortDecision>;

export type EffortEvidence = "decision" | "explicit" | "generic" | "none";

export interface EffortResolution {
  /**
   * Levels to write into the extension. `null` means Pi is generic and no decision exists:
   * callers must leave the entry as it is rather than guess.
   */
  efforts: string[] | null;
  evidence: EffortEvidence;
  source: string;
}

/** Read the decisions file. A malformed entry throws: a typo must not silently drop evidence. */
export function loadDecisions(file: string): EffortDecisionSet {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as EffortDecisionSet;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: expected an object keyed by model id`);
  }
  for (const [id, decision] of Object.entries(parsed)) {
    const bad =
      !decision ||
      !Array.isArray(decision.efforts) ||
      decision.efforts.some((rung) => !(EFFORT_ORDER as readonly string[]).includes(rung)) ||
      typeof decision.source !== "string" ||
      decision.source.trim() === "" ||
      typeof decision.decided !== "string" ||
      decision.decided.trim() === "";
    if (bad) {
      throw new Error(
        `${file}: malformed decision for "${id}" — expected { efforts: [${EFFORT_ORDER.join(", ")}], source, decided }`,
      );
    }
  }
  return parsed;
}

/**
 * The ladder for one model, in evidence order: recorded decision → explicit Pi map → Pi's
 * generic default. `piEfforts` is `piThinkingToEfforts`'s answer (null = generic).
 */
export function resolveEfforts(
  id: string,
  reasoning: boolean,
  piEfforts: string[] | null,
  decisions: EffortDecisionSet,
): EffortResolution {
  const decision = decisions[id];
  if (decision) {
    return {
      efforts: [...decision.efforts].sort(
        (a, b) =>
          (EFFORT_ORDER as readonly string[]).indexOf(a) -
          (EFFORT_ORDER as readonly string[]).indexOf(b),
      ),
      evidence: "decision",
      source: `decision ${decision.decided}: ${decision.source}`,
    };
  }
  if (!reasoning) return { efforts: [], evidence: "none", source: "pi-ai: not a reasoning model" };
  if (piEfforts !== null) {
    return { efforts: piEfforts, evidence: "explicit", source: "pi-ai explicit thinkingLevelMap" };
  }
  return {
    efforts: null,
    evidence: "generic",
    source: "pi-ai generic reasoning default (no level map)",
  };
}

/**
 * Ids whose ladder rests on nothing: Pi carries the generic "reasoning: true" default and no
 * decision is recorded. The sync leaves such entries alone, so this is the only place they
 * surface. `sync-from-pi.ts` prints it as a warning (never as drift): a model added in a hurry
 * keeps its current picker, but the gap stays visible until someone records a decision.
 */
export function unverifiedEfforts<M extends { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }>(
  syncedIds: Iterable<string>,
  piMap: Map<string, M>,
  piEffortsOf: (model: M) => string[] | null,
  decisions: EffortDecisionSet,
): string[] {
  const out: string[] = [];
  for (const id of syncedIds) {
    const model = piMap.get(id);
    if (!model) continue;
    const resolved = resolveEfforts(id, model.reasoning, piEffortsOf(model), decisions);
    if (resolved.evidence === "generic") out.push(id);
  }
  return out;
}
