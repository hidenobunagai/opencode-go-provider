// tool-repair.ts — context extraction, argument repair, tool call dedup
import * as vscode from "vscode";

interface ToolSchema {
  required?: string[];
  enumValues?: Record<string, string[]>;
}

interface ChatRequestContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
}

export function buildToolCallCanonicalKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

export function getCompletedToolCallKeys(
  messages: readonly vscode.LanguageModelChatMessage[],
  requestContext: ChatRequestContext | undefined,
  toolSchemas: ReadonlyMap<string, ToolSchema>,
): Set<string> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) continue;
    const hasNonToolResultContent = message.content.some((part) => {
      const tp = part as { callId?: unknown; content?: unknown[] };
      return !(typeof tp.callId === "string" && Array.isArray(tp.content));
    });
    if (hasNonToolResultContent) {
      startIndex = i + 1;
      break;
    }
  }

  const completedCallIds = new Set<string>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const tp = part as { callId?: unknown; content?: unknown[] };
      if (typeof tp.callId === "string" && Array.isArray(tp.content)) {
        completedCallIds.add(tp.callId);
      }
    }
  }

  const keys = new Set<string>();
  for (const message of messages.slice(startIndex)) {
    for (const part of message.content) {
      const tc = part as { callId?: unknown; name?: unknown; input?: unknown };
      if (
        typeof tc.callId !== "string" ||
        !completedCallIds.has(tc.callId) ||
        typeof tc.name !== "string"
      ) {
        continue;
      }
      const repairedArgs = repairToolArguments(
        tc.name,
        tc.input ?? {},
        requestContext,
        toolSchemas.get(tc.name),
      );
      keys.add(buildToolCallCanonicalKey(tc.name, repairedArgs));
    }
  }
  return keys;
}

export function getToolSchemaMap(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): Map<string, ToolSchema> {
  const map = new Map<string, ToolSchema>();
  for (const tool of options.tools ?? []) {
    const inputSchema = tool.inputSchema as
      | { required?: unknown; properties?: unknown }
      | undefined;
    const required = Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : undefined;
    const enumValues: Record<string, string[]> = {};
    const properties =
      typeof inputSchema?.properties === "object" && inputSchema.properties !== null
        ? (inputSchema.properties as Record<string, unknown>)
        : {};
    for (const [name, value] of Object.entries(properties)) {
      const propSchema =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as { enum?: unknown })
          : undefined;
      if (Array.isArray(propSchema?.enum)) {
        const allowed = propSchema.enum.filter((item): item is string => typeof item === "string");
        if (allowed.length > 0) {
          enumValues[name] = allowed;
        }
      }
    }
    map.set(tool.name, { required, enumValues });
  }
  return map;
}

export function hasRequiredToolArguments(args: unknown, schema: ToolSchema | undefined): boolean {
  const required = schema?.required ?? [];
  if (required.length === 0) return true;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  return required.every(
    (key) =>
      key in record && record[key] !== undefined && record[key] !== null && record[key] !== "",
  );
}

export function buildInvalidToolCallFallback(
  skippedToolCalls: readonly { name: string; required: string[] }[],
): string | undefined {
  const skippedWithRequiredArgs = skippedToolCalls.find((tc) => tc.required.length > 0);
  if (!skippedWithRequiredArgs) return undefined;
  const requiredArgs = skippedWithRequiredArgs.required.map((a) => `\`${a}\``).join(", ");
  return `The model tried to call \`${skippedWithRequiredArgs.name}\` without the required argument(s) ${requiredArgs}. Please retry the request and provide those arguments explicitly.`;
}

export function extractChatRequestContext(
  messages: readonly vscode.LanguageModelChatMessage[],
): ChatRequestContext | undefined {
  const filePattern = /The user's current file is\s+([^\n]+?)\.(?:\s|$)/;
  const selectionPattern = /The current selection is from line\s+(\d+)\s+to line\s+(\d+)/;
  const cwdPattern = /(?:^|\n)Cwd:\s+([^\n]+)/;
  const context: ChatRequestContext = {};

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.content) {
      const text =
        part instanceof vscode.LanguageModelTextPart
          ? part.value
          : typeof part === "object" &&
              part !== null &&
              "value" in part &&
              typeof (part as { value?: unknown }).value === "string"
            ? (part as { value: string }).value
            : undefined;
      if (!text) continue;

      const fileMatch = text.match(filePattern);
      const selectionMatch = text.match(selectionPattern);
      const cwdMatch = text.match(cwdPattern);

      if (fileMatch && !context.filePath) context.filePath = fileMatch[1].trim();
      if (cwdMatch && !context.cwd) context.cwd = cwdMatch[1].trim();
      if (selectionMatch && context.startLine === undefined && context.endLine === undefined) {
        const startLine = Number(selectionMatch[1]);
        const endLine = Number(selectionMatch[2]);
        if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
          context.startLine = startLine;
          context.endLine = endLine;
        }
      }
      if (
        context.filePath &&
        context.cwd &&
        context.startLine !== undefined &&
        context.endLine !== undefined
      )
        break;
    }
  }

  return context.filePath ||
    context.cwd ||
    context.startLine !== undefined ||
    context.endLine !== undefined
    ? context
    : undefined;
}

export function repairToolArguments(
  toolName: string,
  args: unknown,
  requestContext: ChatRequestContext | undefined,
  schema?: ToolSchema,
): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;

  const record = args as Record<string, unknown>;
  const required = new Set(schema?.required ?? []);
  const needsStringField = (value: unknown, field: string): boolean =>
    required.has(field) && (typeof value !== "string" || value.trim().length === 0);
  const needsNumberField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "number";
  const needsBooleanField = (value: unknown, field: string): boolean =>
    required.has(field) && typeof value !== "boolean";

  const repaired = { ...record };
  const context = requestContext;

  if (needsBooleanField(repaired.isRegexp, "isRegexp")) repaired.isRegexp = false;
  if (needsBooleanField(repaired.includeIgnoredFiles, "includeIgnoredFiles"))
    repaired.includeIgnoredFiles = false;

  if (toolName === "grep_search" && needsStringField(repaired.query, "query")) {
    repaired.query = context?.filePath
      ? context.filePath.split(/[/\\]/).pop() || ""
      : "TODO: MISSING QUERY";
  }
  if (toolName === "file_search" && needsStringField(repaired.query, "query")) {
    repaired.query = context?.filePath
      ? context.filePath.split(/[/\\]/).pop() || ""
      : "TODO: MISSING QUERY";
  }
  if (toolName === "semantic_search" && needsStringField(repaired.query, "query")) {
    repaired.query = "TODO: MISSING QUERY";
  }

  if (!context) return repaired;

  if (toolName === "read_file") {
    const inferredFilePath =
      context?.filePath ??
      vscode.window.activeTextEditor?.document.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
      ...repaired,
      ...(needsStringField(repaired.filePath, "filePath") && inferredFilePath
        ? { filePath: inferredFilePath }
        : {}),
      ...(needsNumberField(repaired.startLine, "startLine")
        ? { startLine: context.startLine ?? 1 }
        : {}),
      ...(needsNumberField(repaired.endLine, "endLine") ? { endLine: context.endLine ?? 200 } : {}),
    };
  }

  if (toolName === "list_dir") {
    return {
      ...repaired,
      ...(needsStringField(repaired.path, "path") && context.cwd ? { path: context.cwd } : {}),
    };
  }

  // run_in_terminal: required args are command, explanation, goal, mode, timeout.
  // command is the only truly required arg; the rest have safe defaults.
  if (toolName === "run_in_terminal") {
    if (needsStringField(repaired.command, "command")) {
      // Without a command, the tool call is fundamentally invalid — skip repair
      return repaired;
    }
    return {
      ...repaired,
      ...(needsStringField(repaired.explanation, "explanation")
        ? { explanation: "Run command in terminal" }
        : {}),
      ...(needsStringField(repaired.goal, "goal") ? { goal: "Execute command" } : {}),
      ...(needsStringField(repaired.mode, "mode") ? { mode: "sync" } : {}),
      ...(needsNumberField(repaired.timeout, "timeout") ? { timeout: 30000 } : {}),
    };
  }

  return repaired;
}

export function isToolCallInput(args: unknown): args is Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

export type { ToolSchema, ChatRequestContext };
