import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const ContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !normalized.startsWith('Content/') ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative path under Content/ without traversal.' });
  }
});
const ContentFolder = z.string().min(7).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (
    normalized !== value ||
    !(normalized === 'Content' || normalized.startsWith('Content/')) ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative Content folder without traversal.' });
  }
});
const MaterialInstancePath = ContentPath.superRefine((value, ctx) => {
  if (!value.toLowerCase().endsWith('.flax')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A persisted material instance destination must use a .flax path.' });
  }
});
const Vector2 = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const Vector3 = Vector2.extend({ z: z.number().finite() }).strict();
const Vector4 = Vector3.extend({ w: z.number().finite() }).strict();
const MaterialAnimationValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(512),
  Vector2,
  Vector3,
  Vector4,
  z.object({ asset_id: FlaxId }).strict(),
]);
const AssetSelector = { asset_id: FlaxId.optional(), path: ContentPath.optional() };

function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

function requiresConfirmation(value: { dry_run: boolean; confirm?: true }, ctx: z.RefinementCtx): void {
  if (!value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm: true when requesting a material or animation mutation.' });
  }
}

export const MaterialGetParametersSchema = z.object({
  ...AssetSelector,
  include_non_public: z.boolean().optional().default(false),
}).strict().superRefine(exactlyOneSelector);

export const MaterialSetParametersSchema = z.object({
  ...AssetSelector,
  parameters: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.union([z.boolean(), z.number().finite(), z.string().min(1).max(512)]),
  }).strict()).min(1).max(16),
  dry_run: z.boolean().optional().default(false),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

const MaterialBaseSelector = { base_id: FlaxId.optional(), base_path: ContentPath.optional() };

function exactlyOneBaseSelector(value: { base_id?: string; base_path?: string }, ctx: z.RefinementCtx): void {
  if ((value.base_id === undefined) === (value.base_path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of base_id or base_path.' });
  }
}

export const MaterialCreateInstanceSchema = z.object({
  ...MaterialBaseSelector,
  destination: MaterialInstancePath,
  dry_run: z.boolean().optional().default(false),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneBaseSelector(value, ctx); requiresConfirmation(value, ctx); });

const MaterialAssignSelector = { material_id: FlaxId.optional(), material_path: ContentPath.optional() };

function exactlyOneMaterialSelector(value: { material_id?: string; material_path?: string }, ctx: z.RefinementCtx): void {
  if ((value.material_id === undefined) === (value.material_path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of material_id or material_path.' });
  }
}

export const MaterialAssignToActorSchema = z.object({
  ...MaterialAssignSelector,
  actor_id: FlaxId,
  slot: z.number().int().min(0).max(255).optional().default(0),
  dry_run: z.boolean().optional().default(false),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  expected_scene_revision: z.number().int().nonnegative().optional(),
  lease_id: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character edit lease ID.').optional(),
}).strict().superRefine((value, ctx) => { exactlyOneMaterialSelector(value, ctx); requiresConfirmation(value, ctx); });

export const AnimationListClipsSchema = z.object({
  folder: ContentFolder.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: FlaxId.optional(),
}).strict();

export const AnimationGetGraphParametersSchema = z.object({ actor_id: FlaxId }).strict();

export const AnimationSetGraphParameterSchema = z.object({
  actor_id: FlaxId,
  parameter_id: FlaxId.optional(),
  parameter_name: z.string().min(1).max(256).optional(),
  value: MaterialAnimationValue,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.parameter_id === undefined) === (value.parameter_name === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of parameter_id or parameter_name.' });
  }
  requiresConfirmation(value, ctx);
});

export const AnimationValidateBindingsSchema = z.object({ actor_id: FlaxId }).strict();

function materialAnimationError(error: unknown): ToolDomainError {
  // Shared mapper owns the full BridgeRpcError contract (graph/mm pattern).
  // Two material/animation-surface specifics stay here so domain codes keep
  // flowing to callers: actor-scoped NOT_FOUND reports ACTOR_NOT_FOUND (see
  // prefabLive) and paginated list_clips reports CURSOR_INVALID.
  const mapped = mapBridgeError(error);
  if (mapped.code === 'NOT_FOUND') {
    return new ToolDomainError('ACTOR_NOT_FOUND', mapped.message, mapped.details);
  }
  if (mapped.code !== 'INTERNAL_ERROR') return mapped;
  if (error instanceof BridgeRpcError && error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    if (remote?.code === 'CURSOR_INVALID') {
      return new ToolDomainError('CURSOR_INVALID', error.message, remote.details);
    }
  }
  return mapped;
}

async function materialAnimationCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: Record<string, unknown>,
  changes: unknown[] = [],
  minimumBridgeVersion = 13,
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion });
    const result = response.data as { Warnings?: unknown } | undefined;
    const warnings = Array.isArray(result?.Warnings)
      ? result.Warnings.filter((warning): warning is string => typeof warning === 'string')
      : response.warnings;
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), { mode: response.mode, data, warnings, changes });
  } catch (error) {
    return toolError(materialAnimationError(error));
  }
}

function selector(args: { asset_id?: string; path?: string }): Record<string, unknown> {
  return { AssetId: args.asset_id, Path: args.path };
}

export const handleMaterialGetParameters = (args: z.infer<typeof MaterialGetParametersSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.get_parameters', { ...selector(args), IncludeNonPublic: args.include_non_public });

function splitMaterialWriteValue(value: boolean | number | string): Record<string, unknown> {
  if (typeof value === 'boolean') return { Bool: value };
  if (typeof value === 'number') return { Number: value };
  return { Text: value };
}

export const handleMaterialSetParameters = (args: z.infer<typeof MaterialSetParametersSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.set_parameters', {
    ...selector(args),
    Parameters: args.parameters.map(parameter => ({ Name: parameter.name, ...splitMaterialWriteValue(parameter.value) })),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  }, [], 29);

export const handleMaterialCreateInstance = (args: z.infer<typeof MaterialCreateInstanceSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.create_instance', {
    AssetId: args.base_id,
    Path: args.base_path,
    DestinationPath: args.destination,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  }, [], 29);

export const handleMaterialAssignToActor = (args: z.infer<typeof MaterialAssignToActorSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.assign_to_actor', {
    AssetId: args.material_id,
    Path: args.material_path,
    ActorId: args.actor_id,
    Slot: args.slot,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
  }, [], 29);

export const handleAnimationListClips = (args: z.infer<typeof AnimationListClipsSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'animation.list_clips', { Folder: args.folder, Limit: args.limit, Cursor: args.cursor });

export const handleAnimationGetGraphParameters = (args: z.infer<typeof AnimationGetGraphParametersSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'animation.get_graph_parameters', { ActorId: args.actor_id });

export const handleAnimationSetGraphParameter = (args: z.infer<typeof AnimationSetGraphParameterSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'animation.set_graph_parameter', {
    ActorId: args.actor_id,
    ParameterId: args.parameter_id,
    ParameterName: args.parameter_name,
    Value: args.value,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  });

export const handleAnimationValidateBindings = (args: z.infer<typeof AnimationValidateBindingsSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'animation.validate_bindings', { ActorId: args.actor_id });
