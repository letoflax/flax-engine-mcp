import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
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
    parameter_id: FlaxId.optional(),
    name: z.string().min(1).max(256).optional(),
    value: MaterialAnimationValue,
  }).strict().superRefine((value, ctx) => {
    if ((value.parameter_id === undefined) === (value.name === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of parameter_id or name.' });
    }
  })).min(1).max(64),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const MaterialCreateInstanceSchema = z.object({
  ...AssetSelector,
  destination_path: MaterialInstancePath,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const MaterialAssignToActorSchema = z.object({
  ...AssetSelector,
  actor_id: FlaxId,
  slot: z.number().int().min(0).max(255).optional().default(0),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

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
    if (code === 'ASSET_NOT_FOUND') return new ToolDomainError('ASSET_NOT_FOUND', error.message, remote?.details);
    if (code === 'NOT_FOUND') return new ToolDomainError('ACTOR_NOT_FOUND', error.message, remote?.details);
    if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
    if (code === 'CURSOR_INVALID') return new ToolDomainError('CURSOR_INVALID', error.message, remote?.details);
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'RESPONSE_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, remote?.details);
    if (code === 'UNSUPPORTED_FLAX_VERSION') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function materialAnimationCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: Record<string, unknown>,
  changes: unknown[] = [],
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion: 13 });
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

export const handleMaterialSetParameters = (args: z.infer<typeof MaterialSetParametersSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.set_parameters', {
    ...selector(args),
    Parameters: args.parameters.map(parameter => ({ ParameterId: parameter.parameter_id, Name: parameter.name, Value: parameter.value })),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  });

export const handleMaterialCreateInstance = (args: z.infer<typeof MaterialCreateInstanceSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.create_instance', {
    ...selector(args),
    DestinationPath: args.destination_path,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  });

export const handleMaterialAssignToActor = (args: z.infer<typeof MaterialAssignToActorSchema>, ctx: ProjectMeta) =>
  materialAnimationCall(ctx, 'material.assign_to_actor', {
    ...selector(args),
    ActorId: args.actor_id,
    Slot: args.slot,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  });

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
