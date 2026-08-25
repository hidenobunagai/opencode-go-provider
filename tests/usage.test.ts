import {
  buildStatusBarText,
  buildUsageLine,
  fetchOpenCodeGoUsage,
  fmtResetsAt,
  monthlyPercent,
  OpenCodeGoUsage,
} from "../src/usage";

const SAMPLE: OpenCodeGoUsage = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2026-08-25T15:00:00Z" },
    weekly: { status: "ok", percent: 16, resetsAt: "2026-08-30T15:00:00Z" },
    monthly: { status: "ok", percent: 76, resetsAt: "2026-08-27T15:00:00Z" },
  },
};

describe("buildUsageLine", () => {
  it("formats rolling/weekly/monthly like Pi's go-usage line", () => {
    const line = buildUsageLine(SAMPLE);
    expect(line).toMatch(/^Go usage — /);
    expect(line).toContain("5h 1% (in ");
    expect(line).toContain("週 16% (in ");
    expect(line).toContain("月 76% (in ");
    expect(line).toContain(" · ");
  });

  it("returns null when no usage windows exist", () => {
    expect(buildUsageLine({})).toBeNull();
    expect(buildUsageLine({ usage: {} })).toBeNull();
  });

  it("handles missing fields with ?", () => {
    const line = buildUsageLine({ usage: { monthly: { percent: 42 } } });
    expect(line).toBe("Go usage — 月 42% (in -)");
  });
});

describe("buildStatusBarText", () => {
  it("produces a compact line without reset times", () => {
    expect(buildStatusBarText(SAMPLE)).toBe("Go 5h 1% · 週 16% · 月 76%");
  });

  it("returns null with no windows", () => {
    expect(buildStatusBarText({})).toBeNull();
  });
});

describe("fmtResetsAt", () => {
  it("returns '-' for missing iso", () => {
    expect(fmtResetsAt()).toBe("-");
  });

  it("returns 'soon' for past dates", () => {
    expect(fmtResetsAt("2000-01-01T00:00:00Z")).toBe("soon");
  });

  it("formats future dates as days+hours when > 24h", () => {
    const future = new Date(Date.now() + 50 * 3600 * 1000).toISOString();
    expect(fmtResetsAt(future)).toMatch(/^\d+d\d+h$/);
  });

  it("formats future dates as h+m when <= 24h", () => {
    const future = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    expect(fmtResetsAt(future)).toMatch(/^\d+h\d+m$/);
  });

  it("returns the raw string on parse failure", () => {
    expect(fmtResetsAt("not-a-date")).toBe("not-a-date");
  });
});

describe("monthlyPercent", () => {
  it("extracts monthly percent", () => {
    expect(monthlyPercent(SAMPLE)).toBe(76);
    expect(monthlyPercent({})).toBeUndefined();
  });
});

describe("fetchOpenCodeGoUsage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns null for missing api key", async () => {
    const result = await fetchOpenCodeGoUsage(undefined);
    expect(result).toEqual({ line: null, usage: null });
  });

  it("fetches usage with bearer auth and formats the line", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE,
    }) as never;

    const result = await fetchOpenCodeGoUsage("test-key", "test-ua/1.0");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "User-Agent": "test-ua/1.0",
        }),
      }),
    );
    expect(result.usage).toEqual(SAMPLE);
    expect(result.line).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it("returns error info on http failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }) as never;

    const result = await fetchOpenCodeGoUsage("bad-key");
    expect(result.line).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.error).toContain("HTTP 401");
  });

  it("returns error info on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as never;
    const result = await fetchOpenCodeGoUsage("test-key");
    expect(result.error).toBe("network down");
  });
});
