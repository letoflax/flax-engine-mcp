import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const Vector3 = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
}).strict();
const ContentPrefabPath = z.string().min(16).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !normalized.startsWith('Content/') ||
    !normalized.toLowerCase().endsWith('.prefab') ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative Content/.../*.prefab path without traversal.' });
  }
});
const ContentAssetPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !normalized.startsWith('Content/') ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative Content asset path without traversal.' });
  }
});
const RevisionedLiveWrite = {
  expected_scene_revision: z.number().int().nonnegative().optional(),
  lease_id: FlaxId.optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
};
const PrefabSelector = {
  asset_id: FlaxId.optional(),
  path: ContentAssetPath.optional(),
};

function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

function destructiveConfirmation(value: { dry_run: boolean; confirm?: true }, ctx: z.RefinementCtx): void {
  if (!value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm: true when executing a destructive prefab operation.' });
  }
}

export const PrefabCreateFromActorSchema = z.object({
  actor_id: FlaxId,
  destination_path: ContentPrefabPath,
  auto_link: z.boolean().optional().default(false)
    .describe('When true, Flax links the source actor hierarchy to the new prefab. This updates the loaded scene.'),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
}).strict();

export const PrefabInstantiateSchema = z.object({
  ...PrefabSelector,
  parent_id: FlaxId.describe('Required target parent. It pins instantiation to one already loaded scene.'),
  name: z.string().min(1).max(128).optional(),
  position: Vector3.optional().describe('World-space position. Defaults to 0,0,0.'),
  scale: Vector3.optional().describe('World-space scale. Defaults to 1,1,1.'),
  euler_angles: Vector3.optional().describe('World-space Euler angles. Defaults to 0,0,0.'),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
}).strict().superRefine(exactlyOneSelector);

export const PrefabGetInstancesSchema = z.object({
  ...PrefabSelector,
  scene_id: FlaxId.optional().describe('Optional loaded-scene filter. Without it, only all currently loaded scenes are scanned.'),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: FlaxId.optional(),
}).strict().superRefine(exactlyOneSelector);

export const PrefabGetOverridesSchema = z.object({ actor_id: FlaxId }).strict();
export const PrefabRevertOverridesSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  ...RevisionedLiveWrite,
}).strict().superRefine(destructiveConfirmation);
export const PrefabApplyOverridesSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  ...RevisionedLiveWrite,
}).strict().superRefine(destructiveConfirmation);
export const PrefabBreakLinkSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  ...RevisionedLiveWrite,
}).strict().superRefine(destructiveConfirmation);

type AnyRecord = Record<string, unknown>;

function bridgeVector(value: z.infer<typeof Vector3> | undefined): AnyRecord | undefined {
  return value ? { X: value.x, Y: value.y, Z: value.z } : undefined;
}

function prefabError(error: unknown): ToolDomainError {
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
    if (code === 'FILE_EXISTS') return new ToolDomainError('FILE_EXISTS', error.message, remote?.details);
    if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
    if (code === 'CURSOR_INVALID') return new ToolDomainError('CURSOR_INVALID', error.message, remote?.details);
    if (code === 'SCENE_REVISION_CONFLICT') return new ToolDomainError('SCENE_REVISION_CONFLICT', error.message, remote?.details);
    if (code === 'EDIT_LEASE_CONFLICT') return new ToolDomainError('EDIT_LEASE_CONFLICT', error.message, remote?.details);
    if (code === 'EDIT_LEASE_EXPIRED') return new ToolDomainError('EDIT_LEASE_EXPIRED', error.message, remote?.details);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new ToolDomainError('IDEMPOTENCY_KEY_REUSED', error.message, remote?.details);
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'RESPONSE_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, remote?.details);
    if (code === 'UNSUPPORTED_FLAX_VERSION') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function prefabCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: AnyRecord,
  changes: unknown[] = [],
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion: 12 });
    const result = response.data as { Warnings?: unknown } | undefined;
    const warnings = Array.isArray(result?.Warnings)
      ? result.Warnings.filter((warning): warning is string => typeof warning === 'string')
      : response.warnings;
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), { mode: response.mode, data, warnings, changes });
  } catch (error) {
    return toolError(prefabError(error));
  }
}

function writeParams(args: {
  expected_scene_revision?: number;
  lease_id?: string;
  idempotency_key?: string;
}): AnyRecord {
  return {
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.idempotency_key,
  };
}

export const handlePrefabCreateFromActor = (args: z.infer<typeof PrefabCreateFromActorSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.create_from_actor', {
    ActorId: args.actor_id,
    DestinationPath: args.destination_path,
    AutoLink: args.auto_link,
    DryRun: args.dry_run,
    ...writeParams(args),
  }, args.dry_run ? [] : [{ kind: 'prefab.created', sourceActorId: args.actor_id, path: args.destination_path, autoLinked: args.auto_link }]);

export const handlePrefabInstantiate = (args: z.infer<typeof PrefabInstantiateSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.instantiate', {
    AssetId: args.asset_id,
    Path: args.path,
    ParentId: args.parent_id,
    Name: args.name,
    Position: bridgeVector(args.position),
    Scale: bridgeVector(args.scale),
    EulerAngles: bridgeVector(args.euler_angles),
    DryRun: args.dry_run,
    ...writeParams(args),
  }, args.dry_run ? [] : [{ kind: 'prefab.instantiated', prefabId: args.asset_id ?? null, path: args.path ?? null, parentId: args.parent_id }]);

export const handlePrefabGetInstances = (args: z.infer<typeof PrefabGetInstancesSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.get_instances', {
    AssetId: args.asset_id,
    Path: args.path,
    SceneId: args.scene_id,
    Limit: args.limit,
    Cursor: args.cursor,
  });

export const handlePrefabGetOverrides = (args: z.infer<typeof PrefabGetOverridesSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.get_overrides', { ActorId: args.actor_id });

function unsupportedMutationParams(args: z.infer<typeof PrefabRevertOverridesSchema>): AnyRecord {
  return { ActorId: args.actor_id, DryRun: args.dry_run, Confirm: args.confirm === true, ...writeParams(args) };
}

export const handlePrefabRevertOverrides = (args: z.infer<typeof PrefabRevertOverridesSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.revert_overrides', unsupportedMutationParams(args));
export const handlePrefabApplyOverrides = (args: z.infer<typeof PrefabApplyOverridesSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.apply_overrides', unsupportedMutationParams(args));
export const handlePrefabBreakLink = (args: z.infer<typeof PrefabBreakLinkSchema>, ctx: ProjectMeta) =>
  prefabCall(ctx, 'prefab.break_link', unsupportedMutationParams(args));
