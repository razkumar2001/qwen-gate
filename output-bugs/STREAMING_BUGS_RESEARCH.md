# Streaming Bugs Research: Root Cause Analysis & Production Fix Patterns

> **Date**: 2026-05-30
> **Scope**: SSE streaming pipeline in qwen-gate — tool call JSON fragments leaking into content output
> **Status**: Research complete, fixes not yet implemented

---

## Table of Contents

1. [Bug Report](#bug-report)
2. [Architecture Overview](#architecture-overview)
3. [Root Cause Analysis](#root-cause-analysis)
4. [How Production Projects Fix This](#how-production-projects-fix-this)
5. [Recommended Fixes](#recommended-fixes)
6. [Testing Strategy](#testing-strategy)
7. [References](#references)

---

## Bug Report

### Observed Symptoms

From `output-bugs/01.md`, the following fragments leaked into the SSE content stream sent to clients:


": "glob", "arguments": }
","arguments":}
","arguments":}
","arguments":}
","arguments":}
","arguments":}
","arguments":}","arguments":}
search_web_search_exa","arguments":}
search_web_search_exa","arguments":}
search_web_search_exa","arguments":}
read", "arguments": }
Tool Response (bash


### Classification

**Type**: Tool call metadata bleeding into content deltas
**Severity**: HIGH — clients receive corrupted output containing internal execution artifacts
**Reproducibility**: Occurs when upstream Qwen model uses tools during streaming responses
**Affected path**: `src/routes/chat.ts` streaming handler → SSE output to client

---

## Architecture Overview

### Streaming Pipeline Flow

```
Qwen upstream SSE
  → src/services/qwen.ts: createQwenStream() — fetches + returns ReadableStream<Uint8Array>
  → src/routes/chat.ts: streaming handler reads chunks via ReadableStreamDefaultReader
  → detectCumulativeChunk() — dedup cumulative vs delta chunks (chat.ts:1097-1114)
  → StreamingToolParser.feed() — separates text vs tool_calls vs thinking (parser.ts:45)
  → StreamingContentFilter.feed() — strips think tags, separates reasoning (chat.ts:1155)
  → stripToolCallArtifacts() — safety-net regex pass (contentFilter.ts:155)
  → getSnapshotDelta() — compute what's new vs last emitted (chat.ts:1205)
  → writeEvent() → SSE data frame to client (chat.ts:1231)


### Key Files

| File | Lines | Role |
|------|-------|------|
| `src/routes/chat.ts` | 1547 | Main streaming handler, SSE emission, snapshot diffing |
| `src/tools/parser.ts` | 459 | `StreamingToolParser` — JSON tool call extraction from text stream |
| `src/routes/pipeline/StreamingContentFilter.ts` | 143 | Stateful content filter, O(n) delta via high-water mark |
| `src/utils/contentFilter.ts` | 480 | `filterContent()`, `stripToolCallArtifacts()`, `stripToolEcho()` |
| `src/services/qwen.ts` | ~400 | Upstream stream creation, fetch + SSE parsing |
| `src/tools/guard.ts` | — | `validateSingleToolCall()` — schema validation before emission |

---

## Root Cause Analysis

### LEAK VECTOR 1 (PRIMARY): Parser Interior Fragment Pass-Through

**Location**: `src/tools/parser.ts:85-86, 112-127, 441`

The `StreamingToolParser` only detects JSON starting with `{"` or `[{`. When Qwen sends chunks where JSON splits across TCP/chunk boundaries, interior fragments are not recognized as JSON and fall through to text emission.

**How it happens:**

```
Chunk 1: {"name": "search_web_search_exa"
Chunk 2: ,"arguments": {"query": "test"}}


- Chunk 1 arrives: parser sees `{"name"` → starts buffering, waits for complete JSON
- Chunk 2 arrives: `,"arguments": {"query": "test"}}` — the parser's `extract()` looks for `{"` at offset 0 of remaining buffer
- The `,"arguments"` prefix is NOT a JSON start → it's treated as plain text
- At `parser.ts:441`: `result.text += remaining.substring(0, braceIdx + jsonEnd)` — emits `"arguments":}` as content text

**Why `looksLikeToolCall()` doesn't help:**

typescript
// parser.ts:242-248
private looksLikeToolCall(jsonStr: string): boolean {
  return jsonStr.includes('"name"') && (
    jsonStr.includes('"arguments"') ||
    jsonStr.includes('"function"') ||
    jsonStr.includes('"parameters"')
  );
}


This check only runs on JSON that was successfully delimited by `{` and `}`. Interior fragments like `"arguments":}` never reach this check because they don't start with `{`.

**Why `flush()` makes it worse:**

typescript
// parser.ts:441 (inside flush/extractToolCalls)
// Not a tool call — skip past this JSON
result.text += remaining.substring(0, braceIdx + jsonEnd);


On `flush()`, any remaining buffer that isn't recognized as a tool call gets emitted as text. This is the final leak point — partial JSON that was buffered but never completed gets flushed as content.

### LEAK VECTOR 2: StreamingContentFilter Snapshot Delta Re-emission

**Location**: `src/routes/pipeline/StreamingContentFilter.ts:127-142`

The `getSnapshotDelta()` method uses common PREFIX matching:

typescript
let i = 0;
const len = Math.min(current.length, previous.length);
while (i < len && current[i] === previous[i]) i++;
return current.substring(i);
```

**Problem**: When `stripToolCallArtifacts()` reclassifies earlier content (e.g., removes a tool call JSON from the middle of accumulated text), the prefix changes. The delta calculation then emits content that was already sent in a previous chunk, potentially including tool call fragments that appeared mid-stream.

**Example scenario:**
1. Chunk N: accumulated text = `"Hello {\"name\": \"read\", \"arguments\": {}}" world"`
2. After filtering: `"Hello  world"` (JSON stripped)
3. Chunk N+1: accumulated text = `"Hello {\"name\": \"read\", \"arguments\": {}} world, more text"`
4. After filtering: `"Hello  world, more text"`
5. Prefix comparison: both start with `"Hello  world"` → delta = `", more text"` ✓

But if filtering changes the prefix (e.g., a think tag at the start gets reclassified):
1. Previous filtered: `"Thinking... Answer here"`
2. Current filtered: `"Answer here"` (thinking removed)
3. Prefix match fails → delta = entire `"Answer here"` → **re-emits already-sent content**

### LEAK VECTOR 3: detectCumulativeChunk Suffix Fallback

**Location**: `src/routes/chat.ts:107-127`

The 70% suffix match threshold can incorrectly identify chunks as cumulative:

typescript
// chat.ts:120
if (suffixMatch >= Math.min(lastText.length * 0.7, lastText.length - 8)) {
  const delta = newText.substring(expectedEnd);
  return { cumulative: true, delta };
}
```

When this fires incorrectly:
- Wrong delta extraction from the chunk
- Re-emission of already-sent content
- Tool call fragments appearing in wrong positions in the output

### Why `stripToolCallArtifacts()` Fails as Safety Net

**Location**: `src/utils/contentFilter.ts:155-294`

The function uses regex patterns that only match **complete** JSON structures:

typescript
// contentFilter.ts:164
const toolCallStart = remaining.search(/\{\s*"(?:name|function)"\s*:/);


**What it catches:**
- `{"name":"read_file","arguments":{"path":"src/main.ts"}}`
- `[{"name":"bash","arguments":{}}]`
- `<tool_call>...</tool_call>` XML wrappers

**What it misses:**
- `"arguments":}` — no opening `{`, not a complete JSON
- `search_web_search_exa` — bare tool name, no JSON structure
- `","arguments":}` — concatenated fragment
- `read", "arguments": }` — partial JSON interior
- `Tool Response (bash` — tool execution echo prefix

These fragments are structurally invisible to regex-based JSON detection because they lack the `{` anchor that the patterns depend on.

---

## How Production Projects Fix This

### 1. eventsource-parser (used by Vercel AI SDK, LangChain.js)

**Pattern**: Line-based state machine that NEVER emits partial events.

typescript
// Simplified from eventsource-parser source
function createParser(onEvent: (event: SSEEvent) => void) {
  let buffer = '';
  let eventType = '';
  let data = '';

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line === '') {
          // Empty line = event boundary
          if (data) {
            onEvent({ event: eventType, data: data.slice(0, -1) }); // Remove trailing \n
            data = '';
            eventType = '';
          }
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trimStart() + '\n';
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trimStart();
        }
        // Ignore 'id:', 'retry:', comments
      }
    }
  };
}
```

**Key principle**: Buffer incomplete lines. Only process after `\n\n` delimiter. Never emit partial data.

### 2. OpenAI Official Node SDK (`openai-node`)

**Pattern**: `Stream.fromSSEResponse()` — accumulates deltas in array, joins on flush. Never emits until `JSON.parse()` succeeds.

typescript
// From openai-node src/core/streaming.ts
class Stream<T> implements AsyncIterable<T> {
  private controller: AbortController;

  static fromSSEResponse<T>(response: Response, controller: AbortController): Stream<T> {
    let consumed = false;
    const decoder = new LineDecoder(); // Buffers UTF-8 continuation bytes

    async function* iterMessages(): AsyncGenerator<SSEEvent> {
      if (!response.body) throw new Error('No response body');

      for await (const chunk of response.body as any) {
        for (const line of decoder.decode(chunk)) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            yield { event: 'message', data: JSON.parse(data) }; // Only emit after successful parse
          }
        }
      }
    }

    return new Stream(iterMessages(), controller);
  }
}

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
}


**Key principles:**
- `JSON.parse()` is the gate — if parse fails, nothing is emitted
- `LineDecoder` handles UTF-8 multi-byte character splitting across TCP chunks
- `[DONE]` checked with `startsWith`, not exact equality
- Tool call arguments accumulated incrementally in a snapshot, emitted only when complete

### 3. LiteLLM (Python proxy, 20k+ GitHub stars)

**Pattern**: `async_stream_iter()` — reads one complete SSE event at a time, re-serializes before forwarding.

python
# Simplified from litellm/utils.py
class CustomStreamWrapper:
    async def async_stream_iter(self):
        buffer = ""
        async for chunk in self.completion_stream:
            buffer += chunk
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)
                # Parse complete event
                for line in event_str.split("\n"):
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            yield "data: [DONE]\n\n"
                            return
                        try:
                            parsed = json.loads(data)
                            # Re-serialize with our own transformations
                            filtered = self.apply_filters(parsed)
                            yield f"data: {json.dumps(filtered)}\n\n"
                        except json.JSONDecodeError:
                            # NEVER forward unparseable data
                            logger.warning(f"Dropping unparseable SSE: {data[:100]}")
```

**Key principles:**
- Never forward raw upstream bytes — always parse → transform → re-serialize
- `JSONDecodeError` = drop the chunk, log warning, never forward
- Error injection as proper SSE events with `event: error` prefix

### 4. one-api / new-api (OpenAI proxy, 10k+ stars)

**Pattern**: `RelayStreamFilter` — processes complete events only, accumulates tool calls in snapshot.

go
// Simplified from one-api relay/relay_stream.go
type RelayStreamFilter struct {
    buf          bytes.Buffer
    toolCalls    map[int]*ToolCall // Accumulated by index
    contentBuf   strings.Builder
}

func (f *RelayStreamFilter) ProcessChunk(data []byte) ([]byte, error) {
    var chunk ChatCompletionsChunk
    if err := json.Unmarshal(data, &chunk); err != nil {
        return nil, fmt.Errorf("drop unparseable chunk: %w", err)
    }

    for _, choice := range chunk.Choices {
        delta := choice.Delta

        // Accumulate tool calls by index, don't emit fragments
        if delta.ToolCalls != nil {
            for _, tc := range delta.ToolCalls {
                existing := f.toolCalls[tc.Index]
                if existing == nil {
                    f.toolCalls[tc.Index] = &ToolCall{
                        ID:   tc.ID,
                        Type: "function",
                        Function: FunctionCall{
                            Name:      tc.Function.Name,
                            Arguments: tc.Function.Arguments,
                        },
                    }
                } else {
                    // Append argument fragment to accumulator
                    existing.Function.Arguments += tc.Function.Arguments
                }
            }
        }

        // Content goes through accumulated buffer
        if delta.Content != "" {
            f.contentBuf.WriteString(delta.Content)
        }
    }

    // Re-serialize with accumulated state
    return json.Marshal(f.buildResponseChunk()), nil
}


**Key principles:**
- Tool calls accumulated in a map by index — fragments never reach the client
- Content accumulated in a string builder — only emitted after full event processing
- Unparseable chunks are dropped with error log, never forwarded

### 5. Hono Streaming Gotchas

**Known issues with `hono/streaming`:**

typescript
// WRONG — callback returns before stream is fully written
return honoStream(c, async (streamWriter) => {
  streamWriter.write('data: hello\n\n');
  // BUG: returning here may close response before write completes
});

// CORRECT — await all writes, callback returns AFTER stream is done
return honoStream(c, async (streamWriter) => {
  await streamWriter.write('data: hello\n\n');
  await streamWriter.write('data: [DONE]\n\n');
  // Return only after all writes are awaited
});


**Critical rules:**
- `streamWriter.write()` is async — always `await` it
- Callback must return ONLY after all data is flushed
- Never add cleanup logic after callback return — use `finally` block or `setTimeout`
- Hono may close the response when the callback resolves — any pending writes are lost

---

## Recommended Fixes

### Fix 1: Parser — Drop Interior Fragments Instead of Emitting as Text (PRIMARY)

**File**: `src/tools/parser.ts:441` and `parser.ts:162`

**Current (buggy):**
typescript
// L441 in extractToolCalls
// Not a tool call — skip past this JSON
result.text += remaining.substring(0, braceIdx + jsonEnd); // EMITS JSON AS TEXT
remaining = remaining.substring(braceIdx + jsonEnd);
```

**Fix:**
typescript
// When JSON doesn't look like a tool call, DROP it entirely
// Don't emit as text — it's likely a fragment or internal artifact
// Only emit text BEFORE the JSON, not the JSON itself
result.text += remaining.substring(0, braceIdx);
remaining = remaining.substring(braceIdx + jsonEnd);
```

**Also in `flush()`** at `parser.ts:449-451`:
typescript
// Before reset, check for remaining buffered content
// If buffer contains partial JSON fragments, drop them
if (this.buffer.trim()) {
  // Only emit if it's clearly plain text (no JSON-like characters)
  const cleaned = this.buffer.replace(/\{[^}]*$|^[^\{]*\}/g, '');
  if (cleaned.trim()) {
    result.text += cleaned;
  }
}


### Fix 2: Add Fragment Detection to stripToolCallArtifacts

**File**: `src/utils/contentFilter.ts` — add new pass to `stripToolCallArtifacts()`

typescript
// Add as Pass 3.5 — before dangling bracket cleanup

// ── Pass 3.5: Strip tool call interior fragments ──
// These appear when JSON splits across chunk boundaries:
//   "arguments":}
//   tool_name","arguments":
//   read", "arguments": }
const FRAGMENT_PATTERNS = [
  /"arguments"\s*:\s*\}/g,                    // "arguments":}
  /"arguments"\s*:\s*\{/g,                    // "arguments":{
  /"(?:name|function|parameters)"\s*:\s*"[^"]*",\s*"arguments"/g, // name","arguments
  /\},\s*"arguments"/g,                        // },"arguments
  /"[a-z_]+",\s*"arguments"\s*:\s*\}/g,      // tool_name","arguments":}
];
for (const pattern of FRAGMENT_PATTERNS) {
  text = text.replace(pattern, '');
}

// Strip bare tool name fragments that appear before ","arguments"
// e.g., "search_web_search_exa","arguments":}
text = text.replace(/"[a-z_]+(?:\.[a-z_]+)*"(?=\s*,\s*"arguments")/g, '');

// Strip "Tool Response (toolname" fragments
text = text.replace(/Tool Response \([a-z_]+$/gm, '');


### Fix 3: Filter Deltas Before Emission (Architectural)

**File**: `src/routes/chat.ts:1200-1238`

**Current flow**: accumulate → filter full text → snapshot diff → emit delta
**Fixed flow**: accumulate → filter full text → snapshot diff → **filter delta** → emit

typescript
// At chat.ts:1205, after computing contentDelta:
const contentDelta = getSnapshotDelta(cleanedText, lastFilteredSnapshot);
lastFilteredSnapshot = cleanedText;

// NEW: Apply fragment stripping to the delta BEFORE emission
const safeDelta = stripToolCallFragmentDelta(contentDelta);

if (safeDelta) {
  // ... existing amplification guard ...
  await writeEvent({
    // ...
    choices: [makeChoice({ content: safeDelta })]
  });
}


typescript
// New utility function
function stripToolCallFragmentDelta(delta: string): string {
  if (!delta) return '';

  // Strip tool call interior fragments from delta
  let cleaned = delta;
  cleaned = cleaned.replace(/"arguments"\s*:\s*\}/g, '');
  cleaned = cleaned.replace(/"[a-z_]+",\s*"arguments"\s*:\s*\}/g, '');
  cleaned = cleaned.replace(/Tool Response \([a-z_]+/g, '');

  // Strip any remaining JSON-like artifacts
  cleaned = cleaned.replace(/\{\s*"(?:name|function)"\s*:[^}]*\}/g, '');

  return cleaned.trim();
}


### Fix 4: Robust SSE Framing (Upstream Parsing)

**File**: `src/services/qwen.ts`

Adopt the `eventsource-parser` pattern for upstream SSE parsing:

typescript
function parseSSEStream(body: ReadableStream<Uint8Array>): ReadableStream<any> {
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop()!; // Keep incomplete event in buffer

          for (const event of events) {
            const lines = event.split('\n');
            let data = '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                data += line.slice(6);
              }
            }
            if (!data || data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              controller.enqueue(parsed);
            } catch {
              // Drop unparseable events — never forward garbage
              console.warn(`[SSE] Dropping unparseable event: ${data.substring(0, 100)}`);
            }
          }
        }
      } finally {
        controller.close();
      }
    }
  });
}


### Fix 5: Snapshot Delta — Use Suffix-Aware Comparison

**File**: `src/routes/pipeline/StreamingContentFilter.ts:127-142`

Replace simple prefix matching with suffix-aware delta:

typescript
private getSnapshotDelta(current: string, previous: string): string {
  if (!current) return '';
  if (!previous) return current;
  if (current === previous) return '';

  // Try prefix first (fast path)
  if (current.startsWith(previous)) {
    return current.substring(previous.length);
  }

  // If prefix changed (filter reclassified earlier content),
  // use SUFFIX matching to find what's genuinely new at the end
  let suffixLen = 0;
  const maxSuffix = Math.min(current.length, previous.length);
  while (
    suffixLen < maxSuffix &&
    current[current.length - 1 - suffixLen] === previous[previous.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // The delta is everything before the common suffix in current
  if (suffixLen > 0) {
    return current.substring(0, current.length - suffixLen);
  }

  // No common prefix or suffix — treat entire current as new
  // (this shouldn't happen in normal streaming)
  return current;
}


---

## Testing Strategy

### Test Cases to Add

#### 1. Parser Interior Fragment Test

typescript
test('StreamingToolParser: drops interior JSON fragments across chunk boundaries', () => {
  const parser = new StreamingToolParser();

  // Simulate chunk boundary splitting a tool call JSON
  const r1 = parser.feed('{"name": "search_web_search_exa"');
  const r2 = parser.feed(',"arguments": {"query": "test"}}');

  // Tool call should be extracted
  assert.equal(r2.toolCalls.length, 1);
  assert.equal(r2.toolCalls[0].name, 'search_web_search_exa');

  // NO fragment should appear in text
  assert.ok(!r1.text.includes('"arguments"'), `Text should not contain "arguments": "${r1.text}"`);
  assert.ok(!r2.text.includes('"arguments"'), `Text should not contain "arguments": "${r2.text}"`);
});


#### 2. Safety Net Fragment Test

typescript
test('stripToolCallArtifacts: removes interior JSON fragments', () => {
  const input = 'Hello world\n","arguments":}\nMore text here';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"arguments"'), `Should strip fragment: "${result}"`);
  assert.ok(result.includes('Hello world'));
  assert.ok(result.includes('More text here'));
});

test('stripToolCallArtifacts: removes tool name + arguments fragment', () => {
  const input = 'search_web_search_exa","arguments":}';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('search_web_search_exa'), `Should strip tool name fragment: "${result}"`);
  assert.ok(!result.includes('"arguments"'), `Should strip arguments fragment: "${result}"`);
});

test('stripToolCallArtifacts: removes "Tool Response (bash" fragment', () => {
  const input = 'Some content\nTool Response (bash\nMore content';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('Tool Response (bash'), `Should strip echo: "${result}"`);
});
```

#### 3. Snapshot Delta Regression Test

typescript
test('StreamingContentFilter: no re-emission when prefix changes', () => {
  const filter = new StreamingContentFilter();

  // Feed text that includes a think tag
  filter.feed('I am thinking about this.\nThe answer is 42.');
  const r1 = filter.feed('I am thinking about this.\nThe answer is 42.');

  // Second feed with same content should produce empty delta
  assert.equal(r1.cleanDelta, '', 'Same content should produce empty delta');
});
```

#### 4. Integration Test: Full Streaming Pipeline

typescript
test('streaming: tool call chunks never leak into content output', async () => {
  // Mock Qwen response with tool calls that split across chunks
  const mockChunks = [
    'data: {"choices":[{"delta":{"content":"Let me search"}}]}',
    'data: {"choices":[{"delta":{"content":"\\n{\\"name\\": \\"search"}}]}',
    'data: {"choices":[{"delta":{"content":"_web_search_exa\\",\\"arguments\\":"}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"query\\": \\"test\\"}}"}}]}',
    'data: {"choices":[{"delta":{"content":"\\nThe results show..."}}]}',
    'data: [DONE]',
  ];

  const contentChunks = await simulateStreaming(mockChunks);
  const allContent = contentChunks.join('');

  // Verify no tool call artifacts in output
  assert.ok(!allContent.includes('"arguments"'), `Content leaked tool args: "${allContent}"`);
  assert.ok(!allContent.includes('search_web_search_exa'), `Content leaked tool name: "${allContent}"`);
  assert.ok(!allContent.includes('{"name"'), `Content leaked JSON: "${allContent}"`);

  // Verify actual content preserved
  assert.ok(allContent.includes('Let me search'));
  assert.ok(allContent.includes('The results show'));
});


---

## References

### Production Projects Studied

| Project | Stars | Key Pattern | URL |
|---------|-------|-------------|-----|
| eventsource-parser | 1k+ | Line-based state machine, buffer incomplete lines | github.com/rexxars/eventsource-parser |
| openai-node (official) | 7k+ | LineDecoder, JSON.parse gate, delta accumulation | github.com/openai/openai-node |
| LiteLLM | 20k+ | async_stream_iter, parse→transform→re-serialize | github.com/BerriAI/litellm |
| one-api | 10k+ | RelayStreamFilter, tool call index accumulation | github.com/songquanpeng/one-api |
| new-api | 5k+ | Fork of one-api with enhanced streaming | github.com/Calcium-Ion/new-api |
| Vercel AI SDK | 15k+ | Uses eventsource-parser, delta-only emission | github.com/vercel/ai |

### Key Principles (Universal Across All Projects)

1. **Never emit before parsing**: Raw bytes → parse complete event → transform → emit
2. **JSON.parse is the gate**: If parse fails, drop the chunk — never forward garbage
3. **Buffer incomplete data**: Partial lines, partial JSON, partial UTF-8 — all buffered until complete
4. **Accumulate tool calls**: Tool call argument fragments stay in a snapshot, emitted only when complete
5. **Filter deltas, not just accumulated text**: Apply safety-net filters to the delta BEFORE emission
6. **`[DONE]` is prefix-matched**: `data.startsWith('[DONE]')` not `data === '[DONE]'`

### Anti-Pattern: "Emit Then Filter"

Our current architecture follows this anti-pattern:


Raw chunk → emit as content delta → filter accumulated text → snapshot diff → emit again


The correct pattern is:

```
Raw chunk → accumulate in buffer → parse complete event → filter → emit validated delta


The key difference: **nothing reaches the client until it has been fully parsed and filtered**.

---

## Implementation Priority

| Fix | Effort | Impact | Priority |
|-----|--------|--------|----------|
| Fix 1: Parser drop fragments | Small | HIGH — eliminates primary leak | **P0** |
| Fix 2: Fragment patterns in safety net | Small | HIGH — catches edge cases | **P0** |
| Fix 3: Filter deltas before emission | Medium | HIGH — architectural safety | **P1** |
| Fix 4: Robust SSE framing upstream | Medium | MEDIUM — prevents upstream garbage | **P1** |
| Fix 5: Suffix-aware snapshot delta | Medium | LOW — reduces re-emission risk | **P2** |

**Recommended order**: Fix 1 → Fix 2 → Test → Fix 3 → Fix 4 → Fix 5
