import { z } from 'zod';
import { appendAssetOrganizationAudit } from '../audit.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeRpcError, type BridgeMethod } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const IdempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, underscore, colon, or hyphen.');
const IndexRevision = z.string().regex(/^[0-9a-fA-F]{64}$/, 'Expected a 64-character asset index SHA-256 digest.');

const ProjectContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !value.startsWith('Content/') ||
    value.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a normalized project-relative asset path under Content/ without traversal.' });
  }
});

const ProjectContentFolder = z.string().min(7).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (
    normalized !== value ||
    !(value === 'Content' || value.startsWith('Content/')) ||
    value.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a normalized existing Content-relative destination folder without traversal.' });
  }
});

const AssetName = z.string().min(1).max(128).superRefine((value, ctx) => {
  if (
    value === '.' || value === '..' || value.includes('.') ||
    /[<>:"/\\|?*\0\r\n]/.test(value) || /[ .]$/.test(value)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Name must be a filename without an extension, path separators, or platform-reserved characters.' });
  }
});

const SelectorShape = { asset_id: FlaxId.optional(), path: ProjectContentPath.optional() };
const CommonWriteShape = {
  collision_policy: z.enum(['error', 'rename']).optional().default('error'),
  dry_run: z.boolean().optional().default(false),
  expected_path: ProjectContentPath.optional(),
  expected_index_revision: IndexRevision.optional(),
  idempotency_key: IdempotencyKey.optional(),
};

function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

export const AssetMoveSchema = z.object({
  ...SelectorShape,
  destination: ProjectContentFolder,
  ...CommonWriteShape,
}).strict().superRefine(exactlyOneSelector);

export const AssetRenameSchema = z.object({
  ...SelectorShape,
  name: AssetName,
  ...CommonWriteShape,
}).strict().superRefine(exactlyOneSelector);

export const AssetDuplicateSchema = z.object({
  ...SelectorShape,
  destination: ProjectContentFolder,
  name: AssetName,
  ...CommonWriteShape,
}).strict().superRefine(exactlyOneSelector);

/**
 * `asset_delete` is deliberately a quarantine move, never a permanent delete.
 * A caller must compare the reference count from a dry run to the current
 * registry before requesting the visible mutation.
 */
export const AssetDeleteSchema = z.object({
  ...SelectorShape,
  quarantine_destination: ProjectContentFolder,
  collision_policy: z.enum(['error', 'rename']).optional().default('error'),
  dry_run: z.boolean().optional().default(true),
  expected_path: ProjectContentPath.optional(),
  expected_index_revision: IndexRevision.optional(),
  confirm_reference_count: z.number().int().min(0).max(10_000).optional(),
  require_unreferenced: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
  idempotency_key: IdempotencyKey.optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  if (!value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm:true to move the asset into quarantine.' });
  }
  if (!value.dry_run && value.confirm_reference_count === undefined && !value.require_unreferenced) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm_reference_count'], message: 'Provide confirm_reference_count from a recent dry run or set require_unreferenced:true.' });
  }
});

interface AssetMetadata {
  Id?: string | null;
  Path?: string;
}

interface AssetOrganizeResult {
  Operation?: string;
  Source?: AssetMetadata;
  Result?: AssetMetadata;
  IndexRevisionBefore?: string;
  IndexRevisionAfter?: string;
  DryRun?: boolean;
  Renamed?: boolean;
  GuidPreserved?: boolean;
  ExistingReferencesPreserved?: boolean;
  ReferencesRemainBoundToSource?: boolean;
  UndoSupported?: boolean;
  Atomicity?: string;
  ReferenceImpact?: { DirectReferenceCount?: number; Sample?: unknown[]; Truncated?: boolean; Scope?: string };
  Warnings?: unknown;
}

function organizeError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    const code = remote?.code;
    if (code === 'ASSET_NOT_FOUND' || code === 'FILE_EXISTS' || code === 'EDITOR_BUSY' || code === 'IDEMPOTENCY_KEY_REUSED' || code === 'ASSET_REVISION_CONFLICT' || code === 'ASSET_REFERENCE_CONFLICT' || code === 'ASSET_OPERATION_FAILED') {
      return new ToolDomainError(code, error.message, remote?.details);
    }
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

function warningsFrom(result: AssetOrganizeResult): string[] {
  return Array.isArray(result.Warnings) ? result.Warnings.filter((warning): warning is string => typeof warning === 'string') : [];
}

async function organize(
  operation: 'move' | 'rename' | 'duplicate' | 'delete',
  args: z.infer<typeof AssetMoveSchema> | z.infer<typeof AssetRenameSchema> | z.infer<typeof AssetDuplicateSchema> | z.infer<typeof AssetDeleteSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge<BridgeMethod, Record<string, unknown>, AssetOrganizeResult>(ctx, `asset.${operation}` as BridgeMethod, {
      AssetId: args.asset_id,
      Path: args.path,
      Destination: 'destination' in args ? args.destination : 'quarantine_destination' in args ? args.quarantine_destination : undefined,
      Name: 'name' in args ? args.name : undefined,
      CollisionPolicy: args.collision_policy,
      DryRun: args.dry_run,
      ExpectedPath: args.expected_path,
      ExpectedIndexRevision: args.expected_index_revision,
      ConfirmReferenceCount: 'confirm_reference_count' in args ? args.confirm_reference_count : undefined,
      RequireUnreferenced: 'require_unreferenced' in args && args.require_unreferenced ? true : undefined,
      Confirm: 'confirm' in args && args.confirm ? true : undefined,
      IdempotencyKey: args.idempotency_key,
    }, { minimumBridgeVersion: operation === 'delete' ? 13 : 10, deadlineMs: 30_000 });
    const result = response.data;
    const warnings = warningsFrom(result);
    const changed = !result.DryRun && result.Source?.Path !== result.Result?.Path;
    if (changed) {
      await appendAssetOrganizationAudit(ctx, {
        operation: `asset_${operation}`,
        target: result.Source?.Path ?? args.path ?? args.asset_id ?? '',
        result_path: result.Result?.Path ?? '',
        dry_run: false,
        success: true,
        guid_preserved: result.GuidPreserved === true,
        reference_count: result.ReferenceImpact?.DirectReferenceCount,
      });
    } else if (result.DryRun) {
      await appendAssetOrganizationAudit(ctx, {
        operation: `asset_${operation}`,
        target: result.Source?.Path ?? args.path ?? args.asset_id ?? '',
        result_path: result.Result?.Path ?? '',
        dry_run: true,
        success: true,
        guid_preserved: result.GuidPreserved === true,
        reference_count: result.ReferenceImpact?.DirectReferenceCount,
      });
    }
    const data = { result, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: 'editor-connected',
      data,
      warnings,
      changes: changed ? [{
        kind: `asset-${operation}`,
        source: result.Source?.Path,
        result: result.Result?.Path,
        guid_preserved: result.GuidPreserved === true,
        direct_reference_count: result.ReferenceImpact?.DirectReferenceCount ?? 0,
      }] : [],
    });
  } catch (error) {
    return toolError(organizeError(error));
  }
}

export const handleAssetMove = (args: z.infer<typeof AssetMoveSchema>, ctx: ProjectMeta) => organize('move', args, ctx);
export const handleAssetRename = (args: z.infer<typeof AssetRenameSchema>, ctx: ProjectMeta) => organize('rename', args, ctx);
export const handleAssetDuplicate = (args: z.infer<typeof AssetDuplicateSchema>, ctx: ProjectMeta) => organize('duplicate', args, ctx);
export const handleAssetDelete = (args: z.infer<typeof AssetDeleteSchema>, ctx: ProjectMeta) => organize('delete', args, ctx);
