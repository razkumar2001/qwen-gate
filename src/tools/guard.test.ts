import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateToolCalls, validateSingleToolCall } from './guard.ts';
import type { ParsedToolCall } from './types.ts';

describe('validateToolCalls', () => {
  it('should accept valid tool calls', () => {
    const toolCall: ParsedToolCall = { id: 'test1', name: 'search', arguments: { query: 'hello' } };
    const result = validateToolCalls([toolCall]);
    assert.ok(result.ok, 'Valid tool call should pass');
    assert.strictEqual(result.valid.length, 1);
  });

  it('should reject tool call with missing name', () => {
    const toolCall: ParsedToolCall = { id: 'test2', name: '', arguments: {} };
    const result = validateToolCalls([toolCall]);
    assert.ok(!result.ok, 'Empty name should fail');
    assert.ok(result.errors.some(e => e.includes('name')));
  });

  it('should reject tool call with missing arguments', () => {
    const toolCall: ParsedToolCall = { id: 'test3', name: 'search', arguments: undefined as any };
    const result = validateToolCalls([toolCall]);
    assert.ok(!result.ok, 'Missing arguments should fail');
    assert.ok(result.errors.some(e => e.includes('arguments')));
  });

  it('should handle empty array', () => {
    const result = validateToolCalls([]);
    assert.ok(result.ok, 'Empty array should pass');
    assert.strictEqual(result.valid.length, 0);
  });

  it('should reject non-array input', () => {
    const result = validateToolCalls(null as any);
    assert.ok(!result.ok, 'Non-array should fail');
    assert.ok(result.errors.some(e => e.includes('array')));
  });
});

describe('validateSingleToolCall', () => {
  it('should accept valid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'single', name: 'test', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(result.ok);
  });

  it('should reject invalid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'bad', name: '', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(!result.ok);
  });
});

// buildCorrectionPrompt is internal, tested indirectly via validateToolCalls