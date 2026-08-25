import { debugLog } from "./output-channel";

/** OpenCode Go quota endpoint: rolling (5h), weekly, monthly usage percentages. */
const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

/** Quota fetch is informational only and must never block the chat. */
const USAGE_FETCH_TIMEOUT_MS = 6000;

export interface UsageWindowInfo {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

export interface OpenCodeGoUsage {
  usage?: {
    rolling?: UsageWindowInfo;
    weekly?: UsageWindowInfo;
    monthly?: UsageWindowInfo;
  };
}

/** Human-duration until a quota window resets ("4h55m", "2d2h", "12m"). */
export function fmtResetsAt(iso?: string): string {
  if (!iso) {
    return "-";
  }
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(diff)) {
      return iso;
    }
    if (diff <= 0) {
      return "soon";
    }
    const totalHours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (totalHours > 24) {
      return `${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
    }
    if (totalHours > 0) {
      return `${totalHours}h${minutes}m`;
    }
    return `${minutes}m`;
  } catch {
    return iso;
  }
}

/** Full Pi-style line: "Go usage — 5h 1% (in 4h55m) · 週 16% (in 5d0h) · 月 76% (in 2d2h)". */
export function buildUsageLine(usage: OpenCodeGoUsage): string | null {
  const { rolling, weekly, monthly } = usage.usage ?? {};
  if (!rolling && !weekly && !monthly) {
    return null;
  }
  const parts: string[] = [];
  if (rolling) {
    parts.push(`5h ${rolling.percent ?? "?"}% (in ${fmtResetsAt(rolling.resetsAt)})`);
  }
  if (weekly) {
    parts.push(`週 ${weekly.percent ?? "?"}% (in ${fmtResetsAt(weekly.resetsAt)})`);
  }
  if (monthly) {
    parts.push(`月 ${monthly.percent ?? "?"}% (in ${fmtResetsAt(monthly.resetsAt)})`);
  }
  return `Go usage — ${parts.join(" · ")}`;
}

/** Compact status-bar text without reset times: "Go 5h 1% · 週 16% · 月 76%". */
export function buildStatusBarText(usage: OpenCodeGoUsage): string | null {
  const { rolling, weekly, monthly } = usage.usage ?? {};
  if (!rolling && !weekly && !monthly) {
    return null;
  }
  const parts: string[] = [];
  if (rolling) {
    parts.push(`5h ${rolling.percent ?? "?"}%`);
  }
  if (weekly) {
    parts.push(`週 ${weekly.percent ?? "?"}%`);
  }
  if (monthly) {
    parts.push(`月 ${monthly.percent ?? "?"}%`);
  }
  return `Go ${parts.join(" · ")}`;
}

export function monthlyPercent(usage: OpenCodeGoUsage): number | undefined {
  return usage.usage?.monthly?.percent;
}

export interface UsageFetchResult {
  line: string | null;
  usage: OpenCodeGoUsage | null;
  error?: string;
}

export async function fetchOpenCodeGoUsage(
  apiKey?: string,
  userAgent?: string,
): Promise<UsageFetchResult> {
  if (!apiKey) {
    return { line: null, usage: null };
  }
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(userAgent ? { "User-Agent": userAgent } : {}),
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `HTTP ${response.status} ${body.slice(0, 120)}`;
      debugLog("fetchUsage", error);
      return { line: null, usage: null, error };
    }
    const usage = (await response.json()) as OpenCodeGoUsage;
    const line = buildUsageLine(usage);
    debugLog("fetchUsage", line ?? "no usage data");
    return { line, usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog("fetchUsageError", message);
    return { line: null, usage: null, error: message };
  }
}
