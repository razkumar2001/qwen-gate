# src/routes — API Endpoints

**Domain**: Hono router handlers, SSE streaming, request/response formatting

## OVERVIEW
Implements OpenAI-compatible `/v1/chat/completions`, health checks, metrics, and dashboard UI. All chat responses stream via SSE.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Add new endpoint | `src/index.ts` | Register with `app.get/post()`; add CORS/bearer auth middleware if needed |
| Modify streaming logic | `src/routes/chat.ts` | Callback must return immediately after `yield` to flush `[DONE]` |
| Update dashboard UI | `src/routes/logPage.ts` | Template literal generates HTML/JS; avoid inline `onclick` (use addEventListener) |
| Add metrics endpoint | `src/services/logStore.ts` | Extend `getAllModelHealth()` for new data points |
| Change auth middleware | `src/index.ts:80` | `bearerAuth({ token: process.env.API_KEY })` guards protected routes |

## CONVENTIONS
- **Streaming**: Use `honoStream` + async generator; `yield` chunks, return callback immediately.
- **Error handling**: Return `{ error: { message, type, param, code } }` matching OpenAI spec.
- **Headers**: Always include `x-request-id` (uuid) for tracing; propagate to downstream Qwen calls.
- **Dashboard**: Client-side auth via `window.API_KEY`; no server session for `/dashboard`.

## ANTI-PATTERNS
- ❌ Adding logic after streaming callback return (`chat.ts:1414`) — breaks SSE protocol, causes race conditions.
- ❌ Using `&apos;` in JS template literals — browser parser fails; use `addEventListener` instead of inline `onclick`.
- ❌ Returning non-OpenAI error shapes — clients expect `{ error: { message, ... } }`.
- ❌ Blocking the event loop in route handlers — all I/O must be async; use `Promise.allSettled` for parallel ops.

## UNIQUE PATTERNS
- **SSE heartbeat**: 15s keep-alive `: ping` comments prevent proxy timeouts.
- **Delta streaming**: Only send `content.delta` after first chunk; initial chunk includes full `content`.
- **Tool call parsing**: Extract from Qwen's `<tool_call>` XML tags; validate schema before execution.
- **Dashboard auth**: API_KEY injected into HTML template; client includes `Authorization: Bearer` on fetch.