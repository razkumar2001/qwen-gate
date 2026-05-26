import type { ParsedToolCall } from './types.ts';

export interface GuardResult {
  valid: ParsedToolCall[];
  errors: string[];
  correctionPrompt: string;
  ok: boolean;
}

export interface ProviderToolLeakResult {
  detected: boolean;
  reason?: string;
  type?: string;
}

function validateSingleTC(tc: ParsedToolCall): string[] {
  const errors: string[] = [];
  if (!tc.name || typeof tc.name !== 'string' || tc.name.trim() === '') {
    errors.push('Tool call missing or has invalid "name" field.');
  }
  if (tc.arguments === undefined || tc.arguments === null) {
    errors.push(`Tool call "${tc.name}" missing "arguments" field.`);
  } else if (typeof tc.arguments !== 'object') {
    errors.push(`Tool call "${tc.name}" has non-object arguments.`);
  }
  return errors;
}

export function validateToolCalls(toolCalls: ParsedToolCall[]): GuardResult {
  const errors: string[] = [];
  const valid: ParsedToolCall[] = [];

  if (!Array.isArray(toolCalls)) {
    errors.push('Tool calls must be an array.');
    return { valid: [], errors, correctionPrompt: '', ok: false };
  }

  for (const tc of toolCalls) {
    const tcErrors = validateSingleTC(tc);
    if (tcErrors.length === 0) {
      valid.push({ ...tc, name: tc.name.trim() });
    } else {
      errors.push(...tcErrors);
    }
  }

  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? valid : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors = validateSingleTC(tc);
  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? [tc] : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

export function buildCorrectionPrompt(errors: string[]): string {
  if (errors.length === 0) return '';
  if (errors.length === 1) return `Fix: ${errors[0]}`;
  if (errors.length <= 3) return `Fix: ${errors.join('; ')}`;
  return `Fix: ${errors.slice(0, 3).join('; ')} and ${errors.length - 3} more.`;
}

export function detectProviderToolLeak(content: string): ProviderToolLeakResult {
  if (/function_call.*role/i.test(content)) return { detected: true, type: 'function_role' };
  if (/tool_calls.*role/i.test(content)) return { detected: true, type: 'tool_call_role' };
  if (/<tool_use>/i.test(content)) return { detected: true, type: 'tool_use_xml' };
  return { detected: false };
}