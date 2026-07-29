/**
 * Process-local observability for one MCP server instance. Nothing is written
 * to disk or sent over the network; counters reset whenever the process exits.
 */
export interface RecentServerError {
  timestamp: string;
  source: 'tool' | 'ipc';
  code: string;
  message: string;
  tool?: string;
}

interface ToolSample { name: string; durationMs: number; ok: boolean; code?: string }

const MAX_SAMPLES = 2_000;
const MAX_ERRORS = 100;
const startedAt = Date.now();
const samples: ToolSample[] = [];
const errors: RecentServerError[] = [];
let ipcFailures = 0;

function redact(value: string): string {
  return value
    .replace(/(token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])*[^\s"']+/g, '[redacted-path]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

function pushError(error: RecentServerError): void {
  errors.push(error);
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
}

export function recordToolCall(name: string, durationMs: number, ok: boolean, code?: string, message?: string): void {
  samples.push({ name, durationMs: Math.max(0, Math.round(durationMs)), ok, code });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  if (!ok) {
    pushError({
      timestamp: new Date().toISOString(),
      source: 'tool',
      tool: name,
      code: code ?? 'INTERNAL_ERROR',
      message: redact(message ?? 'Tool call failed.'),
    });
  }
}

export function recordIpcFailure(error: unknown): void {
  ipcFailures += 1;
  const candidate = error as { code?: unknown; message?: unknown };
  pushError({
    timestamp: new Date().toISOString(),
    source: 'ipc',
    code: typeof candidate?.code === 'string' ? candidate.code : 'IPC_FAILURE',
    message: redact(typeof candidate?.message === 'string' ? candidate.message : String(error)),
  });
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil((percentileValue / 100) * ordered.length) - 1)]!;
}

export function getServerMetrics() {
  const durations = samples.map(sample => sample.durationMs);
  const errorsByCode: Record<string, number> = {};
  for (const sample of samples) {
    if (!sample.ok) errorsByCode[sample.code ?? 'INTERNAL_ERROR'] = (errorsByCode[sample.code ?? 'INTERNAL_ERROR'] ?? 0) + 1;
  }
  const toolCallsByName: Record<string, number> = {};
  for (const sample of samples) toolCallsByName[sample.name] = (toolCallsByName[sample.name] ?? 0) + 1;
  const failureCount = samples.filter(sample => !sample.ok).length;
  return {
    scope: 'process-local',
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    retention: { maxSamples: MAX_SAMPLES, maxErrors: MAX_ERRORS },
    toolCalls: { total: samples.length, failed: failureCount, errorRate: samples.length === 0 ? 0 : failureCount / samples.length, byName: toolCallsByName },
    durationsMs: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
    ipc: { failures: ipcFailures },
    errorsByCode,
  };
}

export function getRecentServerErrors(limit: number): RecentServerError[] {
  return errors.slice(-limit).reverse();
}

/** Test-only reset; not exported from the MCP surface. */
export function resetServerObservabilityForTests(): void {
  samples.length = 0;
  errors.length = 0;
  ipcFailures = 0;
}
