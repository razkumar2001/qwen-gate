/*
 * File: ToolResultEchoFilter.test.ts
 * Tests for the two-stage SimHash + Jaccard echo filter.
 */

import { describe, it, expect } from 'vitest';
import { ToolResultEchoFilter } from './ToolResultEchoFilter';

describe('ToolResultEchoFilter', () => {
  describe('constructor', () => {
    it('should accept empty tool results array', () => {
      const filter = new ToolResultEchoFilter([]);
      expect(filter).toBeDefined();
    });

    it('should accept multiple tool results', () => {
      const filter = new ToolResultEchoFilter([
        'Line 1\nLine 2\nLine 3',
        'Another result\nWith multiple lines',
      ]);
      expect(filter).toBeDefined();
    });
  });

  describe('isEcho', () => {
    it('should return false for completely original content', () => {
      const filter = new ToolResultEchoFilter(['Tool result content here']);
      expect(filter.isEcho('This is completely different content')).toBe(false);
    });

    it('should return true for verbatim echo of tool result line', () => {
      const toolResult = 'function hello() {\n  console.log("world");\n}';
      const filter = new ToolResultEchoFilter([toolResult]);
      expect(filter.isEcho('function hello() {')).toBe(true);
    });

    it('should return true for near-duplicate with minor whitespace changes', () => {
      const toolResult = 'const x = 42;\nconst y = 100;';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Extra spaces should still match (normalized)
      expect(filter.isEcho('const  x  =  42;')).toBe(true);
    });

    it('should return true for paraphrased echo with high similarity', () => {
      const toolResult = 'The file contains 42 lines of code.';
      const filter = new ToolResultEchoFilter([toolResult]);
      // SimHash should catch this as similar (hamming distance ≤3)
      expect(filter.isEcho('The file contains 42 lines of code')).toBe(true);
    });

    it('should return false for brief reference to tool result', () => {
      const toolResult = 'Error: File not found at /path/to/file.txt\nStack trace:\n  at line 42\n  at line 100';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Brief mention should pass through
      expect(filter.isEcho('The tool reported an error.')).toBe(false);
    });

    it('should return false for analysis/synthesis of tool result', () => {
      const toolResult = 'CPU: 45%\nMemory: 2.1GB\nDisk: 78%';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Original analysis should pass
      expect(filter.isEcho('System resources are within normal limits.')).toBe(false);
    });

    it('should handle empty lines gracefully', () => {
      const filter = new ToolResultEchoFilter(['Line 1\n\nLine 3']);
      expect(filter.isEcho('')).toBe(false);
    });

    it('should skip very short lines (< 10 chars after normalization)', () => {
      const filter = new ToolResultEchoFilter(['const x = 42;']);
      // Short line should not match
      expect(filter.isEcho('const x')).toBe(false);
    });
  });

  describe('filterText', () => {
    it('should remove echoed lines from multi-line text', () => {
      const toolResult = 'Line 1: Hello\nLine 2: World\nLine 3: Test';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Line 1: Hello\nThis is original\nLine 2: World\nMore original content';
      const result = filter.filterText(input);
      expect(result).not.toContain('Line 1: Hello');
      expect(result).not.toContain('Line 2: World');
      expect(result).toContain('This is original');
      expect(result).toContain('More original content');
    });

    it('should preserve text when no echoes detected', () => {
      const toolResult = 'Tool output here';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Completely different content\nWith multiple lines\nAll original';
      const result = filter.filterText(input);
      expect(result).toBe(input);
    });

    it('should handle text with no line breaks', () => {
      const toolResult = 'Single line tool result';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Single line original text';
      const result = filter.filterText(input);
      expect(result).toBe(input);
    });

    it('should clean up multiple consecutive blank lines after filtering', () => {
      const toolResult = 'Echo line 1\nEcho line 2\nEcho line 3';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Original\nEcho line 1\nEcho line 2\nEcho line 3\nMore original';
      const result = filter.filterText(input);
      // Should not have 3+ consecutive blank lines
      expect(result).not.toMatch(/\n\n\n/);
    });
  });

  describe('ring buffer behavior', () => {
    it('should maintain bounded memory with many tool result lines', () => {
      // Create 200 lines of tool results
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
      const toolResult = lines.join('\n');
      const filter = new ToolResultEchoFilter([toolResult]);
      
      // Should not throw or consume excessive memory
      expect(filter.isEcho('Some new content')).toBe(false);
    });

    it('should evict old entries when buffer is full', () => {
      const toolResult = Array.from({ length: 150 }, (_, i) => `Line ${i}: content`).join('\n');
      const filter = new ToolResultEchoFilter([toolResult]);
      
      // Early lines should still be detectable (ring buffer = 100)
      expect(filter.isEcho('Line 0: content')).toBe(true);
      expect(filter.isEcho('Line 50: content')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle tool results with only whitespace', () => {
      const filter = new ToolResultEchoFilter(['   \n  \n   ']);
      expect(filter.isEcho('Some content')).toBe(false);
    });

    it('should handle tool results with special characters', () => {
      const toolResult = 'Error: \\n\\t at line 42\\nStack: \\"file.ts\\"';
      const filter = new ToolResultEchoFilter([toolResult]);
      expect(filter.isEcho('Error: \\n\\t at line 42')).toBe(true);
    });

    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const filter = new ToolResultEchoFilter([longLine]);
      expect(filter.isEcho(longLine)).toBe(true);
      expect(filter.isEcho('y'.repeat(10000))).toBe(false);
    });

    it('should handle Unicode content', () => {
      const toolResult = 'Error: 文件未找到\n位置: /路径/到/文件.txt';
      const filter = new ToolResultEchoFilter([toolResult]);
      expect(filter.isEcho('Error: 文件未找到')).toBe(true);
    });
  });

  describe('SimHash algorithm', () => {
    it('should produce consistent hashes for identical input', () => {
      const filter = new ToolResultEchoFilter([]);
      // Access private method via any for testing
      const hash1 = (filter as any).computeSimHash('test line');
      const hash2 = (filter as any).computeSimHash('test line');
      expect(hash1).toBe(hash2);
    });

    it('should produce similar hashes for similar input', () => {
      const filter = new ToolResultEchoFilter([]);
      const hash1 = (filter as any).computeSimHash('The quick brown fox');
      const hash2 = (filter as any).computeSimHash('The quick brown fox jumps');
      const distance = (filter as any).hammingDistance(hash1, hash2);
      // Should be within threshold (≤3)
      expect(distance).toBeLessThanOrEqual(3);
    });

    it('should produce different hashes for different input', () => {
      const filter = new ToolResultEchoFilter([]);
      const hash1 = (filter as any).computeSimHash('completely different');
      const hash2 = (filter as any).computeSimHash('entirely unrelated content');
      const distance = (filter as any).hammingDistance(hash1, hash2);
      // Should be far apart (>3)
      expect(distance).toBeGreaterThan(3);
    });
  });

  describe('Jaccard similarity', () => {
    it('should return 1.0 for identical token sets', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c']);
      const tokens2 = new Set(['a', 'b', 'c']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      expect(similarity).toBe(1.0);
    });

    it('should return 0.0 for disjoint token sets', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c']);
      const tokens2 = new Set(['x', 'y', 'z']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      expect(similarity).toBe(0.0);
    });

    it('should return correct value for partial overlap', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c', 'd']);
      const tokens2 = new Set(['c', 'd', 'e', 'f']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      // Intersection: {c, d} = 2, Union: {a,b,c,d,e,f} = 6
      expect(similarity).toBeCloseTo(2 / 6, 2);
    });
  });
});
