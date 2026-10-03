import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assetImportPolicyForContext, chooseAssetImportDestination, verifyAssetImportDestination, verifyAssetImportSource } from '../assetImportPolicy.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import { startHeavyOperation } from '../operations.js';
import { reportProgress } from '../progress.js';
import { BRIDGE_V34 } from './liveToolSupport.js';

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

const ModelImportType = z.enum(['Model', 'SkinnedModel', 'Animation', 'Prefab']);

export const MAX_ASSET_IMPORT_ITEMS = 32;

const AssetImportItemSchema = z.object({
  source_path: z.string().min(1).max(1024),
  destination: ProjectContentPath,
  model_import_type: ModelImportType.optional(),
}).strict();

export const AssetImportSchema = z.object({
  source_path: z.string().min(1).max(1024).optional()
    .describe('Single-item form: external source file under a configured --asset-import-root. Mutually exclusive with items.'),
  destination: ProjectContentPath.optional()
    .describe('Single-item form: Content/...flax output path. Mutually exclusive with items.'),
  items: z.array(AssetImportItemSchema).min(1).max(MAX_ASSET_IMPORT_ITEMS).optional()
    .describe('Batch form (1-32 items, mutually exclusive with source_path/destination/model_import_type/operation_id): imported one after another, each with its own generated operation id. collision_policy, dry_run, confirm and wait apply to every item. Returns per-item results and an aggregate status (succeeded, partial, pending or failed).'),
  collision_policy: z.enum(['error', 'rename', 'replace']).optional().default('error')
    .describe('error (default) refuses an existing destination, rename picks <name>-N.flax, replace reimports into the existing asset keeping its identity and requires confirm:true (bridge v34).'),
  confirm: z.boolean().optional()
    .describe('Required with collision_policy:replace (unless dry_run:true).'),
  dry_run: z.boolean().optional().default(false),
  model_import_type: ModelImportType.optional(),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional()
    .describe('With items, item N uses "<key>:<N>" (the key may then be at most 120 characters).'),
  ...WaitArgs,
}).strict().superRefine((value, ctx) => {
  if (value.items !== undefined) {
    for (const key of ['source_path', 'destination', 'model_import_type', 'operation_id'] as const) {
      if (value[key] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} cannot be combined with items; put it on each item (operation ids are generated per item).` });
      }
    }
    if (value.idempotency_key !== undefined && value.idempotency_key.length > 120) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idempotency_key'], message: 'With items the idempotency_key is limited to 120 characters.' });
    }
    return;
  }
  if (value.source_path === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_path'], message: 'Provide source_path and destination, or items.' });
  if (value.destination === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destination'], message: 'Provide source_path and destination, or items.' });
});

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

type ImportSettingWireField = 'Boolean' | 'Integer' | 'Number' | 'Text';
interface ImportSettingSpec {
  /** Exact bridge (C# option field) key. */
  key: string;
  /** Which exactly-one-of scalar slot of the bridge value carries it. */
  field: ImportSettingWireField;
  schema: z.ZodTypeAny;
}

const flag = (key: string, description: string): ImportSettingSpec =>
  ({ key, field: 'Boolean', schema: z.boolean().describe(description) });
const integer = (key: string, min: number, max: number, description: string): ImportSettingSpec =>
  ({ key, field: 'Integer', schema: z.number().int().min(min).max(max).describe(description) });
// Float-typed options always travel as Number. Sending a whole value such as
// 1e19 as Integer would overflow the bridge's 64-bit slot while it
// deserializes the request, which surfaces as INTERNAL_ERROR.
const float = (key: string, min: number, max: number, description: string): ImportSettingSpec =>
  ({ key, field: 'Number', schema: z.number().min(min).max(max).describe(description) });
const choice = (key: string, values: [string, ...string[]], description: string): ImportSettingSpec =>
  ({ key, field: 'Text', schema: z.enum(values).describe(description) });

/**
 * The writable import settings: snake_case tool key to bridge key, wire slot,
 * and published type/range. Numeric ranges are the Flax 1.12 engine limits
 * (TextureTool.h / ModelTool.h / AudioTool.h) or the bridge's tighter policy;
 * the bridge enforces the same ranges per asset type. `scale` is shared by
 * textures and models, so its schema is the union of both ranges.
 */
const IMPORT_SETTING_SPECS = {
  srgb: flag('sRGB', 'Texture: load the source image as sRGB.'),
  compress: flag('Compress', 'Texture: compress the texture.'),
  max_size: integer('MaxSize', 1, 16384, 'Texture: maximum width and height in pixels, 1-16384.'),
  scale: float('Scale', 0.0001, 1000, 'Texture: size scale, 0.0001-8. Model: import scale, 0.001-1000.'),
  generate_mipmaps: flag('GenerateMipMaps', 'Texture: generate the mip map chain.'),
  never_stream: flag('NeverStream', 'Texture: disable dynamic texture streaming.'),
  calculate_normals: flag('CalculateNormals', 'Model: recalculate normals.'),
  smoothing_normals_angle: float('SmoothingNormalsAngle', 0, 175, 'Model: normals smoothing angle in degrees, 0-175.'),
  flip_normals: flag('FlipNormals', 'Model: flip normals.'),
  calculate_tangents: flag('CalculateTangents', 'Model: recalculate tangents.'),
  smoothing_tangents_angle: float('SmoothingTangentsAngle', 0, 45, 'Model: tangents smoothing angle in degrees, 0-45.'),
  reverse_winding_order: flag('ReverseWindingOrder', 'Model: reverse the triangle winding order.'),
  optimize_meshes: flag('OptimizeMeshes', 'Model: optimize meshes.'),
  merge_meshes: flag('MergeMeshes', 'Model: merge meshes that share a material.'),
  import_lods: flag('ImportLODs', 'Model: import LODs from the source file.'),
  import_vertex_colors: flag('ImportVertexColors', 'Model: import vertex colors.'),
  base_lod: integer('BaseLOD', 0, 5, 'Model: base LOD index, 0-5.'),
  lod_count: integer('LODCount', 1, 6, 'Model: LOD count, 1-6.'),
  format: choice('Format', ['Raw', 'Vorbis'], 'Audio: stored audio format.'),
  quality: float('Quality', 0, 1, 'Audio: compression quality, 0-1.'),
  disable_streaming: flag('DisableStreaming', 'Audio: load the whole clip instead of streaming.'),
  is_3d: flag('Is3D', 'Audio: import as mono spatial (3D) audio.'),
  bit_depth: choice('BitDepth', ['_8', '_16', '_24', '_32'], 'Audio: sample bit depth (8, 16, 24, or 32 bits).'),
} satisfies Record<string, ImportSettingSpec>;

const IMPORT_SETTING_ENTRIES = Object.entries(IMPORT_SETTING_SPECS) as Array<[string, ImportSettingSpec]>;

/** Bridge (C# option field) key back to the snake_case tool key; `Type` is read-only. */
const IMPORT_SETTINGS_SNAKE_KEYS: Record<string, string> = {
  Type: 'type',
  ...Object.fromEntries(IMPORT_SETTING_ENTRIES.map(([snake, spec]) => [spec.key, snake])),
};

const ImportSettingsSchema = z.object(
  Object.fromEntries(IMPORT_SETTING_ENTRIES.map(([snake, spec]) => [snake, spec.schema.optional()])),
).strict().refine(
  value => Object.values(value).some(entry => entry !== undefined),
  { message: 'Provide at least one import setting.' },
).describe('Import options to change; every other option keeps its current value. Use only the keys of the asset type (texture, model, or audio): a key of another type fails VALIDATION_FAILED.');

export const AssetSetImportSettingsSchema = z.object({
  ...AssetSelectorShape,
  settings: ImportSettingsSchema,
  dry_run: z.boolean().optional().default(false),
  operation_id: OperationId.optional(),
  idempotency_key: IdempotencyKey.optional(),
  ...WaitArgs,
}).strict().superRefine(exactlyOneSelector);

type AssetOperation = Record<string, unknown> & { OperationId?: string; Phase?: string; ErrorCode?: string; Error?: string };

/**
 * Local policy errors carry a plain `code`; every bridge failure goes through the shared mapper
 * (which already knows the import codes IMPORT_SOURCE_NOT_ALLOWED, IMPORT_FAILED, FILE_EXISTS,
 * OPERATION_NOT_FOUND and the generic transport/lease/headless ones).
 */
function importError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) {
    const localCode = (error as { code?: unknown } | null)?.code;
    if (localCode === 'IMPORT_SOURCE_NOT_ALLOWED' || localCode === 'FILE_EXISTS' || localCode === 'IMPORT_FAILED' || localCode === 'VALIDATION_FAILED') {
      return new ToolDomainError(localCode, error instanceof Error ? error.message : String(error));
    }
  }
  return mapBridgeError(error);
}

/** A timed-out start may still have run in the Editor: hand the caller the id to poll asset_import_status with. */
function withOperationId(error: ToolDomainError, operation: string): ToolDomainError {
  if (error.code !== 'TIMEOUT') return error;
  const existing = error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : error.details === undefined ? {} : { details: error.details };
  return new ToolDomainError('TIMEOUT', error.message, { ...existing, operation_id: operation, hint: 'The import may still have started; poll asset_import_status with operation_id.' });
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

async function startImport(params: Record<string, unknown>, ctx: ProjectMeta, minimumBridgeVersion = 9): Promise<{ data: AssetOperation; bridge: unknown }> {
  const response = await callEditorBridge<'asset.import_start', Record<string, unknown>, AssetOperation>(ctx, 'asset.import_start', params, { minimumBridgeVersion, deadlineMs: 30_000 });
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
    reportProgress(`Waiting for asset ${kind} (${String(last.Phase ?? 'running')})`, timeoutMs);
    if (terminal(last)) return { data: last, bridge };
  }
  return { data: last, bridge };
}

/** Error codes a failed operation record may carry that map one-to-one onto tool error codes. */
const OPERATION_ERROR_CODES = ['IMPORT_SOURCE_NOT_ALLOWED', 'FILE_EXISTS', 'VALIDATION_FAILED', 'EDITOR_BUSY', 'ASSET_NOT_FOUND'] as const;

function operationFailure(kind: 'import' | 'reimport', data: AssetOperation, adopted = false): ToolResponse {
  const code = OPERATION_ERROR_CODES.find(candidate => candidate === data.ErrorCode) ?? 'IMPORT_FAILED';
  const message = typeof data.Error === 'string' ? data.Error : `${kind} asset operation failed.`;
  return toolError(new ToolDomainError(
    code,
    adopted ? `${message} (This operation_id belongs to an earlier attempt that failed; retry with a new operation_id.)` : message,
    { operationId: data.OperationId, ...(adopted ? { adopted: true } : {}) },
  ));
}

interface ResponseExtras {
  /** Extra result fields merged next to `operation`. */
  data?: Record<string, unknown>;
  warnings?: string[];
  /** False when a succeeded operation is known not to have reimported anything. */
  reimported?: boolean;
}

function response(kind: 'import' | 'reimport', data: AssetOperation, bridge: unknown, pending = false, extras: ResponseExtras = {}): ToolResponse {
  if (String(data.Phase).toLowerCase() === 'failed') return operationFailure(kind, data);
  const output = { operation: data, ...(extras.data ?? {}), bridge, ...(pending ? { pending: true } : {}) };
  const succeeded = terminal(data) && String(data.Phase).toLowerCase() === 'succeeded';
  return toolResult(JSON.stringify(output, null, 2), {
    mode: 'editor-connected',
    data: output,
    warnings: [
      ...(pending ? ['Import is still running; poll the matching asset operation status tool with operation_id.'] : []),
      ...(extras.warnings ?? []),
    ],
    changes: succeeded && extras.reimported !== false ? [{ kind: `${kind}-asset`, operationId: data.OperationId }] : [],
  });
}

interface ImportItemInput { source_path: string; destination: string; model_import_type?: z.infer<typeof ModelImportType> }
interface ImportCommon {
  collision_policy: 'error' | 'rename' | 'replace';
  confirm?: boolean;
  dry_run: boolean;
  wait: boolean;
}
interface ImportItemOutcome {
  data: AssetOperation;
  bridge: unknown;
  destination: { path: string; requested: string; renamed: boolean };
}

/** Validates one item against the policy and starts it (optionally waiting). Throws mapped-able errors. */
async function runImportItem(
  item: ImportItemInput,
  common: ImportCommon,
  operation: string,
  idempotencyKey: string | undefined,
  deadline: number,
  ctx: ProjectMeta,
): Promise<ImportItemOutcome> {
  const policy = assetImportPolicyForContext(ctx);
  const replace = common.collision_policy === 'replace';
  if (replace && !common.dry_run && common.confirm !== true) {
    throw new ToolDomainError('VALIDATION_FAILED', "collision_policy 'replace' overwrites an existing asset and requires confirm:true (or dry_run:true to preview).");
  }
  const source = await verifyAssetImportSource(item.source_path, policy);
  const requested = await verifyAssetImportDestination(item.destination, ctx);
  const destination = await chooseAssetImportDestination(requested, common.collision_policy);
  const started = await startHeavyOperation(ctx, () => startImport({
    OperationId: operation,
    IdempotencyKey: idempotencyKey,
    SourcePath: source.canonicalPath,
    SourceSizeBytes: source.sizeBytes,
    SourceLastWriteUnixMs: source.modifiedUnixMs,
    DestinationPath: destination.relativePath,
    CollisionPolicy: common.collision_policy,
    DryRun: common.dry_run,
    ModelImportType: item.model_import_type,
    AllowedImportRoots: policy.roots,
    MaxSourceBytes: policy.maxSourceBytes,
    // Only sent for replace so older bridges keep receiving the exact v9 parameter set.
    ...(replace ? { Confirm: common.confirm === true } : {}),
  }, ctx, replace ? BRIDGE_V34 : 9));
  const waited = await maybeWait('import', started.data, common.wait, Math.max(0, deadline - Date.now()), ctx);
  // The Node side already picked a free name for collision_policy:rename and sent that as the destination,
  // so the bridge sees no collision and reports Renamed:false. The rename decision is Node's.
  const data = destination.renamed ? { ...waited.data, Renamed: true } : waited.data;
  return {
    data,
    bridge: waited.bridge ?? started.bridge,
    destination: { path: destination.relativePath, requested: requested.relativePath, renamed: destination.renamed },
  };
}

/** Item errors that say nothing about the next item stay per-item; these mean the Editor cannot take more. */
const BATCH_STOP_CODES = new Set<string>(['EDITOR_NOT_CONNECTED', 'UNSUPPORTED_FLAX_VERSION', 'EDITOR_BUSY', 'TIMEOUT', 'RATE_LIMITED', 'HEADLESS_MODE']);

interface BatchItemResult {
  index: number;
  operation_id?: string;
  ok: boolean;
  status: string;
  destination?: ImportItemOutcome['destination'];
  operation?: AssetOperation;
  error?: { code: string; message: string; details?: unknown };
}

async function importBatch(args: z.infer<typeof AssetImportSchema>, items: ImportItemInput[], ctx: ProjectMeta): Promise<ToolResponse> {
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.destination.toLowerCase();
    if (seen.has(key)) throw new ToolDomainError('VALIDATION_FAILED', `items contains the destination "${item.destination}" more than once.`);
    seen.add(key);
  }
  const common: ImportCommon = { collision_policy: args.collision_policy, confirm: args.confirm, dry_run: args.dry_run, wait: args.wait };
  const deadline = Date.now() + args.timeout_ms;
  const results: BatchItemResult[] = [];
  let aborted: ToolDomainError | undefined;
  let lastBridge: unknown;
  for (const [index, item] of items.entries()) {
    if (aborted) {
      results.push({ index, ok: false, status: 'skipped', error: { code: aborted.code, message: `Skipped: an earlier item failed with ${aborted.code}.` } });
      continue;
    }
    const operation = operationId(undefined);
    try {
      const outcome = await runImportItem(item, common, operation, args.idempotency_key === undefined ? undefined : `${args.idempotency_key}:${index}`, deadline, ctx);
      lastBridge = outcome.bridge;
      const phase = String(outcome.data.Phase ?? '').toLowerCase();
      if (phase === 'failed') {
        const code = OPERATION_ERROR_CODES.find(candidate => candidate === outcome.data.ErrorCode) ?? 'IMPORT_FAILED';
        results.push({ index, operation_id: operation, ok: false, status: 'failed', destination: outcome.destination, operation: outcome.data, error: { code, message: typeof outcome.data.Error === 'string' ? outcome.data.Error : 'import asset operation failed.' } });
      } else if (terminal(outcome.data)) {
        results.push({ index, operation_id: operation, ok: true, status: phase, destination: outcome.destination, operation: outcome.data });
      } else {
        results.push({ index, operation_id: operation, ok: true, status: 'pending', destination: outcome.destination, operation: outcome.data });
      }
    } catch (error) {
      const mapped = withOperationId(importError(error), operation);
      results.push({ index, operation_id: operation, ok: false, status: 'failed', error: { code: mapped.code, message: mapped.message, ...(mapped.details === undefined ? {} : { details: mapped.details }) } });
      if (BATCH_STOP_CODES.has(mapped.code)) aborted = mapped;
    }
  }
  const counts = {
    total: results.length,
    succeeded: results.filter(result => result.ok && (result.status === 'succeeded' || result.status === 'dry_run')).length,
    pending: results.filter(result => result.status === 'pending').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
  };
  const bad = counts.failed + counts.skipped;
  const status = bad > 0 ? (counts.succeeded + counts.pending > 0 ? 'partial' : 'failed') : counts.pending > 0 ? 'pending' : 'succeeded';
  const output = { status, counts, items: results, ...(lastBridge === undefined ? {} : { bridge: lastBridge }) };
  if (status === 'failed') {
    const first = results.find(result => result.error)?.error;
    throw new ToolDomainError((first?.code as ToolDomainError['code'] | undefined) ?? 'IMPORT_FAILED', `All ${counts.total} import item(s) failed. First error: ${first?.message ?? 'unknown'}`, output);
  }
  return toolResult(JSON.stringify(output, null, 2), {
    mode: 'editor-connected',
    data: output,
    warnings: [
      ...(counts.pending > 0 ? ['Some imports are still running; poll asset_import_status with each pending item operation_id.'] : []),
      ...(bad > 0 ? [`${bad} of ${counts.total} import item(s) did not succeed; see items[].error. Items that succeeded stay imported.`] : []),
    ],
    changes: args.dry_run ? [] : results.filter(result => result.ok && result.status === 'succeeded').map(result => ({ kind: 'import-asset', operationId: result.operation_id })),
  });
}

export async function handleAssetImport(args: z.infer<typeof AssetImportSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    if (args.items !== undefined) return await importBatch(args, args.items, ctx);
    if (args.source_path === undefined || args.destination === undefined) {
      throw new ToolDomainError('VALIDATION_FAILED', 'Provide source_path and destination, or items.');
    }
    const operation = operationId(args.operation_id);
    try {
      const outcome = await runImportItem(
        { source_path: args.source_path, destination: args.destination, model_import_type: args.model_import_type },
        { collision_policy: args.collision_policy, confirm: args.confirm, dry_run: args.dry_run, wait: args.wait },
        operation, args.idempotency_key, Date.now() + args.timeout_ms, ctx);
      return response('import', outcome.data, outcome.bridge, !terminal(outcome.data), { data: { destination: outcome.destination } });
    } catch (error) {
      throw withOperationId(importError(error), operation);
    }
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
  Operation: AssetOperation | null;
  /** Null when the bridge has no preview for an adopted operation. */
  WouldChange: boolean | null;
  Before: ImportSettingsBridgeResult | null;
  After: ImportSettingsBridgeResult | null;
  /** True when the bridge replayed the result of an already-known operation ID. */
  Adopted?: boolean;
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
      warnings: data && !data.restored
        ? ['The asset has no restorable import metadata: these settings are engine defaults, not the values the asset was imported with, and asset_set_import_settings will refuse to write to it.']
        : [],
    });
  } catch (error) {
    return toolError(importError(error));
  }
}

const IMPORT_SETTING_KEYS = new Set(IMPORT_SETTING_ENTRIES.map(([snake]) => snake));

/**
 * Maps parsed settings to bridge entries, each in the wire slot its option
 * type requires. AssetSetImportSettingsSchema already rejects unknown keys,
 * wrong types, and out-of-range numbers; the checks here only keep the handler
 * safe for a caller that skips the schema.
 */
function settingsEntries(settings: Record<string, unknown>): Array<{ Key: string; Value: Record<string, unknown> }> {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Settings must be an object of import settings.');
  }
  const unknown = Object.keys(settings).filter(key => !IMPORT_SETTING_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ToolDomainError('VALIDATION_FAILED', `Unknown import setting(s): ${unknown.join(', ')}. Allowed: ${[...IMPORT_SETTING_KEYS].join(', ')}.`);
  }
  const entries: Array<{ Key: string; Value: Record<string, unknown> }> = [];
  for (const [snake, spec] of IMPORT_SETTING_ENTRIES) {
    const value = settings[snake];
    if (value === undefined) continue;
    const valid = spec.field === 'Boolean' ? typeof value === 'boolean'
      : spec.field === 'Integer' ? Number.isSafeInteger(value)
        : spec.field === 'Number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'string';
    if (!valid) {
      throw new ToolDomainError('VALIDATION_FAILED', `Import setting "${snake}" has the wrong type; expected ${spec.field === 'Text' ? 'a string' : spec.field === 'Boolean' ? 'a boolean' : spec.field === 'Integer' ? 'an integer' : 'a finite number'}.`);
    }
    entries.push({ Key: spec.key, Value: { [spec.field]: value } });
  }
  if (entries.length === 0) throw new ToolDomainError('VALIDATION_FAILED', 'Settings must contain at least one import setting.');
  return entries;
}

async function startSetImportSettings(params: Record<string, unknown>, ctx: ProjectMeta): Promise<{ data: SetImportSettingsBridgeResult; bridge: unknown }> {
  const response = await callEditorBridge<'asset.set_import_settings', Record<string, unknown>, SetImportSettingsBridgeResult>(
    ctx, 'asset.set_import_settings', params, { minimumBridgeVersion: 32, deadlineMs: 30_000 });
  return { data: response.data, bridge: response.bridge };
}

export async function handleAssetSetImportSettings(args: z.infer<typeof AssetSetImportSettingsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const entries = settingsEntries(args.settings as Record<string, unknown>);
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
    const raw = started.data;
    const operation = safeOperation(raw.Operation ?? {});
    const before = projectImportSettings(raw.Before ?? null);
    const after = projectImportSettings(raw.After ?? null);
    // A bridge that adopts an earlier operation it holds no preview for sends
    // no Before/After (older v32/v33 bridges also sent WouldChange:false
    // there). That means "unknown", never "no change".
    const previewKnown = before !== null && after !== null && typeof raw.WouldChange === 'boolean';
    const adopted = raw.Adopted === true || !previewKnown;
    // An adopted operation may be one whose first attempt failed; report that
    // failure instead of a success-shaped result.
    if (String(operation.Phase).toLowerCase() === 'failed') return operationFailure('reimport', operation, adopted);
    const extra = {
      ...(previewKnown ? { would_change: raw.WouldChange, before, after } : {}),
      ...(adopted ? { adopted: true } : {}),
    };
    const warnings = previewKnown ? [] : ['The bridge adopted an earlier operation with this operation_id and holds no preview for it, so would_change is unknown. Use a new operation_id for a fresh result.'];
    if (args.dry_run) {
      const data = previewKnown ? extra : { ...extra, operation };
      return toolResult(JSON.stringify({ ...data, bridge: started.bridge }, null, 2), { mode: 'editor-connected', data, warnings });
    }
    // The bridge queues a reimport only when a requested value differs from
    // the current one; a no-op write finishes "succeeded" without reimporting.
    const reimportQueued = previewKnown && raw.WouldChange === true;
    if (previewKnown && !reimportQueued) warnings.push('No reimport was queued: every requested setting already has the requested value.');
    // Settings writes share the "reimport" operation records, so
    // asset_reimport_status polls them like ordinary reimports.
    const waited = await maybeWait('reimport', operation, args.wait, args.timeout_ms, ctx);
    return response('reimport', waited.data, waited.bridge ?? started.bridge, !terminal(waited.data), { data: extra, warnings, reimported: reimportQueued });
  } catch (error) {
    return toolError(importError(error));
  }
}
