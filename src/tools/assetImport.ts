import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assetImportPolicyForContext, chooseAssetImportDestination, verifyAssetImportDestination, verifyAssetImportSource } from '../assetImportPolicy.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import { startHeavyOperation } from '../operations.js';

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
  model_import_type: z.enum(['Model', 'SkinnedModel', 'Animation', 'Prefab']).optional(),
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
  model_import_type: z.enum(['Model', 'SkinnedModel', 'Animation', 'Prefab']).optional()
    .describe('Optional Flax model importer type override for FBX/OBJ reimports.'),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional(),
  ...WaitArgs,
}).strict().superRefine(exactlyOneSelector);

export const AssetOperationStatusSchema = z.object({ operation_id: OperationId }).strict();

export const AssetGetImportSettingsSchema = z.object({
  ...AssetSelectorShape,
}).strict().superRefine(exactlyOneSelector);

const TEXTURE_SETTING_KEYS = ['srgb', 'compress', 'max_size', 'scale', 'generate_mipmaps', 'never_stream'] as const;
const MODEL_SETTING_KEYS = [
  'scale', 'calculate_normals', 'smoothing_normals_angle', 'flip_normals', 'calculate_tangents',
  'smoothing_tangents_angle', 'reverse_winding_order', 'optimize_meshes', 'merge_meshes',
  'import_lods', 'import_vertex_colors', 'base_lod', 'lod_count',
] as const;
const AUDIO_SETTING_KEYS = ['format', 'quality', 'disable_streaming', 'is_3d', 'bit_depth'] as const;
const IMPORT_SETTINGS_ALLOWLIST = new Set<string>([...TEXTURE_SETTING_KEYS, ...MODEL_SETTING_KEYS, ...AUDIO_SETTING_KEYS]);

/** Node snake_case to exact bridge (C# option field) key mapping. */
const IMPORT_SETTINGS_BRIDGE_KEYS: Record<string, string> = {
  type: 'Type',
  srgb: 'sRGB',
  compress: 'Compress',
  max_size: 'MaxSize',
  scale: 'Scale',
  generate_mipmaps: 'GenerateMipMaps',
  never_stream: 'NeverStream',
  calculate_normals: 'CalculateNormals',
  smoothing_normals_angle: 'SmoothingNormalsAngle',
  flip_normals: 'FlipNormals',
  calculate_tangents: 'CalculateTangents',
  smoothing_tangents_angle: 'SmoothingTangentsAngle',
  reverse_winding_order: 'ReverseWindingOrder',
  optimize_meshes: 'OptimizeMeshes',
  merge_meshes: 'MergeMeshes',
  import_lods: 'ImportLODs',
  import_vertex_colors: 'ImportVertexColors',
  base_lod: 'BaseLOD',
  lod_count: 'LODCount',
  format: 'Format',
  quality: 'Quality',
  disable_streaming: 'DisableStreaming',
  is_3d: 'Is3D',
  bit_depth: 'BitDepth',
};

const IMPORT_SETTINGS_SNAKE_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(IMPORT_SETTINGS_BRIDGE_KEYS).map(([snake, pascal]) => [pascal, snake]),
);

export const AssetSetImportSettingsSchema = z.object({
  ...AssetSelectorShape,
  settings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
  dry_run: z.boolean().optional().default(false),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional(),
  ...WaitArgs,
}).strict().superRefine(exactlyOneSelector);

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
    const started = await startHeavyOperation(ctx, () => startImport({
      OperationId: operationId(args.operation_id),
      IdempotencyKey: args.idempotency_key,
      SourcePath: source.canonicalPath,
      SourceSizeBytes: source.sizeBytes,
      SourceLastWriteUnixMs: source.modifiedUnixMs,
      DestinationPath: destination.relativePath,
      CollisionPolicy: args.collision_policy,
      DryRun: args.dry_run,
      ModelImportType: args.model_import_type,
      AllowedImportRoots: policy.roots,
      MaxSourceBytes: policy.maxSourceBytes,
    }, ctx));
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
    const started = await startHeavyOperation(ctx, () => startReimport({
      OperationId: operationId(args.operation_id),
      IdempotencyKey: args.idempotency_key,
      AssetId: args.asset_id,
      Path: args.path,
      DryRun: args.dry_run,
      ModelImportType: args.model_import_type,
      AllowedImportRoots: policy.roots,
      MaxSourceBytes: policy.maxSourceBytes,
    }, ctx));
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

interface ImportSettingsBridgeValue {
  Boolean?: boolean | null;
  Integer?: number | null;
  Number?: number | null;
  Text?: string | null;
}

interface ImportSettingsBridgeEntry {
  Key: string;
  Value: ImportSettingsBridgeValue | null;
}

interface ImportSettingsBridgeResult {
  Asset: unknown;
  Type: string;
  Restored: boolean;
  Settings: ImportSettingsBridgeEntry[];
}

interface SetImportSettingsBridgeResult {
  Operation: AssetOperation;
  WouldChange: boolean;
  Before: ImportSettingsBridgeResult | null;
  After: ImportSettingsBridgeResult | null;
}

type ImportSettingsScalar = boolean | number | string;

function projectImportSettingsEntry(entry: ImportSettingsBridgeEntry): [string, ImportSettingsScalar] {
  const key = IMPORT_SETTINGS_SNAKE_KEYS[entry.Key] ?? entry.Key;
  const value = entry.Value ?? {};
  if (typeof value.Boolean === 'boolean') return [key, value.Boolean];
  if (typeof value.Integer === 'number') return [key, value.Integer];
  if (typeof value.Number === 'number') return [key, value.Number];
  if (typeof value.Text === 'string') return [key, value.Text];
  throw new ToolDomainError('INTERNAL_ERROR', `Bridge import-settings entry "${entry.Key}" has no scalar value.`);
}

function projectImportSettings(result: ImportSettingsBridgeResult | null): { asset: unknown; type: string; restored: boolean; settings: Record<string, ImportSettingsScalar> } | null {
  if (!result) return null;
  if (!['texture', 'model', 'audio'].includes(result.Type)) {
    throw new ToolDomainError('VALIDATION_FAILED', `Unsupported import-settings asset type "${result.Type}". Only texture, model, and audio assets are supported.`);
  }
  const settings: Record<string, ImportSettingsScalar> = {};
  for (const entry of result.Settings ?? []) {
    const [key, value] = projectImportSettingsEntry(entry);
    settings[key] = value;
  }
  return { asset: result.Asset, type: result.Type, restored: result.Restored === true, settings };
}

export async function handleAssetGetImportSettings(args: z.infer<typeof AssetGetImportSettingsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge<'asset.get_import_settings', Record<string, unknown>, ImportSettingsBridgeResult>(
      ctx, 'asset.get_import_settings', { AssetId: args.asset_id, Path: args.path }, { minimumBridgeVersion: 32, deadlineMs: 15_000 });
    const data = projectImportSettings(response.data);
    return toolResult(JSON.stringify({ ...data, bridge: response.bridge }, null, 2), {
      mode: 'editor-connected',
      data: { ...data, bridge: response.bridge },
    });
  } catch (error) {
    return toolError(importError(error));
  }
}

function validatedSettingsEntries(settings: Record<string, unknown>): Array<{ Key: string; Value: Record<string, unknown> }> {
  if (Array.isArray(settings) || typeof settings !== 'object' || settings === null) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Settings must be an object with allowlisted scalar keys.');
  }
  const keys = Object.keys(settings);
  if (keys.length < 1 || keys.length > 16) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Settings must contain between 1 and 16 entries.');
  }
  const unknown = keys.filter(key => !IMPORT_SETTINGS_ALLOWLIST.has(key));
  if (unknown.length > 0) {
    throw new ToolDomainError(
      'VALIDATION_FAILED',
      `Unknown import setting(s): ${unknown.join(', ')}. Allowed texture keys: ${TEXTURE_SETTING_KEYS.join(', ')}. ` +
      `Allowed model keys: ${MODEL_SETTING_KEYS.join(', ')}. Allowed audio keys: ${AUDIO_SETTING_KEYS.join(', ')}.`,
    );
  }
  return keys.map(key => {
    const value = (settings as Record<string, unknown>)[key];
    const bridgeKey = IMPORT_SETTINGS_BRIDGE_KEYS[key];
    if (typeof value === 'boolean') return { Key: bridgeKey, Value: { Boolean: value } };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ToolDomainError('VALIDATION_FAILED', `Import setting "${key}" must be a finite number.`);
      return Number.isInteger(value)
        ? { Key: bridgeKey, Value: { Integer: value } }
        : { Key: bridgeKey, Value: { Number: value } };
    }
    if (typeof value === 'string') {
      if (value.length > 64) throw new ToolDomainError('VALIDATION_FAILED', `Import setting "${key}" must be at most 64 characters.`);
      return { Key: bridgeKey, Value: { Text: value } };
    }
    throw new ToolDomainError('VALIDATION_FAILED', `Import setting "${key}" must be a boolean, number, or string scalar.`);
  });
}

async function startSetImportSettings(params: Record<string, unknown>, ctx: ProjectMeta): Promise<{ data: SetImportSettingsBridgeResult; bridge: unknown }> {
  const response = await callEditorBridge<'asset.set_import_settings', Record<string, unknown>, SetImportSettingsBridgeResult>(
    ctx, 'asset.set_import_settings', params, { minimumBridgeVersion: 32, deadlineMs: 30_000 });
  return { data: response.data, bridge: response.bridge };
}

export async function handleAssetSetImportSettings(args: z.infer<typeof AssetSetImportSettingsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const entries = validatedSettingsEntries(args.settings as Record<string, unknown>);
    const policy = assetImportPolicyForContext(ctx);
    if (policy.roots.length === 0) {
      throw new ToolDomainError('IMPORT_SOURCE_NOT_ALLOWED', 'Asset import-settings changes are disabled because no --asset-import-root is configured.');
    }
    const started = await startHeavyOperation(ctx, () => startSetImportSettings({
      OperationId: operationId(args.operation_id),
      IdempotencyKey: args.idempotency_key,
      AssetId: args.asset_id,
      Path: args.path,
      Settings: entries,
      DryRun: args.dry_run,
      AllowedImportRoots: policy.roots,
      MaxSourceBytes: policy.maxSourceBytes,
    }, ctx));
    const before = projectImportSettings(started.data.Before);
    const after = projectImportSettings(started.data.After);
    if (args.dry_run) {
      const data = { would_change: started.data.WouldChange === true, before, after };
      return toolResult(JSON.stringify({ ...data, bridge: started.bridge }, null, 2), { mode: 'editor-connected', data });
    }
    // Settings writes share the "reimport" operation records, so
    // asset_reimport_status polls them like ordinary reimports.
    const waited = await maybeWait('reimport', started.data.Operation, args.wait, args.timeout_ms, ctx);
    return response('reimport', waited.data, waited.bridge ?? started.bridge, !terminal(waited.data));
  } catch (error) {
    return toolError(importError(error));
  }
}
