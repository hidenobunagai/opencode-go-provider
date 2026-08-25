import { OcGoUsageStatusBar } from "../src/usage-bar";
import { fetchOpenCodeGoUsage } from "../src/usage";

jest.mock("vscode", () => {
  const item = {
    text: "",
    tooltip: "",
    command: "",
    name: "",
    backgroundColor: undefined,
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  };
  return {
    window: {
      createStatusBarItem: jest.fn(() => item),
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
    },
    StatusBarAlignment: { Right: 1 },
    ThemeColor: class {
      constructor(public id: string) {}
    },
  };
});

jest.mock("../src/usage", () => ({
  fetchOpenCodeGoUsage: jest.fn(),
  buildStatusBarText: jest.requireActual("../src/usage").buildStatusBarText,
  buildUsageLine: jest.requireActual("../src/usage").buildUsageLine,
  monthlyPercent: jest.requireActual("../src/usage").monthlyPercent,
}));

import * as vscode from "vscode";

const vscodeMock = vscode as unknown as {
  window: {
    createStatusBarItem: jest.Mock;
    showInformationMessage: jest.Mock;
    showWarningMessage: jest.Mock;
  };
};

function mockItem(): {
  text: string;
  tooltip: string;
  show: jest.Mock;
  hide: jest.Mock;
} {
  return vscodeMock.window.createStatusBarItem.mock.results[0].value;
}

const SAMPLE_USAGE = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2026-08-25T15:00:00Z" },
    weekly: { status: "ok", percent: 16, resetsAt: "2026-08-30T15:00:00Z" },
    monthly: { status: "ok", percent: 76, resetsAt: "2026-08-27T15:00:00Z" },
  },
};

describe("OcGoUsageStatusBar", () => {
  let secrets: { get: jest.Mock };
  let bar: OcGoUsageStatusBar;

  beforeEach(() => {
    jest.clearAllMocks();
    secrets = { get: jest.fn() };
    bar = new OcGoUsageStatusBar(secrets as never, "test-ua");
  });

  it("hides the item when no API key is configured", async () => {
    secrets.get.mockResolvedValue(undefined);
    const line = await bar.refresh();
    expect(line).toBeNull();
    expect(mockItem().hide).toHaveBeenCalled();
  });

  it("shows the compact quota and returns the full line", async () => {
    secrets.get.mockResolvedValue("test-key");
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: "Go usage — 5h 1% (in 4h55m) · 週 16% (in 5d0h) · 月 76% (in 2d2h)",
      usage: SAMPLE_USAGE,
      error: undefined,
    });

    const line = await bar.refresh();
    expect(line).toContain("Go usage —");
    const item = mockItem();
    expect(item.text).toBe("$(gauge) Go 5h 1% · 週 16% · 月 76%");
    expect(item.tooltip).toContain("Go usage — 5h 1%");
    expect(item.show).toHaveBeenCalled();
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows an error state when the fetch fails", async () => {
    secrets.get.mockResolvedValue("test-key");
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: null,
      usage: null,
      error: "HTTP 401",
    });

    const line = await bar.refresh();
    expect(line).toBeNull();
    expect(mockItem().text).toContain("err");
    expect(mockItem().show).toHaveBeenCalled();
  });

  it("warns once when monthly usage crosses the 80% threshold", async () => {
    secrets.get.mockResolvedValue("test-key");
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: "Go usage — 月 85%",
      usage: { usage: { monthly: { percent: 85 } } },
      error: undefined,
    });

    await bar.refresh();
    await bar.refresh(); // same high level again — no spam
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1);

    // drops below threshold, then climbs again — warns again
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: "Go usage — 月 50%",
      usage: { usage: { monthly: { percent: 50 } } },
      error: undefined,
    });
    await bar.refresh();
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: "Go usage — 月 90%",
      usage: { usage: { monthly: { percent: 90 } } },
      error: undefined,
    });
    await bar.refresh();
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it("showUsage shows an info message with the full line", async () => {
    secrets.get.mockResolvedValue("test-key");
    (fetchOpenCodeGoUsage as jest.Mock).mockResolvedValue({
      line: "Go usage — 5h 1% · 週 16% · 月 76%",
      usage: SAMPLE_USAGE,
      error: undefined,
    });

    await bar.showUsage();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Go usage —"),
    );
  });

  it("showUsage informs when usage is unavailable", async () => {
    secrets.get.mockResolvedValue(undefined);
    await bar.showUsage();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("unavailable"),
    );
  });
});
