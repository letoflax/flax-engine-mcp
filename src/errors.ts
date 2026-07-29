import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolResponse = CallToolResult;
export type ToolMode = 'offline' | 'editor-connected';
export type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_TOOL'
  | 'NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_REVISION_CONFLICT'
  | 'ASSET_OPERATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'INVALID_PATH'
  | 'FILE_CHANGED'
  | 'FILE_EXISTS'
  | 'IMPORT_SOURCE_NOT_ALLOWED'
  | 'IMPORT_FAILED'
  | 'CONTENT_TOO_LARGE'
  | 'PATCH_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'EDITOR_NOT_CONNECTED'
  | 'EDITOR_BUSY'
  | 'RATE_LIMITED'
  | 'SCENE_NOT_LOADED'
  | 'ACTOR_NOT_FOUND'
  | 'SCRIPT_NOT_FOUND'
  | 'TIMEOUT'
  | 'OPERATION_CANCELLED'
  | 'OPERATION_NOT_FOUND'
  | 'CANCELLATION_UNSUPPORTED'
  | 'BUILD_NOT_COMPLETE'
  | 'BUILD_FAILED'
  | 'COMPILATION_IN_PROGRESS'
  | 'COMPILATION_FAILED'
  | 'COMPILATION_NOT_FOUND'
  | 'DIAGNOSTICS_STALE'
  | 'PLAY_MODE_REQUIRED'
  | 'PLAY_MODE_ACTIVE'
  | 'INVALID_PLAY_STATE'
  | 'DIRTY_SCENES'
  | 'SCENE_REVISION_CONFLICT'
  | 'EDIT_LEASE_CONFLICT'
  | 'EDIT_LEASE_EXPIRED'
  | 'EDIT_LEASE_ACTIVE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CURSOR_INVALID'
  | 'CAPTURE_UNAVAILABLE'
  | 'UNSUPPORTED_FLAX_VERSION'
  | 'INTERNAL_ERROR';

export interface ToolErrorData {
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

export interface ToolEnvelope {
  [key: string]: unknown;
  operationId: string;
  mode: ToolMode;
  ok: boolean;
  data?: unknown;
  error?: ToolErrorData;
  warnings: string[];
  changes: unknown[];
  timing: { durationMs: number };
}

export interface ToolResultMetadata {
  /** The execution mode observed by a state-aware handler. Defaults to offline. */
  mode?: ToolMode;
  /** Machine-readable payload. Text content remains available for legacy clients. */
  data?: unknown;
  warnings?: string[];
  changes?: unknown[];
}

export class ToolDomainError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolDomainError';
  }
}

function operationId(): string {
  return randomUUID();
}

export function toToolError(error: unknown): ToolErrorData {
  if (error instanceof ToolDomainError) {
    return { code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof ZodError) {
    return {
      code: 'INVALID_ARGUMENT',
      message: 'Tool arguments failed validation.',
      details: error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENOENT') || /not found/i.test(message)) {
    return { code: 'NOT_FOUND', message: formatToolError(error) };
  }
  if (message.includes('EACCES') || message.includes('EPERM') || /access denied/i.test(message)) {
    return { code: 'PERMISSION_DENIED', message: formatToolError(error) };
  }
  if (message.includes('ENOTDIR') || /outside project root/i.test(message)) {
    return { code: 'INVALID_PATH', message: formatToolError(error) };
  }
  return { code: 'INTERNAL_ERROR', message: formatToolError(error) };
}

export function formatToolError(error: unknown): string {
  if (error instanceof ToolDomainError) return error.message;
  if (error instanceof ZodError) return 'Tool arguments failed validation.';
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('ENOENT')) return `File not found: ${msg}`;
    if (msg.includes('EACCES') || msg.includes('EPERM')) return `Permission denied: ${msg}`;
    if (msg.includes('ENOTDIR')) return `Expected directory: ${msg}`;
    return msg;
  }
  return String(error);
}

function makeEnvelope(
  ok: boolean,
  text: string,
  error?: ToolErrorData,
  metadata: ToolResultMetadata = {},
): ToolEnvelope {
  return {
    operationId: operationId(),
    mode: metadata.mode ?? 'offline',
    ok,
    ...(ok ? { data: metadata.data ?? { text } } : { error }),
    warnings: metadata.warnings ?? [],
    changes: metadata.changes ?? [],
    timing: { durationMs: 0 },
  };
}

export function toolResult(text: string, metadata?: ToolResultMetadata | string[]): ToolResponse {
  // The array form was introduced for warnings before metadata existed. Keep it
  // working while new handlers can provide typed data and an observed mode.
  const normalized = Array.isArray(metadata) ? { warnings: metadata } : metadata;
  const envelope = makeEnvelope(true, text, undefined, normalized);
  return { content: [{ type: 'text' as const, text }], structuredContent: envelope };
}

export function toolError(error: unknown): ToolResponse {
  const errorData = toToolError(error);
  const envelope = makeEnvelope(false, errorData.message, errorData);
  return {
    content: [{ type: 'text' as const, text: `${errorData.code}: ${errorData.message}` }],
    structuredContent: envelope,
    isError: true,
  };
}

/** Adds request-scoped metadata without requiring legacy handlers to change. */
export function finalizeToolResponse(
  response: ToolResponse,
  operationIdValue: string,
  durationMs: number,
): ToolResponse {
  const existing = response.structuredContent as Partial<ToolEnvelope> | undefined;
  const text = response.content.find(item => item.type === 'text');
  const fallbackText = text?.type === 'text' ? text.text : '';
  const error = response.isError
    ? (existing?.error ?? { code: 'INTERNAL_ERROR' as const, message: fallbackText })
    : undefined;
  const envelope: ToolEnvelope = {
    operationId: operationIdValue,
    mode: existing?.mode === 'editor-connected' ? 'editor-connected' : 'offline',
    ok: !response.isError,
    ...(response.isError ? { error } : { data: existing?.data ?? { text: fallbackText } }),
    warnings: existing?.warnings ?? [],
    changes: existing?.changes ?? [],
    timing: { durationMs },
  };
  return { ...response, structuredContent: envelope };
}
