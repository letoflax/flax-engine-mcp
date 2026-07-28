import path from 'node:path';
import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ProjectMeta } from '../projectContext.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';

type Row = Record<string, unknown>;
const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const Severity = z.enum(['trace', 'debug', 'info', 'warning', 'error', 'fatal']);
const filters = {
  since_sequence: z.number().int().min(0).optional().default(0),
  severities: z.array(Severity).max(6).optional(),
  category: z.string().min(1).max(128).optional(),
  play_session_id: z.string().min(1).max(128).optional(),
};

export const LogGetRecentSchema = z.object({
  ...filters,
  limit: z.number().int().min(1).max(200).optional().default(100),
});
export const LogSearchSchema = z.object({
  ...filters,
  query: z.string().min(1).max(256),
  match: z.enum(['substring', 'regex']).optional().default('substring'),
  case_sensitive: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(200).optional().default(100),
  max_scan: z.number().int().min(1).max(2_000).optional().default(1_000),
});
export const LogGetRuntimeErrorsSchema = z.object({
  ...filters,
  limit: z.number().int().min(1).max(200).optional().default(100),
  max_scan: z.number().int().min(1).max(2_000).optional().default(1_000),
});
export const ViewportCaptureSchema = z.object({
  viewport: z.literal('game').optional().default('game'),
  timeout_ms: z.number().int().min(500).max(30_000).optional().default(10_000),
  poll_interval_ms: z.number().int().min(50).max(1_000).optional().default(100),
});
export const RuntimeInspectActorSchema = z.object({
  actor_id: FlaxId,
  depth: z.number().int().min(0).max(4).optional().default(1),
  include_scripts: z.boolean().optional().default(true),
});

function bridgeError(error: unknown, capture = false): ToolDomainError {
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  const remote = (error.details as { code?: unknown } | undefined)?.code;
  if (remote === 'PLAY_MODE_REQUIRED') return new ToolDomainError('PLAY_MODE_REQUIRED', error.message, error.details);
  if (remote === 'HEADLESS_MODE' || remote === 'CAPTURE_UNAVAILABLE') return new ToolDomainError('CAPTURE_UNAVAILABLE', error.message, error.details);
  if (remote === 'INVALID_STATE') return new ToolDomainError(capture ? 'CAPTURE_UNAVAILABLE' : 'PLAY_MODE_REQUIRED', error.message, error.details);
  if (remote === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, error.details);
  if (remote === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (remote === 'RESPONSE_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, error.details);
  if (remote === 'VALIDATION_FAILED' || remote === 'INVALID_REQUEST') return new ToolDomainError('VALIDATION_FAILED', error.message, error.details);
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function call<R>(ctx: ProjectMeta, method: string, params: Row, deadlineMs?: number) {
  return callEditorBridge<BridgeMethod, Row, R>(ctx, method as BridgeMethod, params, deadlineMs ? { deadlineMs } : undefined);
}

function val(row: Row, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined) return row[key];
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactText(value: string, projectRoot: string): string {
  const sentinel = '__FLAX_MCP_PROJECT_ROOT__';
  const rootPattern = projectRoot
    .split(/[\\/]+/)
    .map(escapeRegex)
    .join('[\\\\/]');
  let text = value.replace(new RegExp(rootPattern, 'gi'), sentinel);
  // Log messages and stack traces can contain paths that are not represented by
  // a dedicated `File` property. Never expose host drive/user paths from them.
  text = text.replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\s]+[\\/])*[^\\/:*?"<>|\s]+/g, '<redacted-path>');
  text = text.replace(/(^|[\s("'=:])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '$1<redacted-path>');
  return text.replaceAll(sentinel, '<project>');
}

function clean(value: unknown, ctx: ProjectMeta, key = ''): unknown {
  if (typeof value === 'string') {
    const root = path.resolve(ctx.projectPath);
    let text = value;
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(text) && /(?:path|file|source|output)/i.test(key)) {
      const absolute = path.resolve(text);
      const relative = path.relative(root, absolute);
      text = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative.replaceAll('\\', '/')
        : path.basename(absolute);
    } else {
      text = redactText(text, root);
    }
    return text;
  }
  if (Array.isArray(value)) return value.slice(0, 2_000).map(item => clean(item, ctx, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Row).map(([k, v]) => [k, clean(v, ctx, k)]));
  }
  return value;
}

interface LogPage { entries: Row[]; nextSequence: number; hasMore: boolean; droppedCount: number }
function normalizePage(raw: unknown, fallback: number): LogPage {
  const row = raw && typeof raw === 'object' ? raw as Row : {};
  const list = val(row, 'Entries', 'entries', 'Items', 'items');
  const entries = Array.isArray(list) ? list.filter((item): item is Row => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
  const last = entries.length ? Number(val(entries[entries.length - 1], 'Sequence', 'sequence')) : fallback;
  const next = Number(val(row, 'NextSequence', 'nextSequence') ?? (Number.isFinite(last) ? last + 1 : fallback));
  return {
    entries,
    nextSequence: Number.isSafeInteger(next) && next >= fallback ? next : fallback,
    hasMore: Boolean(val(row, 'HasMore', 'hasMore')),
    droppedCount: Number(val(row, 'DroppedCount', 'droppedCount') ?? 0),
  };
}

function queryParams(args: z.infer<typeof LogGetRecentSchema>, limit: number, since: number, contains?: string): Row {
  return {
    SinceSequence: since, Limit: limit,
    ...(args.severities ? { Severities: args.severities } : {}),
    ...(args.category ? { Category: args.category } : {}),
    ...(args.play_session_id ? { PlaySessionId: args.play_session_id } : {}),
    ...(contains ? { Contains: contains } : {}),
  };
}

async function fetchPage(ctx: ProjectMeta, args: z.infer<typeof LogGetRecentSchema>, limit: number, since: number, contains?: string) {
  const response = await call<unknown>(ctx, 'log.query', queryParams(args, limit, since, contains));
  return { response, page: normalizePage(response.data, since) };
}

function ok(data: unknown, warnings: string[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings });
}

export async function handleLogGetRecent(args: z.infer<typeof LogGetRecentSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await call<unknown>(ctx, 'log.query', {
      ...queryParams(args, args.limit, args.since_sequence),
      Tail: args.since_sequence === 0,
    });
    const page = normalizePage(response.data, args.since_sequence);
    return ok(clean({ entries: page.entries, next_sequence: page.nextSequence, has_more: page.hasMore, dropped_count: page.droppedCount }, ctx), response.warnings);
  } catch (error) { return toolError(bridgeError(error)); }
}

function safePattern(source: string, caseSensitive: boolean): RegExp {
  if (source.length > 128 || /\\[1-9]|(\(\?<[-=!])|(?:[+*}]\s*[+*{])|\([^)]*[+*][^)]*\)\s*[+*{]/.test(source)) {
    throw new ToolDomainError('INVALID_ARGUMENT', 'Regex is too complex or potentially unsafe.');
  }
  try { return new RegExp(source, caseSensitive ? '' : 'i'); }
  catch { throw new ToolDomainError('INVALID_ARGUMENT', 'Invalid regular expression.'); }
}

async function scanLogs(
  args: z.infer<typeof LogSearchSchema>,
  ctx: ProjectMeta,
  predicate: (row: Row) => boolean,
  contains?: string,
): Promise<{ entries: Row[]; next_sequence: number; scanned: number; truncated: boolean; warnings: string[] }> {
  const entries: Row[] = [];
  const warnings: string[] = [];
  let cursor = args.since_sequence;
  let scanned = 0;
  let hasMore = true;
  while (hasMore && scanned < args.max_scan && entries.length < args.limit) {
    const take = Math.min(200, args.max_scan - scanned);
    const { response, page } = await fetchPage(ctx, args, take, cursor, contains);
    warnings.push(...response.warnings);
    scanned += page.entries.length;
    entries.push(...page.entries.filter(predicate).slice(0, args.limit - entries.length));
    hasMore = page.hasMore;
    if (page.nextSequence <= cursor || page.entries.length === 0) break;
    cursor = page.nextSequence;
  }
  return { entries, next_sequence: cursor, scanned, truncated: hasMore || entries.length >= args.limit, warnings };
}

export async function handleLogSearch(args: z.infer<typeof LogSearchSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const regex = args.match === 'regex' ? safePattern(args.query, args.case_sensitive) : undefined;
    const needle = args.case_sensitive ? args.query : args.query.toLocaleLowerCase();
    const found = await scanLogs(args, ctx, row => {
      const haystack = JSON.stringify(row).slice(0, 16_384);
      return regex ? regex.test(haystack) : (args.case_sensitive ? haystack : haystack.toLocaleLowerCase()).includes(needle);
    }, args.match === 'substring' ? args.query : undefined);
    return ok(clean({ entries: found.entries, next_sequence: found.next_sequence, scanned: found.scanned, truncated: found.truncated }, ctx), found.warnings);
  } catch (error) { return toolError(error instanceof ToolDomainError ? error : bridgeError(error)); }
}

export async function handleLogGetRuntimeErrors(args: z.infer<typeof LogGetRuntimeErrorsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const scanArgs = { ...args, query: '', match: 'substring' as const, case_sensitive: false };
    const found = await scanLogs(scanArgs, ctx, row => {
      const severity = String(val(row, 'Severity', 'severity', 'Level', 'level') ?? '').toLowerCase();
      const text = JSON.stringify(row).toLowerCase();
      return severity === 'error' || severity === 'fatal' || text.includes('exception');
    });
    return ok(clean({ errors: found.entries, next_sequence: found.next_sequence, scanned: found.scanned, truncated: found.truncated }, ctx), found.warnings);
  } catch (error) { return toolError(bridgeError(error)); }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function handleViewportCapture(args: z.infer<typeof ViewportCaptureSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const started = await call<unknown>(ctx, 'capture.start', {});
    const start = started.data && typeof started.data === 'object' ? started.data as Row : {};
    const id = String(val(start, 'CaptureId', 'captureId', 'Id', 'id') ?? '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ToolDomainError('INTERNAL_ERROR', 'Bridge returned an invalid capture identifier.');
    const deadline = Date.now() + args.timeout_ms;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const statusResponse = await call<unknown>(ctx, 'capture.status', { CaptureId: id }, Math.max(50, Math.min(5_000, remaining)));
      const status = statusResponse.data && typeof statusResponse.data === 'object' ? statusResponse.data as Row : {};
      const state = String(val(status, 'Phase', 'phase', 'State', 'state', 'Status', 'status') ?? '').toLowerCase();
      if (state === 'completed' || state === 'ready' || state === 'succeeded') {
        const data = clean({
          capture_id: id,
          uri: `flax://capture/${id}`,
          phase: 'completed',
          size_bytes: val(status, 'SizeBytes', 'sizeBytes'),
          started_unix_ms: val(status, 'StartedUnixMs', 'startedUnixMs'),
          completed_unix_ms: val(status, 'CompletedUnixMs', 'completedUnixMs'),
        }, ctx);
        return ok(data, [...started.warnings, ...statusResponse.warnings]);
      }
      if (state === 'failed' || state === 'cancelled') throw new ToolDomainError('CAPTURE_UNAVAILABLE', String(val(status, 'Error', 'error') ?? `Capture ${state}.`));
      await delay(Math.min(args.poll_interval_ms, Math.max(0, deadline - Date.now())));
    }
    throw new ToolDomainError('TIMEOUT', `Capture did not complete within ${args.timeout_ms} ms.`);
  } catch (error) { return toolError(error instanceof ToolDomainError ? error : bridgeError(error, true)); }
}

export async function handleRuntimeInspectActor(args: z.infer<typeof RuntimeInspectActorSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await call<unknown>(ctx, 'runtime.inspect_actor', { ActorId: args.actor_id, Depth: args.depth, IncludeScripts: args.include_scripts });
    const result = clean(response.data, ctx);
    if (JSON.stringify(result).length > 262_144) throw new ToolDomainError('CONTENT_TOO_LARGE', 'Runtime actor inspection exceeded 256 KiB.');
    return ok({ actor: result }, response.warnings);
  } catch (error) { return toolError(error instanceof ToolDomainError ? error : bridgeError(error)); }
}
