# OpenCode Go Provider Refinement Design

## Goal

Elevate the OpenCode Go VS Code extension to match GitHub Copilot Native provider quality by restructuring the codebase, improving token estimation, enabling dynamic model discovery, and hardening error/type safety.

## Scope

Six independent phases, executed sequentially:

| # | Phase | Impact | Risk |
|---|-------|--------|------|
| 1 | Decompose `provider.ts` (1595→~400 lines) | Maintainability | High (structural change, tests must pass) |
| 2 | Accurate token estimation | User-facing correctness | Low (drop-in replacement) |
| 3 | Enable `fetchModels` for dynamic model list | User-facing freshness | Low (async, graceful fallback) |
| 4 | Parallelize image processing | Latency (5x for 5 images) | Low |
| 5 | Surface swallowed errors | Debuggability | Low |
| 6 | Tighten `any` types | Type safety | Medium |

---

## Phase 1: provider.ts Decomposition

### Current State

`OcGoChatModelProvider` (1595 lines) handles:

- Model info lifecycle (caching, fallback, mapping)
- API key management
- Image routing (vision vs. non-vision)
- OpenAI-format streaming with tool calls (delta + text-embedded + XML)
- Anthropic-format SSE streaming
- DeepSeek special case on /messages endpoint
- Tool argument repair
- System prompt guidance (identity + tool grounding)
- Token count estimation (also duplicated in utils.ts)

### Target State

```
src/
  provider.ts         (~350 lines) — lifecycle, dispatch, orchestration
  streaming/
    openai.ts         (~200 lines) — OpenAI SSE streaming + tool call assembly
    anthropic.ts      (~250 lines) — Anthropic SSE streaming + tool call assembly
  tool-parser.ts      (~200 lines) — text-embedded / XML tool call parsing
  tool-repair.ts      (~150 lines) — context extraction + argument repair + dedup
  guidance.ts         (~100 lines) — system prompt sanitization + identity + grounding
  utils.ts            (~300 lines) — message/tool conversion (shrunk)
  types.ts            (~320 lines) — unchanged
  api.ts              (~200 lines) — unchanged
  constants.ts        (~30 lines)  — unchanged
```

### Module Boundaries

| Module | Exports | Dependencies |
|--------|---------|-------------|
| `tool-parser.ts` | `parseTextEmbeddedToolCalls`, `parseXmlStyleToolCall`, `findTrailingTokenPrefixStart` | none |
| `tool-repair.ts` | `extractChatRequestContext`, `repairToolArguments`, `getCompletedToolCallKeys`, `buildToolCallCanonicalKey`, `hasRequiredToolArguments`, `getToolSchemaMap` | vscode, types |
| `guidance.ts` | `sanitizeSystemPromptForModel`, `buildProviderIdentityGuidance`, `buildToolUseGroundingGuidance`, `applyOpenAiSystemPromptGuidance` | types |
| `streaming/openai.ts` | `processOpenAIStream` | vscode, api, tool-parser, tool-repair, guidance, output-channel |
| `streaming/anthropic.ts` | `processAnthropicStream` | vscode, constants, tool-parser, tool-repair, guidance, output-channel, types |
| `provider.ts` | `OcGoChatModelProvider` | all above + streaming modules |

### Non-goals

- No behavioral changes to tool call dedup, repair, or fallback logic
- No changes to message conversion (utils.ts)
- No changes to public API shape

---

## Phase 2: Token Estimation

### Current

`estimateTokens(text) = ceil(text.length / 2)` — single fixed ratio for all content.

### Target

Use `tiktoken` (via `@dqbd/tiktoken` npm package, which bundles a WASM tokenizer) to estimate tokens accurately for the model's encoding:

```
import { encoding_for_model } from "@dqbd/tiktoken";

export function estimateTokens(text: string, modelId?: string): number {
  const enc = encoding_for_model(mapToTiktokenModel(modelId));
  const tokens = enc.encode(text).length;
  enc.free();
  return tokens;
}
```

For unknown model IDs, fall back to the current heuristic (conservative overestimate).

This is a drop-in replacement — same function signature, more accurate results.

### Why Not Call API?

The OpenCode Go API already returns `usage.prompt_tokens` in stream responses. We can use that as a ground-truth signal for future tuning, but the token count must be available *before* the request is sent (VS Code calls `provideTokenCount` upfront).

---

## Phase 3: Dynamic Model Discovery

### Current

`fetchModels` defined but never called. `provideLanguageModelChatInformation` always returns `FALLBACK_MODELS` or `globalState` cache (which is never populated from API).

### Target

On `activate()` in `extension.ts`, kick off an async fetch to `GET /models`. On success, store in `globalState` under `opencode-go.models`. On failure (API returns null/error), keep existing cache or fallback — never block.

The provider returns cached models immediately (non-blocking, as today). Cache is updated asynchronously.

### Schema

The API response shape (`{ data: [{ id: string, name: string }] }`) is already handled. New models without entries in `FALLBACK_MODELS` get safe defaults: `contextWindow: 262144, maxOutput: 65536, supportsTools: true, supportsVision: false`.

---

## Phase 4: Parallel Image Processing

### Current

```ts
for (const img of images) {
  const description = await this._mcpClient.analyzeImage(...);
  descriptions.push(description);
}
```

Sequential API calls — 5 images = 5x latency.

### Target

```ts
const descriptions = await Promise.all(
  images.map(async (img) => {
    if (token.isCancellationRequested) throw new CancellationError();
    return this._mcpClient.analyzeImage(...);
  }),
);
```

---

## Phase 5: Surface Swallowed Errors

### Current

Three classes of silent failure:

1. `api.ts` SSE parse errors: `catch { /* Ignore malformed lines */ }`
2. `provider.ts` JSON parse in tool call assembly: `catch { /* keep empty input */ }`
3. `provider.ts` JSON parse in Anthropic handler: `catch { /* keep empty input */ }`

### Target

Add `debugLog` calls at minimum. For persistent failures (e.g., >10 malformed SSE lines in one stream), report a warning to the user via `vscode.window.showWarningMessage`.

---

## Phase 6: Type Tightening

### Current

~240 warnings, mostly:
- `as any` casts in `extractChatRequestContext`, `hasImageInput`, `getCompletedToolCallKeys`, `processImagesForNonVisionModel`
- `LegacyPart` with `[key: string]: unknown`

### Target

- Replace `as any` with discriminated unions + proper type guards
- Widen `LegacyPart` fields only where truly necessary, prefer `instanceof` checks
- Use VS Code's exported type `LanguageModelInputPart` instead of `LegacyPart` where possible

---

## Key Constraints

1. **All tests must pass** after each phase (CI gate: `bun run test -- --runInBand`)
2. **No lint errors** — warnings are acceptable per phase, but the final state must reduce them
3. **No breaking changes** to extension public API (commands, model IDs)
4. **No placeholders** — every refactored module must be complete

## Testing Strategy

- Existing tests remain unchanged (they test behavior, not internal structure)
- New unit tests for extracted modules (`tool-parser.ts`, `tool-repair.ts`, `guidance.ts`)
- Integration tests for streaming modules mock the fetch layer
