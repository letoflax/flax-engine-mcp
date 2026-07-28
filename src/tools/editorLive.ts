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
});

export const SceneListLoadedSchema = z.object({});
export const SceneGetTreeSchema = z.object({ scene_id: FlaxId });
export const SceneSaveSchema = z.object({ scene_id: FlaxId });
export const ProjectSaveAllSchema = z.object({});
export const ActorGetSchema = z.object({ actor_id: FlaxId });
export const ActorFindSchema = z.object({
  name: z.string().min(1).max(128),
  max_results: z.number().int().min(1).max(100).optional().default(50),
});
export const ActorCreateSchema = z.object({
  type_name: z.string().min(1).max(256).optional().default('FlaxEngine.EmptyActor'),
  name: z.string().min(1).max(128),
  parent_id: FlaxId.optional(),
  active: z.boolean().optional().default(true),
  position: Vector3.optional(),
  dry_run: z.boolean().optional().default(false),
});
export const ActorUpdateSchema = z.object({
  actor_id: FlaxId,
  name: z.string().max(128).optional(),
  active: z.boolean().optional(),
  position: Vector3.optional(),
  scale: Vector3.optional(),
  euler_angles: Vector3.optional(),
  dry_run: z.boolean().optional().default(false),
});
export const ActorDeleteSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
});
export const ActorDuplicateSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
});
export const ActorReparentSchema = z.object({
  actor_id: FlaxId,
  parent_id: FlaxId.optional(),
  keep_world_transform: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(false),
});
export const ScriptAttachSchema = z.object({
  actor_id: FlaxId,
  script_type: z.string().min(1).max(256),
  dry_run: z.boolean().optional().default(false),
});
export const ScriptDetachSchema = z.object({
  script_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
});
export const ScriptInstanceGetSchema = z.object({ script_id: FlaxId });
export const ScriptInstanceUpdateSchema = z.object({
  script_id: FlaxId,
  enabled: z.boolean(),
  dry_run: z.boolean().optional().default(false),
});
export const EditUndoSchema = z.object({});
export const EditRedoSchema = z.object({});

type AnyRecord = Record<string, unknown>;

function toBridgeVector(value: z.infer<typeof Vector3> | undefined): AnyRecord | undefined {
  return value ? { X: value.x, Y: value.y, Z: value.z } : undefined;
}

function bridgeError(error: unknown): ToolDomainError {
  if (!(error instanceof BridgeRpcError)) {
    return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') {
    return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  }
  if (error.code === 'BRIDGE_CONCURRENT_CALL') {
    return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  }
  if (error.code === 'BRIDGE_TIMEOUT') {
    return new ToolDomainError('TIMEOUT', error.message, error.details);
  }
  if (error.code === 'BRIDGE_UNSUPPORTED') {
    return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  }
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remoteCode = (error.details as { code?: unknown } | undefined)?.code;
    if (remoteCode === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, error.details);
    if (remoteCode === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, error.details);
    if (remoteCode === 'RESPONSE_TOO_LARGE' || remoteCode === 'REQUEST_TOO_LARGE') {
      return new ToolDomainError('CONTENT_TOO_LARGE', error.message, error.details);
    }
    if (remoteCode === 'UNSUPPORTED_FLAX_VERSION') {
      return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
    }
    if (remoteCode === 'VALIDATION_FAILED' || remoteCode === 'INVALID_REQUEST') {
      return new ToolDomainError('VALIDATION_FAILED', error.message, error.details);
    }
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function liveCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: AnyRecord,
  changes: unknown[] = [],
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params);
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: response.mode,
      data,
      warnings: response.warnings,
      changes,
    });
  } catch (error) {
    return toolError(bridgeError(error));
  }
}

async function dryRunLookup(
  ctx: ProjectMeta,
  method: 'actor.get' | 'actor.validate_create' | 'script.instance_get' | 'status',
  params: AnyRecord,
  preview: AnyRecord,
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params);
    const data = { dryRun: true, current: response.data, preview, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: response.mode,
      data,
      warnings: ['Dry-run validates connectivity and requested editor-side target or type checks, but does not execute the mutation.'],
    });
  } catch (error) {
    return toolError(bridgeError(error));
  }
}

export const handleSceneListLoaded = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'scene.list_loaded', {});
export const handleSceneGetTree = (args: z.infer<typeof SceneGetTreeSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'scene.get_tree', { SceneId: args.scene_id });
export const handleSceneSave = (args: z.infer<typeof SceneSaveSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'scene.save', { SceneId: args.scene_id }, [{ kind: 'scene.saved', id: args.scene_id }]);
export const handleProjectSaveAll = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'project.save_all', {}, [{ kind: 'project.saved' }]);
export const handleActorGet = (args: z.infer<typeof ActorGetSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'actor.get', { ActorId: args.actor_id });
export const handleActorFind = (args: z.infer<typeof ActorFindSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'actor.find', { Name: args.name, MaxResults: args.max_results });

export async function handleActorCreate(args: z.infer<typeof ActorCreateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = {
    TypeName: args.type_name,
    Name: args.name,
    ParentId: args.parent_id,
    Active: args.active,
    Position: toBridgeVector(args.position),
  };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.validate_create', params, params);
  return liveCall(ctx, 'actor.create', params, [{ kind: 'actor.created', name: args.name }]);
}

export async function handleActorUpdate(args: z.infer<typeof ActorUpdateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  if (
    args.name === undefined &&
    args.active === undefined &&
    args.position === undefined &&
    args.scale === undefined &&
    args.euler_angles === undefined
  ) {
    return toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide at least one actor field to update.'));
  }
  const params = {
    ActorId: args.actor_id,
    Name: args.name,
    Active: args.active,
    Position: toBridgeVector(args.position),
    Scale: toBridgeVector(args.scale),
    EulerAngles: toBridgeVector(args.euler_angles),
  };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(ctx, 'actor.update', params, [{ kind: 'actor.updated', id: args.actor_id }]);
}

export async function handleActorDelete(args: z.infer<typeof ActorDeleteSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', params, { action: 'delete' });
  return liveCall(ctx, 'actor.delete', params, [{ kind: 'actor.deleted', id: args.actor_id }]);
}

export async function handleActorDuplicate(args: z.infer<typeof ActorDuplicateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', params, { action: 'duplicate' });
  return liveCall(ctx, 'actor.duplicate', params, [{ kind: 'actor.duplicated', sourceId: args.actor_id }]);
}

export async function handleActorReparent(args: z.infer<typeof ActorReparentSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = {
    ActorId: args.actor_id,
    ParentId: args.parent_id,
    KeepWorldTransform: args.keep_world_transform,
  };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(ctx, 'actor.reparent', params, [{ kind: 'actor.reparented', id: args.actor_id, parentId: args.parent_id ?? null }]);
}

export async function handleScriptAttach(args: z.infer<typeof ScriptAttachSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id, ScriptType: args.script_type };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(ctx, 'script.attach', params, [{ kind: 'script.attached', actorId: args.actor_id, type: args.script_type }]);
}

export async function handleScriptDetach(args: z.infer<typeof ScriptDetachSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ScriptId: args.script_id };
  if (args.dry_run) return dryRunLookup(ctx, 'script.instance_get', params, { action: 'detach' });
  return liveCall(ctx, 'script.detach', params, [{ kind: 'script.detached', id: args.script_id }]);
}

export const handleScriptInstanceGet = (args: z.infer<typeof ScriptInstanceGetSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'script.instance_get', { ScriptId: args.script_id });

export async function handleScriptInstanceUpdate(
  args: z.infer<typeof ScriptInstanceUpdateSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  const params = { ScriptId: args.script_id, Enabled: args.enabled };
  if (args.dry_run) return dryRunLookup(ctx, 'script.instance_get', { ScriptId: args.script_id }, params);
  return liveCall(ctx, 'script.instance_update', params, [{ kind: 'script.updated', id: args.script_id }]);
}

export const handleEditUndo = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.undo', {}, [{ kind: 'edit.undo' }]);
export const handleEditRedo = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.redo', {}, [{ kind: 'edit.redo' }]);
