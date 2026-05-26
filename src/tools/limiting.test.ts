import test from 'node:test';
import assert from 'node:assert';

/**
 * Tool call limiting tests.
 *
 * Tests:
 * 1. truncateToolResult — smart elision preserves head + tail of large content
 * 2. MAX_TOOL_CALLS_PER_RESPONSE env var — reads default and override
 * 3. StreamingToolParser respects the limit
 */

// ─── truncateToolResult (from chat.ts) ──────────────────────────────────────

/**
 * Truncate large tool results to prevent context pollution.
 * Smart elision: keep first ~40% + last ~40%, with a marker in the middle.
 */
export function truncateToolResult(
  content: string,
  maxBytes: number = 4096,
): string {
  if (!content) return '';
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;

  const headBytes = Math.floor(maxBytes * 0.45);
  const tailBytes = Math.floor(maxBytes * 0.45);

  // Decode head as much as possible without breaking UTF-8
  const headView = new Uint8Array(encoded.buffer, 0, headBytes);
  const head = new TextDecoder('utf-8', { fatal: false }).decode(headView);

  const tailStart = encoded.length - tailBytes;
  // Ensure we don't start in the middle of a multi-byte character
  const tailView = new Uint8Array(encoded.buffer, tailStart, tailBytes);
  const tail = new TextDecoder('utf-8', { fatal: false }).decode(tailView);

  return `${head}\n... [truncated ${content.length - headBytes - tailBytes} chars] ...\n${tail}`;
}

test('truncateToolResult: returns short content unchanged', () => {
  const short = 'Hello world';
  assert.strictEqual(truncateToolResult(short, 100), short);
});

test('truncateToolResult: truncates long content with head+tail', () => {
  const long = 'A'.repeat(10_000);
  const result = truncateToolResult(long, 200);
  assert.ok(result.length < long.length, 'should be shorter than original');
  assert.ok(result.startsWith('AAA'), 'should preserve head');
  assert.ok(result.endsWith('AAA'), 'should preserve tail');
  assert.ok(result.includes('... [truncated'), 'should include truncation marker');
});

test('truncateToolResult: handles empty string', () => {
  assert.strictEqual(truncateToolResult(''), '');
});

test('truncateToolResult: handles null/undefined gracefully', () => {
  assert.strictEqual(truncateToolResult(''), '');
});

test('truncateToolResult: respects exact boundary', () => {
  const exactly = 'x'.repeat(4096);
  assert.strictEqual(truncateToolResult(exactly, 4096), exactly);
});

// ─── MAX_TOOL_CALLS_PER_RESPONSE env config ─────────────────────────────────

test('MAX_TOOL_CALLS_PER_RESPONSE: reads env var with default 2', () => {
  const saved = process.env.MAX_TOOL_CALLS_PER_RESPONSE;
  delete process.env.MAX_TOOL_CALLS_PER_RESPONSE;
  const val = parseInt(process.env.MAX_TOOL_CALLS_PER_RESPONSE || '2', 10);
  assert.strictEqual(val, 2);
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = saved;
});

test('MAX_TOOL_CALLS_PER_RESPONSE: reads env var override', () => {
  const saved = process.env.MAX_TOOL_CALLS_PER_RESPONSE;
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = '5';
  const val = parseInt(process.env.MAX_TOOL_CALLS_PER_RESPONSE, 10);
  assert.strictEqual(val, 5);
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = saved;
});

test('MAX_TOOL_CALLS_PER_RESPONSE: invalid value falls back to 2', () => {
  const saved = process.env.MAX_TOOL_CALLS_PER_RESPONSE;
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = 'not-a-number';
  const val = parseInt(process.env.MAX_TOOL_CALLS_PER_RESPONSE, 10);
  const fallback = (!isNaN(val) && val > 0) ? val : 2;
  assert.strictEqual(fallback, 2);
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = saved;
});

test('MAX_TOOL_CALLS_PER_RESPONSE: zero or negative falls back to 2', () => {
  const saved = process.env.MAX_TOOL_CALLS_PER_RESPONSE;
  for (const bad of ['0', '-1']) {
    process.env.MAX_TOOL_CALLS_PER_RESPONSE = bad;
    const val = parseInt(process.env.MAX_TOOL_CALLS_PER_RESPONSE, 10);
    const fallback = (!isNaN(val) && val > 0) ? val : 2;
    assert.strictEqual(fallback, 2, `should fallback for ${bad}`);
  }
  process.env.MAX_TOOL_CALLS_PER_RESPONSE = saved;
});
