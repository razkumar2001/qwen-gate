# Professional Streaming Patterns — How Production LLM Proxies Do It Right

> **Date**: 2026-05-30
> **Source**: 7 librarian agents + grep_app code search across 50+ production repos + Preto.ai production case study
> **Projects analyzed**: LiteLLM (20k★), one-api/new-api (10k★), openai-node (7k★), Vercel AI SDK (15k★), open-webui, fastchat, eventsource-parser, @microsoft/fetch-event-source, NextChat, Continue.dev, excalidraw, BrowserOS, assistant-ui, Jina Reader, Preto.ai

---

## Executive Summary

Every production-grade LLM proxy converges on **the same 6 architectural decisions**. The projects that get streaming right share these invariants:

1. **Never forward raw upstream bytes** — always parse → transform → re-serialize
2. **JSON.parse is the gate** — unparseable chunks are dropped with a warning, never forwarded
3. **Buffer at line boundaries, not byte boundaries** — SSE events are `\n\n`-delimited
4. **Tool calls accumulate by index** — never emit argument fragments to the client
5. **Filter deltas, not just accumulated text** — safety net runs on every chunk before emission
6. **Soft errors continue, fatal errors terminate** — structured telemetry, not inline error text

This document catalogs the patterns, the anti-patterns we observed, and concrete code you can copy.

---

## Table of Contents

1. [SSE Parsing — The Foundation](#1-sse-parsing)
2. [Streaming Pipeline Architecture](#2-streaming-pipeline-architecture)
3. [Tool Call Streaming — The Hard Part](#3-tool-call-streaming)
4. [Output Sanitization Patterns](#4-output-sanitization-patterns)
5. [Error Handling in Streams](#5-error-handling-in-streams)
6. [Backpressure and Flow Control](#6-backpressure-and-flow-control)
7. [Production Failure Modes (Preto.ai)](#7-production-failure-modes)
8. [Universal Principles Checklist](#8-universal-principles-checklist)
9. [References](#9-references)

---

## 1. SSE Parsing

### The Three Approaches (Production-Proven)

#### Approach A: String-Level Parsing (eventsource-parser)

**When to use**: Client-side SSE consumption, Node.js with `TextDecoderStream`.

typescript
// From eventsource-parser (used by Vercel AI SDK, LangChain.js)
export class EventSourceParserStream extends TransformStream<string, ParsedEvent> {
  constructor() {
    let parser: EventSourceParser;
    super({
      start(controller) {
        parser = createParser((event) => {
          if (event.type === 'event') {
            controller.enqueue(event);
          }
        });
      },
      transform(chunk) {
        parser.feed(chunk);
      },
    });
  }
}


**Pipeline**: `fetch() → response.body → TextDecoderStream → EventSourceParserStream → consumer`

**Key features**:
- `onComment` callback for heartbeat handling
- `onRetry` for `retry:` field propagation
- First-chunk BOM stripping
- `terminateOnError: true` option for strict mode

#### Approach B: Byte-Level Parsing (@microsoft/fetch-event-source)

**When to use**: When you need maximum control and zero-copy parsing.

typescript
// From @microsoft/fetch-event-source
export function getLines(onLine: (line: Uint8Array, fieldLength: number) => void) {
  let buffer: Uint8Array | undefined;
  let position: number;
  let fieldLength: number;
  let discardTrailingNewline = false;

  return function onChunk(arr: Uint8Array) {
    if (buffer === undefined) {
      buffer = arr;
      position = 0;
      fieldLength = -1;
    } else {
      // Concatenate with previous buffer
      const concat = new Uint8Array(buffer.length + arr.length);
      concat.set(buffer);
      concat.set(arr, buffer.length);
      buffer = concat;
    }
    // Scan for line boundaries, emit complete lines
    // ...
  };
}


**Tradeoff**: O(N²) on chunk concatenation vs O(N) for fragment arrays. Use fragment arrays for high-throughput.

#### Approach C: LineDecoder (openai-node) — The Reference Implementation

**When to use**: Reference implementation pattern from OpenAI's official SDK.

typescript
// From openai-node src/core/streaming.ts
class LineDecoder {
  private buffer: Uint8Array[] = [];

  decode(chunk: Uint8Array): string[] {
    this.buffer.push(chunk);
    const text = new TextDecoder().decode(concatUint8Arrays(this.buffer));
    const lines = text.split('\n');
    // Keep last potentially incomplete line in buffer
    const incomplete = lines.pop() || '';
    this.buffer = [new TextEncoder().encode(incomplete)];
    return lines;
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const text = new TextDecoder().decode(concatUint8Arrays(this.buffer));
    this.buffer = [];
    return text ? [text] : [];
  }
}


**Key insight**: Buffer is an **array of Uint8Array fragments**, not a single concatenated array. This avoids O(N²) copies on every chunk.

### Universal SSE Parsing Rules

| Rule | Why | Evidence |
|------|-----|----------|
| Buffer incomplete lines until `\n\n` | SSE events are double-newline delimited | All 7 libraries |
| Strip UTF-8 BOM on first chunk | Windows/BOM-aware editors inject it | eventsource-parser |
| Handle `\r\n` and `\n` equally | Windows proxies, some upstreams use CRLF | fetch-event-source |
| `[DONE]` is prefix-matched, not exact | Some providers add whitespace | openai-node |
| `data:` field is accumulated across lines | Multi-line SSE events are legal | W3C SSE spec |
| `id:` and `retry:` are optional but propagated | Reconnection support | eventsource-parser |

---

## 2. Streaming Pipeline Architecture

### Pattern A: LiteLLM — Provider-Agnostic Abstraction Layer

```
Client ←── CustomStreamWrapper ←── ModelResponseIterator ←── Provider SSE
               │
               ├── apply_filters(parsed_chunk)
               ├── accumulate_in_chunks[]    # for stream_chunk_builder
               ├── holding_chunk             # token buffering
               └── _check_max_streaming_duration()  # timeout


**Key design choices**:
- **ModelResponseIterator** is the universal interface — every provider implements `chunk_parser(chunk) → GenericStreamingChunk`
- **CustomStreamWrapper** runs on every chunk: filter → accumulate → timeout check → yield
- **stream_chunk_builder** reconstructs complete response from `self.chunks[]` for non-streaming fallback
- **holding_chunk** buffers single tokens to detect empty streams before yielding

**Anti-pattern LiteLLM avoids**: Each provider has its own SSE format. The `chunk_parser` abstraction normalizes everything to `GenericStreamingChunk` before the wrapper sees it.

### Pattern B: new-api (Go) — Centralized Scanner with Telemetry

```
Client ←── RelayStreamFilter ←── StreamScanner ←── Provider-specific Handler
                                    │
                                    ├── StreamResult (SoftError | FatalError | Done)
                                    ├── StreamStatus + StreamEndReason telemetry
                                    └── lastStreamData (delayed chunk for format conversion)


**Key design choices**:
- **StreamResult** flow control: `SoftError` continues the stream, `FatalError` terminates
- **lastStreamData** delayed chunk: holds previous chunk to detect format boundaries
- **ThinkingToContent**: converts Anthropic thinking blocks to OpenAI content format
- **ForceFormat**: normalizes tool call format across providers

**vs one-api**: one-api duplicates the scan loop in every adaptor. new-api centralizes it. This is the architectural evolution we should follow.

### Pattern C: Vercel AI SDK — TransformStream Pipeline

typescript
// The wire format pipeline
UIMessageChunks
  → JsonToSseTransformStream    // Each chunk → `data: ${JSON.stringify(part)}\n\n`
  → TextEncoderStream           // String → Uint8Array
  → HTTP Response

export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue('data: [DONE]\n\n');
      },
    });
  }
}
```

**Key design choices**:
- **TransformStream** handles backpressure natively
- **Tee pattern** for dual consumption: `const [stream1, stream2] = sseStream.tee()` — one goes to client, one to `consumeSseStream` callback for logging
- **UIMessageStream protocol** on top of SSE — typed chunks (`text-start`, `text-delta`, `tool-input-start`, `tool-input-delta`, `tool-result`, `finish`)

### Pattern D: Preto.ai (Go Production) — bufio.Scanner with Custom Split

go
// From Preto.ai production proxy (5,000+ req/s at <50ms p95)
scanner := bufio.NewScanner(upstream.Body)
scanner.Split(splitSSEEvent)  // Custom split function

for scanner.Scan() {
    event := scanner.Bytes()
    // Inspect/annotate the frame
    annotated := processFrame(event)
    
    _, err := w.Write(annotated)
    if err != nil {
        return  // Client disconnected
    }
    flusher.Flush()  // CRITICAL: flush on every event
}


**Key insight**: "The `Flusher` call on every event is critical. Without it, Go's `http.ResponseWriter` buffers writes and the client gets chunks in batches — defeating the purpose of streaming."

**For Node.js/Hono equivalent**: `await streamWriter.write(event)` with explicit await is the equivalent. Never fire-and-forget writes.

---

## 3. Tool Call Streaming

### The Problem

Tool calls in streaming mode arrive as **incremental string deltas** for `function.arguments`. Example:

```
Chunk 1: {tool_calls: [{index: 0, id: "call_abc", function: {name: "search", arguments: "{\"q"}}]}
Chunk 2: {tool_calls: [{index: 0, function: {arguments: "uery\": "t"}}]}
Chunk 3: {tool_calls: [{index: 0, function: {arguments: "est"}}]}
Chunk 4: {tool_calls: [{index: 0, function: {arguments: "\"}"}}]}


The accumulated result must be: `{"query": "test"}`.

### The Canonical Pattern (NextChat, continue.dev, openai-node)

typescript
// From NextChat (ChatGPT-Next-Web) — production pattern
const runTools: ChatMessageTool[] = [];

for await (const chunk of stream) {
  const tool_calls = choices[0]?.delta?.tool_calls;
  if (tool_calls?.length > 0) {
    const index = tool_calls[0]?.index;
    const id = tool_calls[0]?.id;
    const args = tool_calls[0]?.function?.arguments;
    
    if (id) {
      // First fragment: create new tool call entry
      runTools.push({
        id,
        type: tool_calls[0]?.type,
        function: {
          name: tool_calls[0]?.function?.name as string,
          arguments: args,
        },
      });
    } else {
      // Subsequent fragments: append to existing by index
      runTools[index]["function"]["arguments"] += args;
    }
  }
}


### Critical Rules

| Rule | Why |
|------|-----|
| **Track by index, not by id** | Multiple concurrent tool calls use sequential indexes |
| **Append argument fragments, don't replace** | Each delta is a substring, not the full value |
| **Never emit partial arguments to client** | Forward as-is only if you're a pass-through proxy |
| **Parse accumulated args only on tool call completion** | `finish_reason: "tool_calls"` or stream end |
| **Handle missing `id` on subsequent chunks** | Only the first delta for a tool call has `id` |
| **Handle missing `name` on subsequent chunks** | Only the first delta has `function.name` |

### What We're Doing Wrong

Our current parser in `src/tools/parser.ts` tries to **extract JSON from text content** rather than consuming the structured `tool_calls` delta array. This is why fragments like `"arguments":}` leak — we're parsing text that was never meant to be text.

**The fix**: If the upstream provides structured `tool_calls` deltas (which Qwen does), consume them directly. Only fall back to text extraction for providers that embed tool calls in content (like some Anthropic/Claude models).

### Vercel AI SDK's Approach

Vercel uses typed chunks in their UIMessageStream protocol:

typescript
// tool-input-start: first time we see this tool
case "tool-input-start":
  return chatChunkFromDelta({
    delta: {
      tool_calls: [{
        index: 0,
        id: part.id,
        type: "function",
        function: { name: part.toolName, arguments: "" },
      }],
    },
  });

// tool-input-delta: argument fragment
case "tool-input-delta":
  return chatChunkFromDelta({
    delta: {
      tool_calls: [{
        index: 0,
        function: { arguments: part.inputTextDelta },
      }],
    },
  });


The separation of `start` and `delta` events makes accumulation explicit and bug-free.

---

## 4. Output Sanitization Patterns

### Pattern A: new-api's First-Class Sanitization

new-api treats sanitization as a **pipeline stage**, not an afterthought:


Raw Chunk → Parse → ThinkingToContent → ForceFormat → ContentFilter → Emit
```

- **ThinkingToContent**: Converts Anthropic `<thinking>` blocks into OpenAI `reasoning_content` field
- **ForceFormat**: Normalizes tool call format regardless of upstream provider
- **ContentFilter**: Regex-based content filtering before emission

### Pattern B: Vercel AI SDK's TransformStream Layers

typescript
// Multiple TransformStream layers, each with a single responsibility
const stream = source
  .pipeThrough(new NormalizeChunksTransform())    // Provider normalization
  .pipeThrough(new IDInjectionTransform())         // Add IDs to chunks
  .pipeThrough(new ToolCallAccumulatorTransform()) // Build complete tool calls
  .pipeThrough(new SanitizationTransform())        // Strip artifacts
  .pipeThrough(new JsonToSseTransformStream());    // Wire format


**Key insight**: Each layer is a `TransformStream` — composable, testable, replaceable. This is the architecture we should adopt.

### Pattern C: Preto.ai's Post-200 Error Handling

go
// After sending HTTP 200, you can't send a new status code
// Inject errors as SSE events instead
if upstreamError != nil {
    errorEvent := map[string]interface{}{
        "error": map[string]interface{}{
            "message": upstreamError.Error(),
            "type":    "upstream_error",
            "code":    "upstream_failed",
        },
    }
    fmt.Fprintf(w, "data: %s\n\n", jsonMarshal(errorEvent))
    fmt.Fprintf(w, "data: [DONE]\n\n")
    flusher.Flush()
    return
}


### Sanitization Checklist

| What to Strip | How | Evidence |
|---------------|-----|----------|
| Tool call XML tags (``) | Regex on accumulated text | openclaw, nocobase |
| Tool call JSON in text content | Parser-level extraction (our current approach) | All major projects |
| Provider-specific artifacts | Per-provider `chunk_parser` | LiteLLM |
| Incomplete UTF-8 sequences | TextDecoder with `stream: true` | openai-node |
| Orphaned JSON fragments | Delta-level regex (our `stripStreamingDelta`) | Our fix |

---

## 5. Error Handling in Streams

### Pattern A: new-api's SoftError vs FatalError

go
type StreamResult int

const (
    StreamContinue StreamResult = iota
    StreamSoftError    // Log warning, continue stream
    StreamFatalError   // Inject error event, terminate
    StreamDone         // Normal completion
)

// In the scanner loop:
switch result {
case StreamSoftError:
    logger.Warn("Soft error in stream", "reason", reason)
    continue
case StreamFatalError:
    injectErrorEvent(w, err)
    return
case StreamDone:
    return
}


### Pattern B: Preto.ai's Error Envelope

go
// Standard OpenAI error envelope for mid-stream errors
type OpenAIErrorEnvelope struct {
    Error OpenAIError `json:"error"`
}

type OpenAIError struct {
    Message string `json:"message"`
    Type    string `json:"type"`    // "server_error", "upstream_error"
    Code    string `json:"code"`
}


### What Never Works

- **Returning HTTP 5xx after sending 200**: The client already received success. Inject an error SSE event instead.
- **Truncating the stream silently**: The client sees `[DONE]` and assumes success. Always send an error event before `[DONE]` if something went wrong.
- **Inline error text in content**: `"Sorry, an error occurred: ..."` in the content field. This pollutes the model output and confuses downstream consumers.

---

## 6. Backpressure and Flow Control

### The Problem

A slow mobile client can't consume chunks as fast as the upstream LLM produces them. Without backpressure:
- Proxy memory grows unbounded
- Eventually OOM under load
- One slow client can take down the server

### Pattern A: Vercel AI SDK — Native TransformStream Backpressure

`TransformStream` in the Web Streams API has built-in backpressure. When the consumer is slow, `controller.enqueue()` blocks the producer.

### Pattern B: Preto.ai — Bounded Queue with Drop Policy

go
type BoundedQueue struct {
    items    chan []byte
    capacity int
}

func NewBoundedQueue(capacity int) *BoundedQueue {
    return &BoundedQueue{
        items:    make(chan []byte, capacity),
        capacity: capacity,
    }
}

func (q *BoundedQueue) Enqueue(item []byte) bool {
    select {
    case q.items <- item:
        return true
    default:
        // Queue full — drop oldest
        <-q.items
        q.items <- item
        return false
    }
}


### Pattern C: LiteLLM — Timeout Enforcement

python
def _check_max_streaming_duration(self, start_time: float):
    max_duration = self.stream_options.get("max_duration", 300)  # 5 minutes default
    elapsed = time.time() - start_time
    if elapsed > max_duration:
        raise StreamTimeoutError(f"Stream exceeded {max_duration}s")


### What We Should Do

Our Hono streaming handler should:
1. `await streamWriter.write(event)` — explicit await provides backpressure
2. Monitor `streamWriter` abort signal for client disconnect
3. Implement a per-request timeout (5 min default)
4. Log slow clients for observability

---

## 7. Production Failure Modes

From Preto.ai's production experience (5,000+ streaming req/s):

### Failure Mode 1: Chunk Boundary Corruption

**Symptom**: Client receives garbled JSON — half of one event concatenated with half of another.

**Cause**: Reading upstream as raw bytes without line-boundary awareness.

**Fix**: Custom SSE split function that understands `\n\n` boundaries:
go
scanner.Split(splitSSEEvent)  // Not bufio.ScanLines
```

### Failure Mode 2: Token Leaks on Client Disconnect

**Symptom**: Proxy keeps consuming upstream tokens after client disconnects. You pay for tokens nobody received.

**Cause**: Not checking for client disconnect in the streaming loop.

**Fix**: Check connection state on every chunk:
go
for scanner.Scan() {
    if c.Request.Context().Err() != nil {
        upstream.Body.Close()  // Stop consuming upstream
        return
    }
    // ...
}
```

### Failure Mode 3: Unbounded Buffering Under Backpressure

**Symptom**: Proxy memory climbs linearly with slow clients. Eventually OOM.

**Cause**: Storing all chunks in memory before forwarding.

**Fix**: Bounded queue with drop policy, or native TransformStream backpressure.

### Failure Mode 4: Mid-Stream Errors After 200

**Symptom**: Upstream returns 429/503 after you've sent HTTP 200. Client sees truncated stream with no explanation.

**Cause**: Status code already sent.

**Fix**: Inject error as SSE event:
go
if upstreamRateLimited {
    errorPayload := `{"error":{"message":"upstream rate limited","type":"upstream_error"}}`
    fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", errorPayload)
    return
}
```

---

## 8. Universal Principles Checklist

Before shipping any streaming change, verify:

- [ ] **Never forward raw upstream bytes** — always parse → transform → re-serialize
- [ ] **JSON.parse is the gate** — unparseable chunks dropped with warning log
- [ ] **Buffer at line boundaries** — never split SSE events mid-line
- [ ] **Tool calls accumulate by index** — fragments never reach the client
- [ ] **Filter deltas before emission** — not just accumulated text
- [ ] **`[DONE]` is prefix-matched** — `data.startsWith('[DONE]')` not `===`
- [ ] **Flush on every event** — `await streamWriter.write()` in Hono
- [ ] **Handle client disconnect** — check abort signal, close upstream
- [ ] **Inject errors as SSE events** — after 200 is sent, can't change status
- [ ] **Bounded buffering** — prevent OOM from slow clients
- [ ] **Timeout enforcement** — kill streams that run too long
- [ ] **UTF-8 safety** — use `TextDecoder` with `stream: true` flag
- [ ] **Heartbeat for long streams** — `: heartbeat\n\n` comment events every 15s

---

## 9. References

### Projects Analyzed

| Project | Stars | Language | Key Pattern |
|---------|-------|----------|-------------|
| [LiteLLM](https://github.com/BerriAI/litellm) | 20k+ | Python | Provider-agnostic ModelResponseIterator |
| [one-api](https://github.com/songquanpeng/one-api) | 10k+ | Go | Decentralized per-adaptor relay |
| [new-api](https://github.com/Calcium-Ion/new-api) | 5k+ | Go | Centralized scanner with StreamResult |
| [openai-node](https://github.com/openai/openai-node) | 7k+ | TypeScript | LineDecoder + Stream class |
| [Vercel AI SDK](https://github.com/vercel/ai) | 15k+ | TypeScript | TransformStream pipeline |
| [open-webui](https://github.com/open-webui/open-webui) | 30k+ | Python/TS | SSE proxy with content filtering |
| [fastchat](https://github.com/lm-sys/FastChat) | 35k+ | Python | OpenAI-compatible API server |
| [eventsource-parser](https://github.com/rexxars/eventsource-parser) | 1k+ | TypeScript | String-level SSE parsing |
| [@microsoft/fetch-event-source](https://github.com/Azure/fetch-event-source) | 2k+ | TypeScript | Byte-level SSE parsing |
| [NextChat](https://github.com/ChatGPTNextWeb/NextChat) | 80k+ | TypeScript | Tool call index accumulation |
| [Continue.dev](https://github.com/continuedev/continue) | 20k+ | TypeScript | Multi-provider adapters |

### Production Case Studies

- [Preto.ai — Streaming SSE Proxying for LLM APIs: The Hard Parts](https://preto.ai/blog/streaming-sse-proxy/) (April 2026)
- [MCP Best Practices for AI Agents](https://www.manatee-labs.com/blog/mcp-best-practices-ai-agents/) (2026)

### Code Pattern Sources (grep_app)

Real-world code patterns extracted from:
- excalidraw/excalidraw — `parseSSEStream` with rate limit extraction
- browseros-ai/BrowserOS — `parseSSELines` with remainder buffering
- ChatGPTNextWeb/NextChat — Tool call accumulation by index
- continuedev/continue — `interceptSystemToolCalls` for markdown tool calls
- openclaw/openclaw — `stripToolCallXmlTags` sanitization
- assistant-ui/assistant-ui — `LineDecoderStream` implementation
- CommandCodeAI/BaseAI — LineDecoder with flush()

---

## Appendix A: What We Should Change in qwen-gate

Based on this research, here are the specific architectural changes to prioritize:

### P0: Consume Structured tool_calls Deltas

**Current**: Parse JSON from text content (`src/tools/parser.ts`)
**Target**: If Qwen provides `delta.tool_calls[]`, consume directly using NextChat's index-based accumulation pattern

### P1: Adopt TransformStream Pipeline

**Current**: Single monolithic streaming handler in `chat.ts`
**Target**: Composable TransformStream layers (normalize → accumulate tools → sanitize → SSE encode)

### P1: Add Bounded Buffering

**Current**: No explicit backpressure handling
**Target**: Use Hono's `streamWriter.write()` with explicit await + per-request timeout

### P2: Centralize Scanner Logic

**Current**: SSE parsing in `qwen.ts`, tool extraction in `parser.ts`, content filter in `contentFilter.ts` — disconnected
**Target**: Single `StreamProcessor` class with clear pipeline stages (like new-api's centralized scanner)

### P2: Add Streaming Telemetry

**Current**: Limited observability into streaming behavior
**Target**: Track `StreamStatus`, `StreamEndReason`, chunk counts, filter hits, error injection counts

---

## Appendix B: Quick Reference — Tool Call Delta Format

The OpenAI-compatible tool call streaming format:


// First chunk for a tool call
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "search_web",
          "arguments": "{\"q"
        }
      }]
    }
  }]
}

// Subsequent chunks — only index and arguments fragment
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "function": {
          "arguments": "uery\": \"test\"}"
        }
      }]
    }
  }]
}

// Final chunk
{
  "choices": [{
    "delta": {},
    "finish_reason": "tool_calls"
  }]
}


**Accumulation algorithm**:
1. If delta has `id` → create new entry at `toolCalls[index]`
2. If delta has only `arguments` → append to `toolCalls[index].function.arguments`
3. On `finish_reason: "tool_calls"` → parse all accumulated arguments as JSON
4. Emit complete tool calls to client (or execute them if we're the orchestrator)
