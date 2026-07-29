import path from 'node:path';
import { z } from 'zod';
import { callEditorBridge } from './bridge/fileRpcClient.js';
import { BridgeRpcError } from './bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from './errors.js';
import { ProjectMeta } from './projectContext.js';

const OperationId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character operation ID.');
export const OperationGetStatusSchema = z.object({ operation_id: OperationId });
export const OperationCancelSchema = z.object({ operation_id: OperationId });

export interface OperationHandle {
  operationId: string;
  kind: string;
  phase: string;
  progress: number;
  message?: string;
  canCancel: boolean;
  cancelRequested: boolean;
  startedUnixMs: number;
  updatedUnixMs: number;
  finishedUnixMs: number;
  resultSummary?: string;
  errorCode?: string;
  error?: string;
  diagnostics: string[];
}

export function isTerminalOperation(value: unknown): boolean {
  const phase = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).Phase ?? (value as Record<string, unknown>).phase
    : undefined;
  return typeof phase === 'string' && ['succeeded', 'failed', 'cancelled', 'interrupted', 'dry_run'].includes(phase.toLowerCase());
}

function operationError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  const remote = (error.details as { code?: unknown } | undefined)?.code;
  if (remote === 'OPERATION_NOT_FOUND') return new ToolDomainError('OPERATION_NOT_FOUND', error.message, error.details);
  if (remote === 'CANCELLATION_UNSUPPORTED') return new ToolDomainError('VALIDATION_FAILED', error.message, error.details);
  if (remote === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  return new ToolDomainError('INTERNAL_ERROR', error.message, error.details);
}

/**
 * A process-local admission gate for expensive starts. The editor remains the
 * source of truth for backend busy state; this avoids a burst of callers from
 * creating queued work in the same project. It does not retry a mutation.
 */
export class HeavyOperationRateLimiter {
  private readonly active = new Map<string, number>();
  constructor(private readonly maxPerProject = 1) {}

  acquire(ctx: ProjectMeta): () => void {
    const key = process.platform === 'win32' ? path.resolve(ctx.projectPath).toLowerCase() : path.resolve(ctx.projectPath);
    const current = this.active.get(key) ?? 0;
    if (current >= this.maxPerProject) {
      throw new ToolDomainError('RATE_LIMITED', `Heavy operation limit (${this.maxPerProject}) is active for this project. Poll or cancel the existing operation before starting another.`);
    }
    this.active.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(key) ?? 1) - 1;
      if (next <= 0) this.active.delete(key); else this.active.set(key, next);
    };
  }
}

export const heavyOperationRateLimiter = new HeavyOperationRateLimiter();

/** Runs only a short start RPC through the limiter; callers must not retry it. */
export async function startHeavyOperation<T>(ctx: ProjectMeta, start: () => Promise<T>): Promise<T> {
  const release = heavyOperationRateLimiter.acquire(ctx);
  try { return await start(); }
  finally { release(); }
}

export async function handleOperationGetStatus(args: z.infer<typeof OperationGetStatusSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const result = await callEditorBridge<"operation.status", { OperationId: string }, OperationHandle>(ctx, 'operation.status', { OperationId: args.operation_id }, { minimumBridgeVersion: 11 });
    return toolResult(JSON.stringify({ operation: result.data, bridge: result.bridge }, null, 2), {
      mode: 'editor-connected', data: { operation: result.data, bridge: result.bridge }, warnings: result.warnings,
    });
  } catch (error) { return toolError(operationError(error)); }
}

export async function handleOperationCancel(args: z.infer<typeof OperationCancelSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const result = await callEditorBridge<"operation.cancel", { OperationId: string }, OperationHandle>(ctx, 'operation.cancel', { OperationId: args.operation_id }, { minimumBridgeVersion: 11 });
    return toolResult(JSON.stringify({ operation: result.data, bridge: result.bridge }, null, 2), {
      mode: 'editor-connected', data: { operation: result.data, bridge: result.bridge }, warnings: result.warnings,
      changes: [{ kind: 'operation.cancel', operationId: args.operation_id }],
    });
  } catch (error) { return toolError(operationError(error)); }
}
