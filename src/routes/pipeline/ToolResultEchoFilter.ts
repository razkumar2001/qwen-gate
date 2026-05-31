/*
 * File: ToolResultEchoFilter.ts
 * Two-stage SimHash + Jaccard filter for detecting tool result echoes in LLM output.
 *
 * Algorithm:
 * - Stage 1 (SimHash): Fast gate using 64-bit hash + hamming distance ≤3
 * - Stage 2 (Jaccard): Exact tiebreaker on hash collisions, threshold 0.7
 * - Ring buffer: 100 lines max to bound memory
 *
 * Usage:
 *   const filter = new ToolResultEchoFilter(toolResultContents);
 *   const isEcho = filter.isEcho(line);
 *   const cleanText = filter.filterText(fullText);
 */

const SIMHASH_BITS = 64;
const HAMMING_THRESHOLD = 3;
const JACCARD_THRESHOLD = 0.7;
const RING_BUFFER_SIZE = 100;
const MIN_LINE_LENGTH = 10;

interface Fingerprint {
  simhash: bigint;
  tokens: Set<string>;
}

export class ToolResultEchoFilter {
  private fingerprints: Fingerprint[] = [];

  constructor(toolResults: string[]) {
    for (const result of toolResults) {
      const lines = result.split('\n');
      for (const line of lines) {
        const normalized = this.normalizeLine(line);
        if (normalized.length < MIN_LINE_LENGTH) continue;
        
        const simhash = this.computeSimHash(normalized);
        const tokens = this.tokenize(normalized);
        
        this.fingerprints.push({ simhash, tokens });
        
        // Ring buffer eviction
        if (this.fingerprints.length > RING_BUFFER_SIZE) {
          this.fingerprints.shift();
        }
      }
    }
  }

  /**
   * Check if a single line is an echo of tool result content.
   */
  isEcho(line: string): boolean {
    const normalized = this.normalizeLine(line);
    if (normalized.length < MIN_LINE_LENGTH) return false;

    const simhash = this.computeSimHash(normalized);
    const tokens = this.tokenize(normalized);

    for (const fp of this.fingerprints) {
      // Stage 1: SimHash gate (fast)
      const distance = this.hammingDistance(simhash, fp.simhash);
      if (distance > HAMMING_THRESHOLD) continue;

      // Stage 2: Jaccard similarity (exact, only on collisions)
      const similarity = this.jaccardSimilarity(tokens, fp.tokens);
      if (similarity >= JACCARD_THRESHOLD) return true;
    }

    return false;
  }

  /**
   * Filter echoed lines from multi-line text.
   */
  filterText(text: string): string {
    const lines = text.split('\n');
    const filtered = lines.filter(line => !this.isEcho(line));
    
    // Clean up multiple consecutive blank lines
    const cleaned: string[] = [];
    let prevBlank = false;
    for (const line of filtered) {
      const isBlank = line.trim() === '';
      if (isBlank && prevBlank) continue;
      cleaned.push(line);
      prevBlank = isBlank;
    }
    
    return cleaned.join('\n');
  }

  /**
   * Normalize a line for comparison: lowercase, collapse whitespace, trim.
   */
  private normalizeLine(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Tokenize normalized line into word set.
   */
  private tokenize(normalized: string): Set<string> {
    return new Set(normalized.split(' ').filter(w => w.length > 0));
  }

  /**
   * Compute 64-bit SimHash for a string.
   * Based on Google's SimHash algorithm for near-duplicate detection.
   */
  private computeSimHash(text: string): bigint {
    const tokens = text.split(' ').filter(w => w.length > 0);
    if (tokens.length === 0) return 0n;

    // Initialize bit vector
    const vector = new Array<number>(SIMHASH_BITS).fill(0);

    // Weight each token's hash contribution
    for (const token of tokens) {
      const hash = this.hashToken(token);
      for (let i = 0; i < SIMHASH_BITS; i++) {
        const bit = (hash >> BigInt(i)) & 1n;
        vector[i] += bit === 1n ? 1 : -1;
      }
    }

    // Convert vector to fingerprint (sign of each dimension)
    let fingerprint = 0n;
    for (let i = 0; i < SIMHASH_BITS; i++) {
      if (vector[i] > 0) {
        fingerprint |= 1n << BigInt(i);
      }
    }

    return fingerprint;
  }

  /**
   * Simple hash function for a token (FNV-1a variant).
   */
  private hashToken(token: string): bigint {
    let hash = 14695981039346656037n; // FNV offset basis
    for (let i = 0; i < token.length; i++) {
      hash ^= BigInt(token.charCodeAt(i));
      hash = (hash * 1099511628211n) & ((1n << BigInt(SIMHASH_BITS)) - 1n); // FNV prime, mask to 64 bits
    }
    return hash;
  }

  /**
   * Compute hamming distance between two 64-bit hashes.
   */
  private hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b;
    let distance = 0;
    while (xor !== 0n) {
      distance += Number(xor & 1n);
      xor >>= 1n;
    }
    return distance;
  }

  /**
   * Compute Jaccard similarity between two token sets.
   * Returns value between 0 (disjoint) and 1 (identical).
   */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1.0;
    if (a.size === 0 || b.size === 0) return 0.0;

    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return intersection / union;
  }
}
