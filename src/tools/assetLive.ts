import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { inspectEditorBridge } from './serverStatus.js';
import { ListAssetsSchema, handleListAssets } from './assets.js';
import { GetAssetInfoSchema, handleGetAssetInfo } from './assetInfo.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const ProjectContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !normalized.startsWith('Content/') ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative path under Content/ without traversal.' });
  }
});
const ProjectContentFolder = z.string().min(7).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (
    normalized !== value ||
    !(normalized === 'Content' || normalized.startsWith('Content/')) ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative Content folder without traversal.' });
  }
});
const AssetSelectorShape = {
  asset_id: FlaxId.optional(),
  path: ProjectContentPath.optional(),
};

function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

export const AssetSearchSchema = z.object({
  query: z.string().min(1).max(256).optional(),
  path: z.string().min(1).max(512).optional().describe('Case-insensitive project-relative asset-path substring.'),
  type: z.string().min(1).max(256).optional().describe('Exact Flax type name or its final segment, such as Material.'),
  extension: z.string().regex(/^\.[A-Za-z0-9]{1,31}$/).optional(),
  guid: FlaxId.optional(),
  folder: ProjectContentFolder.optional(),
  has_missing_dependency: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected an opaque asset cursor.').optional(),
}).strict();

export const AssetGetSchema = z.object(AssetSelectorShape).strict().superRefine(exactlyOneSelector);

export const AssetDependenciesSchema = z.object({
  ...AssetSelectorShape,
  transitive: z.boolean().optional().default(false),
  max_depth: z.number().int().min(1).max(16).optional().default(1),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected an opaque asset cursor.').optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  if (!value.transitive && value.max_depth !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max_depth'], message: 'Direct dependency queries require max_depth: 1.' });
  }
});

export const AssetFindReferencesSchema = z.object({
  ...AssetSelectorShape,
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected an opaque asset cursor.').optional(),
}).strict().superRefine(exactlyOneSelector);

interface BridgeAssetResult {
  [key: string]: unknown;
  Warnings?: unknown;
}

function bridgeError(error: unknown): ToolDomainError {
  if (!(error instanceof BridgeRpcError)) {
    return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') {
    return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  }
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    const code = remote?.code;
    if (code === 'ASSET_NOT_FOUND') return new ToolDomainError('ASSET_NOT_FOUND', error.message, remote?.details);
    if (code === 'CURSOR_INVALID') return new ToolDomainError('CURSOR_INVALID', error.message, remote?.details);
    if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'RESPONSE_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, remote?.details);
    if (code === 'UNSUPPORTED_FLAX_VERSION') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function assetCall(method: BridgeMethod, params: Record<string, unknown>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge<BridgeMethod, Record<string, unknown>, BridgeAssetResult>(ctx, method, params, { minimumBridgeVersion: 8 });
    const bridgeWarnings = Array.isArray(response.data?.Warnings)
      ? response.data.Warnings.filter((warning): warning is string => typeof warning === 'string')
      : [];
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: response.mode,
      data,
      warnings: bridgeWarnings,
    });
  } catch (error) {
    return toolError(bridgeError(error));
  }
}

export const handleAssetSearch = (args: z.infer<typeof AssetSearchSchema>, ctx: ProjectMeta) =>
  assetCall('asset.search', {
    Query: args.query,
    Path: args.path,
    Type: args.type,
    Extension: args.extension,
    Guid: args.guid,
    Folder: args.folder,
    HasMissingDependency: args.has_missing_dependency,
    Limit: args.limit,
    Cursor: args.cursor,
  }, ctx);

export const handleAssetGet = (args: z.infer<typeof AssetGetSchema>, ctx: ProjectMeta) =>
  assetCall('asset.get', { AssetId: args.asset_id, Path: args.path }, ctx);

export const handleAssetDependencies = (args: z.infer<typeof AssetDependenciesSchema>, ctx: ProjectMeta) =>
  assetCall('asset.dependencies', {
    AssetId: args.asset_id,
    Path: args.path,
    Transitive: args.transitive,
    MaxDepth: args.max_depth,
    Limit: args.limit,
    Cursor: args.cursor,
  }, ctx);

export const handleAssetFindReferences = (args: z.infer<typeof AssetFindReferencesSchema>, ctx: ProjectMeta) =>
  assetCall('asset.find_references', {
    AssetId: args.asset_id,
    Path: args.path,
    Transitive: false,
    MaxDepth: 1,
    Limit: args.limit,
    Cursor: args.cursor,
  }, ctx);

async function supportsLiveAssetRegistry(ctx: ProjectMeta): Promise<boolean> {
  const bridge = await inspectEditorBridge(ctx);
  return bridge.connected && bridge.protocolVersion === '1' && Number(bridge.bridgeVersion) >= 8;
}

function toContentFolder(directory: string | undefined): string | undefined {
  if (!directory) return undefined;
  return directory === 'Content' || directory.startsWith('Content/') ? directory : `Content/${directory}`;
}

/** Legacy alias: use the live registry only for filters with exactly equivalent semantics. */
export async function handleListAssetsCompatibility(
  args: z.infer<typeof ListAssetsSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  if (args.type === 'all' || args.type === 'scene') {
    if (await supportsLiveAssetRegistry(ctx)) {
      return handleAssetSearch(AssetSearchSchema.parse({
        folder: toContentFolder(args.directory),
        extension: args.type === 'scene' ? '.scene' : undefined,
      }), ctx);
    }
  }
  return handleListAssets(args, ctx);
}

/** Legacy alias: bare filenames retain the offline resolver's historical behavior. */
export async function handleGetAssetInfoCompatibility(
  args: z.infer<typeof GetAssetInfoSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  if (args.path.startsWith('Content/') && await supportsLiveAssetRegistry(ctx)) {
    return handleAssetGet(AssetGetSchema.parse({ path: args.path }), ctx);
  }
  return handleGetAssetInfo(args, ctx);
}
