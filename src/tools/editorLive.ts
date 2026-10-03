import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { BRIDGE_V34, bridgeWarnings } from './liveToolSupport.js';

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
const Vector3 = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
const RevisionedLiveWrite = {
  expected_scene_revision: z.number().int().nonnegative().optional()
    .describe('Bridge-known revision required before writing. Requires bridge v7 and rejects stale scene state.'),
  lease_id: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character edit lease ID.').optional()
    .describe('Active v7 edit lease for the target scene.'),
  idempotency_key: z.string().min(1).max(128).optional()
    .describe('Optional v7 retry key. Replays the original result without another side effect for ten minutes.'),
};

export const SceneListLoadedSchema = z.object({});
export const SceneGetTreeSchema = z.object({ scene_id: FlaxId });
export const SceneSaveSchema = z.object({ scene_id: FlaxId });
export const SceneOpenSchema = z.object({
  asset_id: FlaxId.optional(),
  path: ContentPath.optional(),
  allow_dirty_scenes: z.boolean().optional().default(false)
    .describe('Acknowledge edited loaded scenes before opening. Without it the bridge refuses with DIRTY_SCENE listing dirty scene names (play-start gate convention). Requires bridge v25.'),
  replace: z.boolean().optional()
    .describe('Make this scene the only loaded scene: every other loaded scene is unloaded through the Editor scene state machine (the Editor "open scene" path without the save prompt). A target that is already loaded stays loaded and only the others close. Edited scenes that would close are refused with DIRTY_SCENE unless discard_unsaved is true. unloaded_scene_ids lists the scenes being closed. Mutually exclusive with reload. Requires bridge v34.'),
  reload: z.boolean().optional()
    .describe('Re-read the scene from its file on disk. A loaded scene is unloaded and loaded again from the refreshed file; a scene that is not loaded is opened from the refreshed file. disk_sha256 is the SHA-256 of the file as read. An edited scene is refused with DIRTY_SCENE unless discard_unsaved is true. Mutually exclusive with replace. Requires bridge v34.'),
  discard_unsaved: z.boolean().optional()
    .describe('With replace or reload: drop the unsaved edits of the scenes that get unloaded instead of refusing with DIRTY_SCENE. allow_dirty_scenes never discards edits. Only valid together with replace or reload. Requires bridge v34.'),
}).strict().superRefine((value, ctx) => {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
  if (value.replace && value.reload) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reload'], message: 'replace and reload are mutually exclusive.' });
  }
  if (value.discard_unsaved && !value.replace && !value.reload) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discard_unsaved'], message: 'discard_unsaved applies only together with replace or reload.' });
  }
});

/**
 * Bridge v34 nested member path: member names from the target down to a leaf,
 * each a C# identifier (the Type.Member form is not available inside a path).
 * When a path is given, the plain member name (field / property / member)
 * must be omitted.
 */
export const MemberPathSchema = z.array(z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Path segments must be C# identifiers.')).min(1).max(4)
  .describe('Nested member path of 1-4 member names, for example ["Settings","Speed"] or ["Stats","Limits","Max"]. Replaces field/property/member (omit that one when path is given). Every level must be an editor-visible, writable member (not [HideInEditor], [ReadOnly], or at edit time [NoSerialize]); intermediate levels are user-defined structs or non-null classes (not engine objects, arrays, lists, or dictionaries), and the last name is a member of a supported value type. Each parent is written back like the Editor property grid does. Requires bridge v34.');

export function memberNameOrPath(nameKey: 'field' | 'property' | 'member', value: { path?: string[] } & Record<string, unknown>, ctx: z.RefinementCtx): void {
  const named = value[nameKey] !== undefined;
  if (value.path !== undefined && named) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [nameKey], message: `Omit ${nameKey} when path is given: path already names the whole member chain.` });
  }
  if (value.path === undefined && !named) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [nameKey], message: `Provide ${nameKey}, or path for a nested member.` });
  }
}

/** Value shapes shared by actor_set_property, script_instance_set_value, and runtime_set_script_value. */
export const MemberValueSchema = z.union([z.boolean(), z.number().finite(), z.string()])
  .describe('Coerced strictly to the member type: boolean, finite number, or string. Strings carry enum names ("A, B" for flags), vectors ("x,y[,z[,w]]"), quaternions ("x,y,z,w"), colors ("#rrggbb[aa]" or "r,g,b[,a]"), rectangles ("x,y,width,height"), margins ("left,right,top,bottom"), and references: an actor or script GUID, or an asset as a GUID, a project "Content/..." path, or engine content as "engine:<path>" (path below the engine Content folder without extension, for example "engine:Editor/Primitives/Cube"); "" clears a reference. Font members (kind font) take "<font asset>;size=<points>", for example "engine:Editor/Fonts/Roboto-Regular;size=24". Brush members (kind brush) take "<kind>:<value>[;option=value]" with the kinds solid, gradient, texture, texture9, sprite, sprite9, material, ui_brush, and video; ui_control_set_property lists every form. actor_get_properties returns references, fonts, and brushes in these same shapes as Value.Text.');
export const ProjectSaveAllSchema = z.object({});
export const ActorGetSchema = z.object({ actor_id: FlaxId });
export const ActorFindSchema = z.object({
  name: z.string().min(1).max(128).optional()
    .describe('Case-insensitive actor name substring.'),
  type_name: z.string().min(1).max(256).optional()
    .describe('Exact fully qualified Flax actor type name.'),
  parent_id: FlaxId.optional()
    .describe('Only direct children of this live actor.'),
  active: z.boolean().optional()
    .describe('Filter by the actor active flag (not inherited active state).'),
  max_results: z.number().int().min(1).max(100).optional().default(50),
});
export const ActorCreateSchema = z.object({
  type_name: z.string().min(1).max(256).optional().default('FlaxEngine.EmptyActor'),
  name: z.string().min(1).max(128),
  parent_id: FlaxId.optional(),
  active: z.boolean().optional().default(true),
  position: Vector3.optional(),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ActorUpdateSchema = z.object({
  actor_id: FlaxId,
  name: z.string().max(128).optional(),
  active: z.boolean().optional(),
  position: Vector3.optional(),
  scale: Vector3.optional(),
  euler_angles: Vector3.optional(),
  local_position: Vector3.optional(),
  local_scale: Vector3.optional(),
  local_euler_angles: Vector3.optional(),
  layer: z.number().int().min(0).max(31).optional()
    .describe('Flax layer index. Only the actor itself is changed; children are not updated recursively.'),
  skinned_model_id: FlaxId.optional()
    .describe('Assign a SkinnedModel to a FlaxEngine.AnimatedModel actor (by asset GUID).'),
  skinned_model_path: z.string().min(1).max(512).optional()
    .describe('Assign a SkinnedModel to a FlaxEngine.AnimatedModel actor (by Content path).'),
  animation_graph_id: FlaxId.optional()
    .describe('Assign an AnimationGraph to a FlaxEngine.AnimatedModel actor (by asset GUID).'),
  animation_graph_path: z.string().min(1).max(512).optional()
    .describe('Assign an AnimationGraph to a FlaxEngine.AnimatedModel actor (by Content path).'),
  static_model_id: FlaxId.optional()
    .describe('Assign a Model to a FlaxEngine.StaticModel actor (by asset GUID).'),
  static_model_path: z.string().min(1).max(512).optional()
    .describe('Assign a Model to a FlaxEngine.StaticModel actor (by Content path).'),
  update_when_offscreen: z.boolean().optional()
    .describe('Set AnimatedModel.UpdateWhenOffscreen.'),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ActorDeleteSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ActorDuplicateSchema = z.object({
  actor_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ActorReparentSchema = z.object({
  actor_id: FlaxId,
  parent_id: FlaxId.optional(),
  keep_world_transform: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ScriptAttachSchema = z.object({
  actor_id: FlaxId,
  script_type: z.string().min(1).max(256),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ScriptDetachSchema = z.object({
  script_id: FlaxId,
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ScriptInstanceGetSchema = z.object({
  script_id: FlaxId,
  include_values: z.boolean().optional().default(false)
    .describe('Opt-in bounded read of public script field values (bool/int/float/string/enum/Guid/Vector2-4/Color; max 64 fields, strings capped at 512 chars). Bridge v34 also reports asset references as Kind asset (AssetId GUID plus TypeName) and nested user struct and class values up to two levels deep as Kind struct or object with Fields; collections and other unsupported types are null with a reason. Default false returns only identity and enabled state.'),
});
export const ScriptInstanceUpdateSchema = z.object({
  script_id: FlaxId,
  enabled: z.boolean().optional()
    .describe('The only supported script-instance patch field. Arbitrary serialized script properties are not exposed.'),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const ScriptInstanceSetValueSchema = z.object({
  script_id: FlaxId,
  field: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Field must be a C# identifier.').optional()
    .describe('Editor-visible member of the script (C# identifier, 1-128 chars): public or [ShowInEditor], never [HideInEditor], [ReadOnly], or (at edit time) [NoSerialize]; engine-declared script members are refused. Omit it when path is given.'),
  path: MemberPathSchema.optional(),
  value: MemberValueSchema,
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the coercion and report would_change plus before/after without writing. Requires bridge v28.'),
  ...RevisionedLiveWrite,
}).superRefine((value, ctx) => memberNameOrPath('field', value, ctx));
// The five bridge v28 aliases keep their dedicated typed setters and stay
// wire-identical. Any other name is a bridge v33 editor-visible member.
const LEGACY_ACTOR_PROPERTIES = new Set(['Light.Color', 'Light.Brightness', 'Camera.FieldOfView', 'StaticModel.Model', 'Script.Enabled']);

export const ActorSetPropertySchema = z.object({
  target_id: FlaxId.describe('Actor GUID. Script.Enabled alone takes a script GUID.'),
  property: z.string().min(1).max(128).optional()
    .describe('Member or Type.Member of an editor-visible actor member, for example Mass, RigidBody.IsKinematic, BoxCollider.Size, AudioSource.Clip, Model (bridge v33; list them with actor_get_properties). The v28 aliases Light.Color, Light.Brightness, Camera.FieldOfView, StaticModel.Model, and Script.Enabled still work on older bridges. Name, active, transform, and layer belong to actor_update. Omit it when path is given.'),
  path: MemberPathSchema.optional(),
  value: MemberValueSchema,
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the coercion and report would_change plus before/after without writing. Requires bridge v33.'),
  ...RevisionedLiveWrite,
}).superRefine((value, ctx) => memberNameOrPath('property', value, ctx));
export const EditUndoSchema = z.object({});
export const EditRedoSchema = z.object({});
export const EditLeaseBeginSchema = z.object({
  scene_id: FlaxId.optional(),
  asset_id: FlaxId.optional(),
  path: ContentPath.optional(),
  owner: z.string().min(1).max(128),
  ttl_ms: z.number().int().min(1_000).max(300_000).optional().default(30_000),
}).strict().superRefine((value, ctx) => {
  const hasScene = value.scene_id !== undefined;
  const hasAsset = value.asset_id !== undefined || value.path !== undefined;
  if (hasScene === hasAsset) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one lease scope: scene_id or asset_id/path.' });
  }
  if (value.asset_id !== undefined && value.path !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
});
export const EditLeaseGetSchema = z.object({
  scene_id: FlaxId.optional(),
  lease_id: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character edit lease ID.').optional(),
});
export const EditLeaseCommitSchema = z.object({
  lease_id: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character edit lease ID.'),
});
export const EditLeaseReleaseSchema = EditLeaseCommitSchema;
export const EditorGetSelectionSchema = z.object({});
export const EditorSetSelectionSchema = z.object({
  actor_ids: z.array(FlaxId).min(1).max(200)
    .describe('Live actor IDs that replace the editor selection (1-200). Unknown IDs fail without changing the selection.'),
  focus_viewport: z.boolean().optional().default(false)
    .describe('Frame the EditWin viewport on the new selection via FocusSelection after replacing it.'),
});

type AnyRecord = Record<string, unknown>;

function toBridgeVector(value: z.infer<typeof Vector3> | undefined): AnyRecord | undefined {
  return value ? { X: value.x, Y: value.y, Z: value.z } : undefined;
}

function bridgeError(error: unknown): ToolDomainError {
  // Shared mapper owns the full BridgeRpcError contract (graph/mm pattern),
  // including a headless edit-time refusal (HEADLESS_MODE).
  // SCENE_REVISION_CONFLICT is editor-surface-specific and stays here so
  // revision-guard details keep flowing to callers.
  const mapped = mapBridgeError(error);
  if (mapped.code !== 'INTERNAL_ERROR') return mapped;
  if (error instanceof BridgeRpcError && error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    if (remote?.code === 'SCENE_REVISION_CONFLICT') {
      return new ToolDomainError('SCENE_REVISION_CONFLICT', error.message, remote.details);
    }
  }
  return mapped;
}

async function liveCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: AnyRecord,
  // A function receives the bridge result, so a no-op write can report no change.
  changes: unknown[] | ((result: unknown) => unknown[]) = [],
  minimumBridgeVersion?: number,
): Promise<ToolResponse> {
  try {
    const requiresV7 = minimumBridgeVersion === 7 || params.ExpectedSceneRevision !== undefined || params.LeaseId !== undefined || params.IdempotencyKey !== undefined;
    const versionOption = minimumBridgeVersion !== undefined
      ? { minimumBridgeVersion }
      : requiresV7 ? { minimumBridgeVersion: 7 } : {};
    const response = await callEditorBridge(ctx, method, params, versionOption);
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: response.mode,
      data,
      // A result DTO may carry its own Warnings (for example a brush the engine
      // accepts but would not draw); they belong in the envelope too.
      warnings: [...response.warnings, ...bridgeWarnings(response.data)],
      changes: typeof changes === 'function' ? changes(response.data) : changes,
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
export const handleSceneOpen = (args: z.infer<typeof SceneOpenSchema>, ctx: ProjectMeta) =>
  // Scene load is async: Phase 'opening' means poll scene_list_loaded; Phase
  // 'already_loaded' is a no-op success for an already-loaded scene ID.
  // replace/reload/discard_unsaved are sent only when set, so a plain open
  // stays wire-identical to bridge v25 and runs against it.
  liveCall(ctx, 'scene.open', {
    AssetId: args.asset_id,
    Path: args.path,
    AllowDirtyScenes: args.allow_dirty_scenes,
    ...(args.replace ? { Replace: true } : {}),
    ...(args.reload ? { Reload: true } : {}),
    ...(args.discard_unsaved ? { DiscardUnsaved: true } : {}),
  }, [{ kind: args.replace ? 'scene.replaced' : args.reload ? 'scene.reloaded' : 'scene.opened', id: args.asset_id ?? args.path }],
  args.replace || args.reload || args.discard_unsaved ? BRIDGE_V34 : 25);
export const handleProjectSaveAll = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'project.save_all', {}, [{ kind: 'project.saved' }]);
export const handleActorGet = (args: z.infer<typeof ActorGetSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'actor.get', { ActorId: args.actor_id });
export const handleActorFind = (args: z.infer<typeof ActorFindSchema>, ctx: ProjectMeta) => {
  if (args.name === undefined && args.type_name === undefined && args.parent_id === undefined && args.active === undefined) {
    return Promise.resolve(toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide at least one actor find filter.')));
  }
  return liveCall(ctx, 'actor.find', {
    Name: args.name,
    TypeName: args.type_name,
    ParentId: args.parent_id,
    Active: args.active,
    MaxResults: args.max_results,
  }, [], args.type_name !== undefined || args.parent_id !== undefined || args.active !== undefined ? 7 : undefined);
};

export async function handleActorCreate(args: z.infer<typeof ActorCreateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = {
    TypeName: args.type_name,
    Name: args.name,
    ParentId: args.parent_id,
    Active: args.active,
    Position: toBridgeVector(args.position),
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.idempotency_key,
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
    args.euler_angles === undefined &&
    args.local_position === undefined &&
    args.local_scale === undefined &&
    args.local_euler_angles === undefined &&
    args.layer === undefined &&
    args.skinned_model_id === undefined &&
    args.skinned_model_path === undefined &&
    args.animation_graph_id === undefined &&
    args.animation_graph_path === undefined &&
    args.static_model_id === undefined &&
    args.static_model_path === undefined &&
    args.update_when_offscreen === undefined
  ) {
    return toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide at least one actor field to update.'));
  }
  const hasWorldTransform = args.position !== undefined || args.scale !== undefined || args.euler_angles !== undefined;
  const hasLocalTransform = args.local_position !== undefined || args.local_scale !== undefined || args.local_euler_angles !== undefined;
  if (hasWorldTransform && hasLocalTransform) {
    return toolError(new ToolDomainError('VALIDATION_FAILED', 'World-space and local-space transform patches cannot be combined in one actor update.'));
  }
  const params = {
    ActorId: args.actor_id,
    Name: args.name,
    Active: args.active,
    Position: toBridgeVector(args.position),
    Scale: toBridgeVector(args.scale),
    EulerAngles: toBridgeVector(args.euler_angles),
    LocalPosition: toBridgeVector(args.local_position),
    LocalScale: toBridgeVector(args.local_scale),
    LocalEulerAngles: toBridgeVector(args.local_euler_angles),
    Layer: args.layer,
    SkinnedModelId: args.skinned_model_id,
    SkinnedModelPath: args.skinned_model_path,
    AnimationGraphId: args.animation_graph_id,
    AnimationGraphPath: args.animation_graph_path,
    StaticModelId: args.static_model_id,
    StaticModelPath: args.static_model_path,
    UpdateWhenOffscreen: args.update_when_offscreen,
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.idempotency_key,
  };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(
    ctx,
    'actor.update',
    params,
    [{ kind: 'actor.updated', id: args.actor_id }],
    hasLocalTransform || args.layer !== undefined || args.skinned_model_id !== undefined || args.skinned_model_path !== undefined
      || args.animation_graph_id !== undefined || args.animation_graph_path !== undefined
      || args.static_model_id !== undefined || args.static_model_path !== undefined
      || args.update_when_offscreen !== undefined ? 7 : undefined,
  );
}

export async function handleActorDelete(args: z.infer<typeof ActorDeleteSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id, ExpectedSceneRevision: args.expected_scene_revision, LeaseId: args.lease_id, IdempotencyKey: args.idempotency_key };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', params, { action: 'delete' });
  return liveCall(ctx, 'actor.delete', params, [{ kind: 'actor.deleted', id: args.actor_id }]);
}

export async function handleActorDuplicate(args: z.infer<typeof ActorDuplicateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id, ExpectedSceneRevision: args.expected_scene_revision, LeaseId: args.lease_id, IdempotencyKey: args.idempotency_key };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', params, { action: 'duplicate' });
  return liveCall(ctx, 'actor.duplicate', params, [{ kind: 'actor.duplicated', sourceId: args.actor_id }]);
}

export async function handleActorReparent(args: z.infer<typeof ActorReparentSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = {
    ActorId: args.actor_id,
    ParentId: args.parent_id,
    KeepWorldTransform: args.keep_world_transform,
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.idempotency_key,
  };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(ctx, 'actor.reparent', params, [{ kind: 'actor.reparented', id: args.actor_id, parentId: args.parent_id ?? null }]);
}

export async function handleScriptAttach(args: z.infer<typeof ScriptAttachSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ActorId: args.actor_id, ScriptType: args.script_type, ExpectedSceneRevision: args.expected_scene_revision, LeaseId: args.lease_id, IdempotencyKey: args.idempotency_key };
  if (args.dry_run) return dryRunLookup(ctx, 'actor.get', { ActorId: args.actor_id }, params);
  return liveCall(ctx, 'script.attach', params, [{ kind: 'script.attached', actorId: args.actor_id, type: args.script_type }]);
}

export async function handleScriptDetach(args: z.infer<typeof ScriptDetachSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const params = { ScriptId: args.script_id, ExpectedSceneRevision: args.expected_scene_revision, LeaseId: args.lease_id, IdempotencyKey: args.idempotency_key };
  if (args.dry_run) return dryRunLookup(ctx, 'script.instance_get', params, { action: 'detach' });
  return liveCall(ctx, 'script.detach', params, [{ kind: 'script.detached', id: args.script_id }]);
}

export const handleScriptInstanceGet = (args: z.infer<typeof ScriptInstanceGetSchema>, ctx: ProjectMeta) =>
  // IncludeValues is sent only when opted in so default reads stay wire-identical
  // to previous bridge versions. Bridges without the P7 read surface return the
  // legacy DTO without Values; callers must check ValuesIncluded.
  liveCall(ctx, 'script.instance_get', args.include_values ? { ScriptId: args.script_id, IncludeValues: true } : { ScriptId: args.script_id });

export async function handleScriptInstanceUpdate(
  args: z.infer<typeof ScriptInstanceUpdateSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  if (args.enabled === undefined) {
    return toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide enabled; arbitrary serialized script properties are not supported.'));
  }
  const params = { ScriptId: args.script_id, Enabled: args.enabled, ExpectedSceneRevision: args.expected_scene_revision, LeaseId: args.lease_id, IdempotencyKey: args.idempotency_key };
  if (args.dry_run) return dryRunLookup(ctx, 'script.instance_get', { ScriptId: args.script_id }, params);
  return liveCall(ctx, 'script.instance_update', params, [{ kind: 'script.updated', id: args.script_id }]);
}

function splitScalarValue(value: boolean | number | string): { Bool?: boolean; Number?: number; Text?: string } {
  if (typeof value === 'boolean') return { Bool: value };
  if (typeof value === 'number') return { Number: value };
  return { Text: value };
}

export async function handleScriptInstanceSetValue(
  args: z.infer<typeof ScriptInstanceSetValueSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  // Bridge-native dry-run: the coercion needs the live field type, so the
  // preview runs bridge-side (graph.set_default_parameter precedent) rather
  // than as a client-side read. Dry runs never consume idempotency keys.
  const params = {
    ScriptId: args.script_id,
    ...(args.path === undefined ? { Field: args.field } : { Path: args.path }),
    ...splitScalarValue(args.value),
    DryRun: args.dry_run,
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.dry_run ? undefined : args.idempotency_key,
  };
  return liveCall(
    ctx,
    'script.instance_set_value',
    params,
    // The bridge writes nothing (and reports WouldChange:false) when the member already held the value.
    result => (args.dry_run || (result as { WouldChange?: unknown } | null)?.WouldChange === false
      ? []
      : [{ kind: 'script.field_set', id: args.script_id, field: args.path === undefined ? args.field : args.path.join('.') }]),
    args.path === undefined ? 28 : BRIDGE_V34,
  );
}

export async function handleActorSetProperty(
  args: z.infer<typeof ActorSetPropertySchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  // DryRun is sent only when requested so alias writes stay wire-identical
  // to bridge v28. Dry runs never consume idempotency keys.
  const params = {
    ActorId: args.target_id,
    ...(args.path === undefined ? { Property: args.property } : { Path: args.path }),
    ...splitScalarValue(args.value),
    ...(args.dry_run ? { DryRun: true } : {}),
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: args.dry_run ? undefined : args.idempotency_key,
  };
  return liveCall(
    ctx,
    'actor.set_property',
    params,
    // A v33 bridge reports WouldChange:false when the member already held
    // the value; it then writes nothing. Older bridges omit the field.
    result => (args.dry_run || (result as { WouldChange?: unknown } | null)?.WouldChange === false
      ? []
      : [{ kind: 'actor.property_set', id: args.target_id, property: args.path === undefined ? args.property : args.path.join('.') }]),
    args.path !== undefined ? BRIDGE_V34 : args.property !== undefined && LEGACY_ACTOR_PROPERTIES.has(args.property) && !args.dry_run ? 28 : 33,
  );
}

export const handleEditUndo = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.undo', {}, [{ kind: 'edit.undo' }]);
export const handleEditRedo = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.redo', {}, [{ kind: 'edit.redo' }]);

export const handleEditLeaseBegin = (args: z.infer<typeof EditLeaseBeginSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.lease_begin', { SceneId: args.scene_id, AssetId: args.asset_id, Path: args.path, Owner: args.owner, TtlMs: args.ttl_ms }, [{ kind: 'edit.lease.begun', sceneId: args.scene_id, assetId: args.asset_id, path: args.path }]);
export const handleEditLeaseGet = (args: z.infer<typeof EditLeaseGetSchema>, ctx: ProjectMeta) => {
  if (args.scene_id === undefined && args.lease_id === undefined) {
    return Promise.resolve(toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide scene_id or lease_id.')));
  }
  return liveCall(ctx, 'edit.lease_get', { SceneId: args.scene_id, LeaseId: args.lease_id });
};
export const handleEditLeaseCommit = (args: z.infer<typeof EditLeaseCommitSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.lease_commit', { LeaseId: args.lease_id }, [{ kind: 'edit.lease.committed', leaseId: args.lease_id }]);
export const handleEditLeaseRelease = (args: z.infer<typeof EditLeaseReleaseSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'edit.lease_release', { LeaseId: args.lease_id }, [{ kind: 'edit.lease.released', leaseId: args.lease_id }]);

export const handleEditorGetSelection = (_: unknown, ctx: ProjectMeta) =>
  liveCall(ctx, 'editor.get_selection', {}, [], 24);
export const handleEditorSetSelection = (args: z.infer<typeof EditorSetSelectionSchema>, ctx: ProjectMeta) =>
  liveCall(ctx, 'editor.set_selection', {
    ActorIds: args.actor_ids,
    FocusViewport: args.focus_viewport,
  }, [{ kind: 'editor.selection', count: args.actor_ids.length }], 24);
