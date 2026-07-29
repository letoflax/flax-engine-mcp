import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assetImportPolicyForContext, chooseAssetImportDestination, verifyAssetImportDestination, verifyAssetImportSource } from '../assetImportPolicy.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const OperationId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character operation ID.');
const IdempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, underscore, colon, or hyphen.');
const ProjectContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized !== value || !normalized.startsWith('Content/') || normalized.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative path under Content/ without traversal.' });
  }
});

const WaitArgs = {
  wait: z.boolean().optional().default(false),
  timeout_ms: z.number().int().min(250).max(30_000).optional().default(10_000),
};

export const AssetImportSchema = z.object({
  source_path: z.string().min(1).max(1024),
  destination: ProjectContentPath,
  collision_policy: z.enum(['error', 'rename']).optional().default('error'),
  dry_run: z.boolean().optional().default(false),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional(),
  ...WaitArgs,
}).strict();

const AssetSelectorShape = { asset_id: FlaxId.optional(), path: ProjectContentPath.optional() };
function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

export const AssetReimportSchema = z.object({
  ...AssetSelectorShape,
  dry_run: z.boolean().optional().default(false),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional(),
  ...WaitArgs,
}).strict().superRefine(exactlyOneSelector);

export const AssetOperationStatusSchema = z.object({ operation_id: OperationId }).strict();

type AssetOperation = Record<string, unknown> & { OperationId?: string; Phase?: string; ErrorCode?: string; Error?: string };

function importError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  const localCode = (error as { code?: unknown } | null)?.code;
  if (localCode === 'IMPORT_SOURCE_NOT_ALLOWED' || localCode === 'FILE_EXISTS' || localCode === 'IMPORT_FAILED' || localCode === 'VALIDATION_FAILED') {
    return new ToolDomainError(localCode, error instanceof Error ? error.message : String(error));
  }
  if (!(error instanceof BridgeRpcError)) {
    return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    const code = remote?.code;
    if (code === 'IMPORT_SOURCE_NOT_ALLOWED' || code === 'IMPORT_FAILED' || code === 'FILE_EXISTS' || code === 'EDITOR_BUSY' || code === 'OPERATION_NOT_FOUND' || code === 'IDEMPOTENCY_KEY_REUSED') {
      return new ToolDomainError(code, error.message, remote?.details);
    }
    if (code === 'ASSET_NOT_FOUND') return new ToolDomainError('ASSET_NOT_FOUND', error.message, remote?.details);
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

function operationId(value: string | undefined): string { return value ?? randomUUID().replaceAll('-', ''); }
function terminal(value: AssetOperation): boolean { return ['succeeded', 'failed', 'dry_run'].includes(String(value.Phase).toLowerCase()); }
function safeOperation(value: AssetOperation): AssetOperation {
  // The bridge intentionally never returns SourcePath or configured roots. Keep
  // this defensive projection in case a future bridge DTO grows such fields.
  const { SourcePath: _source, AllowedImportRoots: _roots, SourceSizeBytes: _size, SourceLastWriteUnixMs: _mtime, ...safe } = value as AssetOperation & {
    SourcePath?: unknown; AllowedImportRoots?: unknown; SourceSizeBytes?: unknown; SourceLastWriteUnixMs?: unknown;
  };
  return safe;
}

async function startImport(params: Record<string, unknown>, ctx: ProjectMeta): Promise<{ data: AssetOperation; bridge: unknown }> {
  const response = await callEditorBridge<'asset.import_start', Record<string, unknown>, AssetOperation>(ctx, 'asset.import_start', params, { minimumBridgeVersion: 9, deadlineMs: 30_000 });
  return { data: safeOperation(response.data), bridge: response.bridge };
}

async function startReimport(params: Record<string, unknown>, ctx: ProjectMeta): Promise<{ data: AssetOperation; bridge: unknown }> {
  const response = await callEditorBridge<'asset.reimport_start', Record<string, unknown>, AssetOperation>(ctx, 'asset.reimport_start', params, { minimumBridgeVersion: 9, deadlineMs: 30_000 });
  return { data: safeOperation(response.data), bridge: response.bridge };
}

async function getStatus(kind: 'import' | 'reimport', operation: string, ctx: ProjectMeta): Promise<{ data: AssetOperation; bridge: unknown }> {
  const method = kind === 'import' ? 'asset.import_status' : 'asset.reimport_status';
  const response = await callEditorBridge<typeof method, { OperationId: string }, AssetOperation>(ctx, method, { OperationId: operation }, { minimumBridgeVersion: 9, deadlineMs: 15_000 });
  return { data: safeOperation(response.data), bridge: response.bridge };
}

async function maybeWait(
  kind: 'import' | 'reimport',
  initial: AssetOperation,
  wait: boolean,
  timeoutMs: number,
  ctx: ProjectMeta,
): Promise<{ data: AssetOperation; bridge?: unknown }> {
  if (!wait || terminal(initial)) return { data: initial };
  const id = initial.OperationId;
  if (typeof id !== 'string') throw new ToolDomainError('IMPORT_FAILED', 'Bridge import response omitted an operation ID.');
  const end = Date.now() + timeoutMs;
  let last: AssetOperation = initial;
  let bridge: unknown;
  // Status requests are short and are deliberately bounded; a caller can always
  // resume polling with the returned operation ID instead of holding a request.
  while (Date.now() < end) {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    const next = await getStatus(kind, id, ctx);
    last = next.data;
    bridge = next.bridge;
    if (terminal(last)) return { data: last, bridge };
  }
  return { data: last, bridge };
}

function response(kind: 'import' | 'reimport', data: AssetOperation, bridge: unknown, pending = false): ToolResponse {
  if (String(data.Phase).toLowerCase() === 'failed') {
    return toolError(new ToolDomainError(
      data.ErrorCode === 'IMPORT_SOURCE_NOT_ALLOWED' ? 'IMPORT_SOURCE_NOT_ALLOWED'
        : data.ErrorCode === 'FILE_EXISTS' ? 'FILE_EXISTS'
          : 'IMPORT_FAILED',
      typeof data.Error === 'string' ? data.Error : `${kind} asset operation failed.`,
      { operationId: data.OperationId },
    ));
  }
  const output = { operation: data, bridge, ...(pending ? { pending: true } : {}) };
  return toolResult(JSON.stringify(output, null, 2), {
    mode: 'editor-connected',
    data: output,
    warnings: pending ? ['Import is still running; poll the matching asset operation status tool with operation_id.'] : [],
    changes: terminal(data) && String(data.Phase).toLowerCase() === 'succeeded' ? [{ kind: `${kind}-asset`, operationId: data.OperationId }] : [],
  });
}

export async function handleAssetImport(args: z.infer<typeof AssetImportSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const policy = assetImportPolicyForContext(ctx);
    const source = await verifyAssetImportSource(args.source_path, policy);
    const requested = await verifyAssetImportDestination(args.destination, ctx);
    const destination = await chooseAssetImportDestination(requested, args.collision_policy);
    const started = await startImport({
      OperationId: operationId(args.operation_id),
      IdempotencyKey: args.idempotency_key,
      SourcePath: source.canonicalPath,
      SourceSizeBytes: source.sizeBytes,
      SourceLastWriteUnixMs: source.modifiedUnixMs,
      DestinationPath: destination.relativePath,
      CollisionPolicy: args.collision_policy,
      DryRun: args.dry_run,
      AllowedImportRoots: policy.roots,
      MaxSourceBytes: policy.maxSourceBytes,
    }, ctx);
    const waited = await maybeWait('import', started.data, args.wait, args.timeout_ms, ctx);
    return response('import', waited.data, waited.bridge ?? started.bridge, !terminal(waited.data));
  } catch (error) {
    return toolError(importError(error));
  }
}

export async function handleAssetReimport(args: z.infer<typeof AssetReimportSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const policy = assetImportPolicyForContext(ctx);
    if (policy.roots.length === 0) {
      throw new ToolDomainError('IMPORT_SOURCE_NOT_ALLOWED', 'Asset reimport is disabled because no --asset-import-root is configured.');
    }
    const started = await startReimport({
      OperationId: operationId(args.operation_id),
      IdempotencyKey: args.idempotency_key,
      AssetId: args.asset_id,
      Path: args.path,
      DryRun: args.dry_run,
      AllowedImportRoots: policy.roots,
      MaxSourceBytes: policy.maxSourceBytes,
    }, ctx);
    const waited = await maybeWait('reimport', started.data, args.wait, args.timeout_ms, ctx);
    return response('reimport', waited.data, waited.bridge ?? started.bridge, !terminal(waited.data));
  } catch (error) {
    return toolError(importError(error));
  }
}

export async function handleAssetImportStatus(args: z.infer<typeof AssetOperationStatusSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const result = await getStatus('import', args.operation_id, ctx);
    return response('import', result.data, result.bridge, !terminal(result.data));
  } catch (error) {
    return toolError(importError(error));
  }
}

export async function handleAssetReimportStatus(args: z.infer<typeof AssetOperationStatusSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const result = await getStatus('reimport', args.operation_id, ctx);
    return response('reimport', result.data, result.bridge, !terminal(result.data));
  } catch (error) {
    return toolError(importError(error));
  }
}
