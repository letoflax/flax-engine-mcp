import { z } from 'zod';
import { ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { BRIDGE_V34, ConfirmedWrite, ContentPath, FlaxId, callLive, requiresConfirmation } from './liveToolSupport.js';

// Bridge v33 scene and content lifecycle: create a scene file from the Editor
// template, close a loaded scene, create a Content folder, and create an empty
// asset. Creation never overwrites and has no Editor undo record.

/** Tags accepted by FlaxEditor.Editor.CreateAsset, as used by the Editor's own asset proxies. */
export const ASSET_CREATE_KINDS = [
  'Material', 'MaterialInstance', 'MaterialFunction', 'ParticleEmitter', 'ParticleEmitterFunction', 'ParticleSystem',
  'AnimationGraph', 'AnimationGraphFunction', 'Animation', 'SceneAnimation', 'SkeletonMask', 'BehaviorTree', 'CollisionData',
  'GameplayGlobals',
] as const;

/** Variable types the bridge writes into a new GameplayGlobals asset (what the Editor GameplayGlobals window offers). */
export const GAMEPLAY_GLOBALS_VARIABLE_TYPES = ['float', 'int', 'bool', 'Float2', 'Float3', 'Float4', 'Color'] as const;
export const GAMEPLAY_GLOBALS_MAX_VARIABLES = 64;

const ScenePath = ContentPath.superRefine((value, ctx) => {
  if (!value.toLowerCase().endsWith('.scene')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A scene destination must use a .scene path.' });
  }
});

const ContentFolderPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  if (value.replaceAll('\\', '/') !== value || !value.startsWith('Content/')
    || value.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative folder below Content/ without traversal or a trailing slash.' });
  }
});

export const SceneCreateSchema = z.object({
  path: ScenePath.describe('New scene file, for example Content/Scenes/Level02.scene. Missing parent folders are created.'),
  ...ConfirmedWrite,
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine(requiresConfirmation);

export const SceneCloseSchema = z.object({
  scene_id: FlaxId,
  allow_dirty: z.boolean().optional().default(false)
    .describe('Close even when the scene has unsaved edits, discarding them. Without it an edited scene is refused with DIRTY_SCENES.'),
});

export const ContentCreateFolderSchema = z.object({
  path: ContentFolderPath.describe('Folder to create, for example Content/Gameplay/Enemies. Missing parents are created; an existing folder is a no-op.'),
  dry_run: z.boolean().optional().default(false),
});

const GameplayGlobalsVariable = z.object({
  name: z.string().min(1).max(128),
  type: z.enum(GAMEPLAY_GLOBALS_VARIABLE_TYPES),
  value: z.string().min(1).max(256)
    .describe('Invariant-culture text: 1.5, 3, true, "1,2" (Float2), "1,2,3", "1,2,3,4", or Color "r,g,b" / "r,g,b,a" with components 0-1.'),
}).strict();

export const AssetCreateSchema = z.object({
  kind: z.enum([...ASSET_CREATE_KINDS, 'JsonAsset'])
    .describe('Editor asset tag for a binary .flax asset, or JsonAsset for a .json data asset of type_name. GameplayGlobals (bridge v34) takes optional variables.'),
  path: ContentPath.describe('New asset file: .flax for binary kinds, .json for JsonAsset. Missing parent folders are created.'),
  type_name: z.string().min(1).max(256).optional()
    .describe('JsonAsset only: fully qualified data class, for example FlaxEngine.PhysicalMaterial or a game settings class. Accepts what the Editor "Json Asset" dialog accepts.'),
  variables: z.array(GameplayGlobalsVariable).max(GAMEPLAY_GLOBALS_MAX_VARIABLES).optional()
    .describe('GameplayGlobals only (at most 64): default variables written into the new asset. Names must be unique.'),
  ...ConfirmedWrite,
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  const lower = value.path.toLowerCase();
  if (value.variables !== undefined) {
    if (value.kind !== 'GameplayGlobals') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variables'], message: 'variables are only valid with kind GameplayGlobals.' });
    } else {
      const seen = new Set<string>();
      value.variables.forEach((variable, index) => {
        const name = variable.name.trim();
        if (name.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variables', index, 'name'], message: 'A variable name must not be blank.' });
        else if (seen.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variables', index, 'name'], message: `Duplicate variable name "${name}".` });
        seen.add(name);
      });
    }
  }
  if (value.kind === 'JsonAsset') {
    if (value.type_name === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type_name'], message: 'type_name is required for kind JsonAsset.' });
    if (!lower.endsWith('.json')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'A JsonAsset destination must use a .json path.' });
  } else {
    if (value.type_name !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type_name'], message: 'type_name is only valid with kind JsonAsset.' });
    if (!lower.endsWith('.flax')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'A binary asset destination must use a .flax path.' });
  }
  requiresConfirmation(value, ctx);
});

/** Reports a change only when the bridge actually created something. */
function createdChange(kind: string, detail: Record<string, unknown>): (result: Record<string, unknown>) => unknown[] {
  return result => (result.Created === true ? [{ kind, ...detail }] : []);
}

export const handleSceneCreate = (args: z.infer<typeof SceneCreateSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'scene.create', {
    Path: args.path,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.dry_run ? undefined : args.idempotency_key,
  }, { changes: createdChange('scene.created', { path: args.path }) });

export const handleSceneClose = (args: z.infer<typeof SceneCloseSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  // The unload is asynchronous: Phase "closing" means poll scene_list_loaded.
  callLive(ctx, 'scene.close', { SceneId: args.scene_id, AllowDirty: args.allow_dirty },
    { changes: [{ kind: 'scene.closed', id: args.scene_id }] });

export const handleContentCreateFolder = (args: z.infer<typeof ContentCreateFolderSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'content.create_folder', { Path: args.path, DryRun: args.dry_run },
    { changes: createdChange('content.folder_created', { path: args.path }) });

export const handleAssetCreate = (args: z.infer<typeof AssetCreateSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'asset.create', {
    Kind: args.kind,
    Path: args.path,
    TypeName: args.type_name,
    Variables: args.variables?.map(variable => ({ Name: variable.name, Type: variable.type, Value: variable.value })),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.dry_run ? undefined : args.idempotency_key,
  }, {
    changes: createdChange('asset.created', { assetKind: args.kind, path: args.path }),
    // Only the GameplayGlobals kind needs the v34 bridge; every other kind keeps working on v33.
    minimumBridgeVersion: args.kind === 'GameplayGlobals' ? BRIDGE_V34 : undefined,
  });
