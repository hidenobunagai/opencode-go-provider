/**
 * The effort-decision layer: a recorded ladder wins over Pi's map, a model Pi carries only
 * generically stays untouched (and is reported), and a malformed decisions file fails loudly
 * instead of silently dropping evidence.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadDecisions,
  resolveEfforts,
  unverifiedEfforts,
  type EffortDecisionSet,
} from "../scripts/effort-decisions";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-decisions-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const decision = (over: Partial<EffortDecisionSet[string]> = {}): EffortDecisionSet[string] => ({
  efforts: ["low", "high"],
  source: "vendor doc",
  decided: "2026-10-04",
  ...over,
});

describe("loadDecisions", () => {
  it("reads a valid file and tolerates a missing one", () => {
    const file = path.join(dir, "decisions.json");
    fs.writeFileSync(file, JSON.stringify({ "model-a": decision() }));

    expect(loadDecisions(file)).toEqual({ "model-a": decision() });
    expect(loadDecisions(path.join(dir, "missing.json"))).toEqual({});
  });

  it("rejects a malformed entry instead of dropping it", () => {
    const file = path.join(dir, "decisions.json");
    for (const bad of [
      { efforts: ["ultra"] },
      { efforts: "low" },
      { source: "  " },
      { decided: "" },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ "model-a": { ...decision(), ...bad } }));
      expect(() => loadDecisions(file)).toThrow(/malformed decision for "model-a"/);
    }
    fs.writeFileSync(file, JSON.stringify({ "model-a": decision(), marker: 1 }));
    expect(() => loadDecisions(file)).toThrow(/malformed decision for "marker"/);
    fs.writeFileSync(file, "[]");
    expect(() => loadDecisions(file)).toThrow(/expected an object keyed by model id/);
  });
});

describe("resolveEfforts", () => {
  it("prefers a recorded decision, sorted into gateway rung order", () => {
    const res = resolveEfforts("model-a", true, ["minimal", "high"], {
      "model-a": decision({ efforts: ["max", "low"] }),
    });

    expect(res.efforts).toEqual(["low", "max"]);
    expect(res.evidence).toBe("decision");
    expect(res.source).toContain("2026-10-04");
  });

  it("falls back to Pi's explicit map, then leaves a generic model untouched", () => {
    expect(resolveEfforts("model-a", true, ["high"], {}).efforts).toEqual(["high"]);
    expect(resolveEfforts("model-a", true, ["high"], {}).evidence).toBe("explicit");
    expect(resolveEfforts("model-a", true, null, {}).efforts).toBeNull();
    expect(resolveEfforts("model-a", true, null, {}).evidence).toBe("generic");
    expect(resolveEfforts("model-a", false, null, {})).toEqual({
      efforts: [],
      evidence: "none",
      source: "pi-ai: not a reasoning model",
    });
  });

  it("lets a decision say a model has no ladder at all", () => {
    const res = resolveEfforts("model-a", true, ["high"], { "model-a": decision({ efforts: [] }) });
    expect(res.efforts).toEqual([]);
    expect(res.evidence).toBe("decision");
  });
});

describe("unverifiedEfforts", () => {
  const models = new Map([
    ["free-model", { reasoning: true, thinkingLevelMap: undefined as never }],
    ["explicit-model", { reasoning: true, thinkingLevelMap: { low: "low" } }],
    ["plain-model", { reasoning: false, thinkingLevelMap: undefined as never }],
  ]);
  const piEffortsOf = (m: {
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }) => (m.reasoning ? (m.thinkingLevelMap ? ["low"] : null) : []);

  it("lists only the generic reasoning models, and only the ids that are shipped", () => {
    expect(
      unverifiedEfforts(["free-model", "explicit-model", "plain-model"], models, piEffortsOf, {}),
    ).toEqual(["free-model"]);
    expect(
      unverifiedEfforts(["free-model", "explicit-model", "plain-model"], models, piEffortsOf, {
        "free-model": decision(),
      }),
    ).toEqual([]);
    expect(unverifiedEfforts(["not-shipped"], models, piEffortsOf, {})).toEqual([]);
  });
});
