/*
 * File: logStore.ts
 * In-memory log store — captures client requests and Qwen responses
 * for viewing at http://qwen-gate/log (SSE) and http://qwen-gate/log/json
 *
 * Also provides a system-level logger with levels, categories, filtering,
 * and optional file persistence for operational events (auth, circuit breaker,
 * session pool, streaming failures, etc.).
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

// ─── System Log Levels & Categories ─────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SystemLogFilter {
  minLevel?: LogLevel;
  category?: string;
  since?: string;
  limit?: number;
}

// ─── Request Log Entry (existing) ───────────────────────────────────────────────

export interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  stream: boolean;
  accountEmail: string;
  level: LogLevel;
  request_id: string;
  latency_ms: number | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  input: string; // Sanitized prompt for display
  rawRequestBody?: Record<string, unknown>; // Full OpenAI request body (model, messages, tools, etc.)
  rawResponse: string; // Full raw response from Qwen (not truncated)
  processedResponse: string; // After content filtering/tool parsing
  error: string | null;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    success: boolean;
    blocked?: boolean;
    blockReason?: string;
    error?: string;
    executionTimeMs?: number;
  }>;
  networkTiming?: {
    dnsLookup: number;
    tcpConnect: number;
    tlsHandshake: number;
    firstByte: number;
    total: number;
  };
}

const MAX_ENTRIES = 100;
const MAX_CHUNKS_PER_ENTRY = 50;
const MAX_SYSTEM_ENTRIES = 500;

class LogStore {
  private entries: LogEntry[] = [];
  private entryMap: Map<string, LogEntry> = new Map();
  private systemEntries: SystemLogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private systemListeners: Set<(entry: SystemLogEntry) => void> = new Set();
  private persistencePath: string | null = null;
  private requestLogPath: string | null = null;
  private systemIdCounter = 0;


  enablePersistence(dirPath: string): void {
    try {
      mkdirSync(dirPath, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      this.persistencePath = resolve(dirPath, `qwen-gate-${date}.log`);
      this.requestLogPath = resolve(dirPath, `requests-${date}.jsonl`);
      console.log(`[LogStore] Persistence enabled: ${this.persistencePath}`);
      console.log(`[LogStore] Request log: ${this.requestLogPath}`);
    } catch (err) {
      console.error(`[LogStore] Failed to enable persistence:`, err);
    }
  }

  /**
   * Persist a completed request entry to the request log file.
   * Records both the raw Qwen output and the processed API output sent to the client.
   * Call this once per request at the end of the chat completion handler.
   */
  persistRequest(entry: LogEntry): void {
    if (!this.requestLogPath) return;
    try {
      const record = {
        id: entry.id,
        timestamp: entry.timestamp,
        model: entry.model,
        stream: entry.stream,
        finishReason: entry.finalResponse?.finishReason || '',
        clientRequest: entry.clientRequest,
        // What Qwen actually produced (before any filtering)
        qwenRawOutput: entry.rawFullContent || (entry.qwenRawChunks || []).join(''),
        // What the API actually sent to the client (after parsing + filtering)
        processedApiOutput: entry.processedApiOutput || '',
        parsedToolCalls: entry.parsedToolCalls,
        errors: entry.errors,
        networkTiming: entry.networkTiming,
      };
      appendFileSync(this.requestLogPath, JSON.stringify(record) + '\n');
    } catch (err) {
      // Swallow write errors — logging must never break the request path
    }
  }

  log(level: LogLevel, category: string, message: string, metadata?: Record<string, unknown>): void {
    const entry: SystemLogEntry = {
      id: `sys-${++this.systemIdCounter}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    };
    this.systemEntries.unshift(entry);
    if (this.systemEntries.length > MAX_SYSTEM_ENTRIES) this.systemEntries.pop();

    for (const listener of this.systemListeners) {
      try { listener(entry); } catch (err) {
        console.error('[LogStore] System log listener error:', err);
      }
    }

    if (this.persistencePath) {
      try {
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(this.persistencePath, line);
      } catch (err) {
        console.error('[LogStore] Failed to persist system log entry:', err);
      }
    }

    const prefix = `[${level.toUpperCase()}]`;
    const meta = metadata ? ` ${JSON.stringify(metadata)}` : '';
    if (level === 'error') console.error(`${prefix} [${category}] ${message}${meta}`);
    else if (level === 'warn') console.warn(`${prefix} [${category}] ${message}${meta}`);
    else console.log(`${prefix} [${category}] ${message}${meta}`);
  }

  debug(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', category, message, metadata);
  }
  info(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('info', category, message, metadata);
  }
  warn(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', category, message, metadata);
  }
  error(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('error', category, message, metadata);
  }

  getSystemLogs(filter?: SystemLogFilter): SystemLogEntry[] {
    let result = this.systemEntries;
    if (filter?.minLevel) {
      const minRank = LOG_LEVEL_RANK[filter.minLevel];
      result = result.filter(e => LOG_LEVEL_RANK[e.level] >= minRank);
    }
    if (filter?.category) {
      result = result.filter(e => e.category === filter.category);
    }
    if (filter?.since) {
      result = result.filter(e => e.timestamp >= filter.since!);
    }
    return result.slice(0, filter?.limit ?? 100);
  }

  subscribeSystem(listener: (entry: SystemLogEntry) => void): () => void {
    this.systemListeners.add(listener);
    return () => { this.systemListeners.delete(listener); };
  }

  createEntry(id: string, model: string, stream: boolean, requestId?: string, accountEmail?: string): LogEntry {
    const entry: LogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model,
      stream,
      accountEmail: accountEmail || '',
      // Structured log fields for external aggregators
      level: 'info',
      request_id: requestId ?? id,
      latency_ms: null,
      tokens: null,
      clientRequest: {
        messageCount: 0,
        roles: [],
        hasTools: false,
        toolNames: [],
        tool_choice: null,
        lastMessage: '',
      },
      promptToQwen: {
        systemPromptLength: 0,
        totalLength: 0,
        preview: '',
      },
      qwenRawChunks: [],
      rawFullContent: '',
      toolCallResults: [],
      parsedToolCalls: [],
      remainingText: '',
      processedApiOutput: '',
      finalResponse: {
        finishReason: '',
        toolCallCount: 0,
        contentPreview: '',
      },
      errors: [],
    };
    this.entries.unshift(entry);
    this.entryMap.set(entry.id, entry);
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.pop();
      if (removed) this.entryMap.delete(removed.id);
    }
    return entry;
  }

  updateEntry(id: string, updater: (entry: LogEntry) => void): void {
    const entry = this.entryMap.get(id);
    if (!entry) return;
    updater(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  addRawChunk(id: string, chunk: string): void {
    this.updateEntry(id, entry => {
      if (entry.qwenRawChunks.length < MAX_CHUNKS_PER_ENTRY) {
        entry.qwenRawChunks.push(chunk);
      }
      entry.rawFullContent += chunk;
    });
  }

  /** Record an amplification event when output vastly exceeds input */
  recordAmplificationEvent(logId: string, ratio: number, triggeringInput: string): void {
    this.updateEntry(logId, entry => {
      entry.amplificationRatio = ratio;
      entry.amplificationTriggeredInput = triggeringInput.length > 2000
        ? triggeringInput.substring(0, 2000) + `... [truncated ${triggeringInput.length - 2000} more chars]`
        : triggeringInput;
    });
  }

  /** Append content that was actually sent to the client (after all processing) */
  addProcessedOutput(id: string, content: string): void {
    this.updateEntry(id, entry => {
      entry.processedApiOutput += content;
    });
  }

  getEntry(id: string): LogEntry | undefined {
    return this.entryMap.get(id);
  }

  addError(id: string, error: string): void {
    this.updateEntry(id, entry => {
      entry.errors.push(error);
    });
  }

  getRecent(count = 20): LogEntry[] {
    return this.entries.slice(0, count);
  }

  getAll(): LogEntry[] {
    return this.entries;
  }

  setNetworkTiming(id: string, timing: LogEntry['networkTiming']): void {
    this.updateEntry(id, entry => {
      entry.networkTiming = timing;
    });
  }

  // SSE listener management
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Uptime in seconds since server start
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.serverStartTime) / 1000);
  }

  // ─── Model Health Tracking ──────────────────────────────────────────────────

  private modelErrorCounts: Map<string, number> = new Map();
  private modelSuccessCounts: Map<string, number> = new Map();
  private readonly MODEL_HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minute sliding window
  private modelHealthTimestamps: Map<string, number> = new Map();

  /**
   * Record an error for a specific model - used by ModelRouter for health tracking
   */
  recordModelError(model: string): void {
    const count = this.modelErrorCounts.get(model) || 0;
    this.modelErrorCounts.set(model, count + 1);
    this.modelHealthTimestamps.set(model, Date.now());
  }

  /**
   * Record a success for a specific model - used by ModelRouter for health tracking
   */
  recordModelSuccess(model: string): void {
    const count = this.modelSuccessCounts.get(model) || 0;
    this.modelSuccessCounts.set(model, count + 1);
    this.modelHealthTimestamps.set(model, Date.now());
  }

  /**
   * Get health metrics for a model within the sliding window
   */
  getModelHealth(model: string): { errors: number; successes: number; errorRate: number; isHealthy: boolean } {
    const now = Date.now();
    const lastCheck = this.modelHealthTimestamps.get(model);
    
    // Expire metrics outside the health window
    if (lastCheck && now - lastCheck > this.MODEL_HEALTH_WINDOW_MS) {
      this.modelErrorCounts.delete(model);
      this.modelSuccessCounts.delete(model);
      this.modelHealthTimestamps.delete(model);
      return { errors: 0, successes: 0, errorRate: 0, isHealthy: true };
    }

    const errors = this.modelErrorCounts.get(model) || 0;
    const successes = this.modelSuccessCounts.get(model) || 0;
    const total = errors + successes;
    const errorRate = total > 0 ? errors / total : 0;
    const errorThreshold = 0.3; // 30% error rate triggers degradation

    return {
      errors,
      successes,
      errorRate,
      isHealthy: errorRate < errorThreshold
    };
  }

  /**
   * Reset health metrics for a model (useful for testing or manual recovery)
   */
  resetModelHealth(model: string): void {
    this.modelErrorCounts.delete(model);
    this.modelSuccessCounts.delete(model);
    this.modelHealthTimestamps.delete(model);
  }

  getAllModelHealth(): Record<string, { successCount: number; errorCount: number; lastActivity: string }> {
    const result: Record<string, { successCount: number; errorCount: number; lastActivity: string }> = {};
    const allModels = new Set([...this.modelErrorCounts.keys(), ...this.modelSuccessCounts.keys()]);
    for (const model of allModels) {
      result[model] = {
        successCount: this.modelSuccessCounts.get(model) || 0,
        errorCount: this.modelErrorCounts.get(model) || 0,
        lastActivity: this.modelHealthTimestamps.get(model) || '',
      };
    }
    return result;
  }

  // ─── Tool Discipline Metrics ──────────────────────────────────────────────

  private toolCallValidationFailures = 0;
  private hallucinatedToolNames = 0;

  /**
   * Increment counter for tool call validation failures
   * (e.g., JSON parse errors, schema mismatches, guard rejections)
   */
  recordToolCallValidationFailure(): void {
    this.toolCallValidationFailures++;
  }

  /**
   * Increment counter for hallucinated tool names
   * (e.g., model invents tool not in available_tools registry)
   */
  recordHallucinatedToolName(): void {
    this.hallucinatedToolNames++;
  }

  /**
   * Get tool discipline metrics for observability/Prometheus export
   */
  getToolDisciplineMetrics(): {
    toolCallValidationFailures: number;
    hallucinatedToolNames: number;
  } {
    return {
      toolCallValidationFailures: this.toolCallValidationFailures,
      hallucinatedToolNames: this.hallucinatedToolNames,
    };
  }

  /**
   * Reset tool discipline metrics (useful for testing or manual recovery)
   */
  resetToolDisciplineMetrics(): void {
    this.toolCallValidationFailures = 0;
    this.hallucinatedToolNames = 0;
  }
}

export const logStore = new LogStore();
