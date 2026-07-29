import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ProjectMeta } from '../projectContext.js';
import { ToolResponse } from '../errors.js';
import { assertPermissionRegistryCoverage } from '../permissions.js';
import {
  OperationCancelSchema,
  OperationGetStatusSchema,
  handleOperationCancel,
  handleOperationGetStatus,
} from '../operations.js';

// Existing tools
import { GetProjectInfoSchema, GetGameSettingsSchema, handleGetProjectInfo, handleGetGameSettings } from './project.js';
import { ListScriptsSchema, ReadScriptSchema, WriteScriptSchema, ApplyScriptPatchSchema, handleListScripts, handleReadScript, handleWriteScript, handleApplyScriptPatch } from './scripts.js';
import { GetAuditEntriesSchema, handleGetAuditEntries } from '../audit.js';
import { ListAssetsSchema, GetSceneActorsSchema, handleGetSceneActors } from './assets.js';
import { ReadSettingsSchema, handleReadSettings } from './settings.js';
import { SearchInFilesSchema, handleSearchInFiles } from './files.js';
import { GetLatestLogSchema, handleGetLatestLog } from './logs.js';

// New tools
import { GetAssetInfoSchema, ReimportAssetSchema, handleReimportAsset } from './assetInfo.js';
import {
  AssetDependenciesSchema,
  AssetFindReferencesSchema,
  AssetGetSchema,
  AssetSearchSchema,
  handleAssetDependencies,
  handleAssetFindReferences,
  handleAssetGet,
  handleAssetSearch,
  handleGetAssetInfoCompatibility,
  handleListAssetsCompatibility,
} from './assetLive.js';
import {
  AssetImportSchema,
  AssetOperationStatusSchema,
  AssetReimportSchema,
  handleAssetImport,
  handleAssetImportStatus,
  handleAssetReimport,
  handleAssetReimportStatus,
} from './assetImport.js';
import {
  AssetDuplicateSchema,
  AssetMoveSchema,
  AssetRenameSchema,
  handleAssetDuplicate,
  handleAssetMove,
  handleAssetRename,
} from './assetOrganize.js';
import {
  PrefabApplyOverridesSchema,
  PrefabBreakLinkSchema,
  PrefabCreateFromActorSchema,
  PrefabGetInstancesSchema,
  PrefabGetOverridesSchema,
  PrefabInstantiateSchema,
  PrefabRevertOverridesSchema,
  handlePrefabApplyOverrides,
  handlePrefabBreakLink,
  handlePrefabCreateFromActor,
  handlePrefabGetInstances,
  handlePrefabGetOverrides,
  handlePrefabInstantiate,
  handlePrefabRevertOverrides,
} from './prefabLive.js';
import { GetScriptClassesSchema, FindReferencesSchema, ListNetworkedScriptsSchema, handleGetScriptClasses, handleFindReferences, handleListNetworkedScripts } from './codeAnalysis.js';
import { GenerateScriptSchema, handleGenerateScript } from './codeGen.js';
import { CreateActorSchema, ModifyActorSchema, handleCreateActor, handleModifyActor } from './sceneWrite.js';
import { GetProjectSummarySchema, GetCompilerErrorsSchema, ValidateProjectSchema, handleGetProjectSummary, handleGetCompilerErrors, handleValidateProject } from './intelligence.js';
import { GetInputActionsSchema, GetPhysicsSettingsSchema, handleGetInputActions, handleGetPhysicsSettings } from './config.js';
import { ListDocsSchema, ReadDocSchema, handleListDocs, handleReadDoc } from './docs.js';
import {
  EditorGetStatusSchema,
  GetServerCapabilitiesSchema,
  handleEditorGetStatus,
  handleGetServerCapabilities,
} from './serverStatus.js';
import {
  ServerGetHealthSchema,
  ServerGetMetricsSchema,
  ServerGetRecentErrorsSchema,
  handleServerGetHealth,
  handleServerGetMetrics,
  handleServerGetRecentErrors,
} from './serverObservability.js';
import {
  GetEditorBridgeInstallationSchema,
  InstallEditorBridgeSchema,
  handleGetEditorBridgeInstallation,
  handleInstallEditorBridge,
} from './bridgeInstaller.js';
import {
  ActorCreateSchema,
  ActorDeleteSchema,
  ActorDuplicateSchema,
  ActorFindSchema,
  ActorGetSchema,
  ActorReparentSchema,
  ActorUpdateSchema,
  EditRedoSchema,
  EditUndoSchema,
  EditLeaseBeginSchema,
  EditLeaseGetSchema,
  EditLeaseCommitSchema,
  EditLeaseReleaseSchema,
  ProjectSaveAllSchema,
  SceneGetTreeSchema,
  SceneListLoadedSchema,
  SceneSaveSchema,
  ScriptAttachSchema,
  ScriptDetachSchema,
  ScriptInstanceGetSchema,
  ScriptInstanceUpdateSchema,
  handleActorCreate,
  handleActorDelete,
  handleActorDuplicate,
  handleActorFind,
  handleActorGet,
  handleActorReparent,
  handleActorUpdate,
  handleEditRedo,
  handleEditUndo,
  handleEditLeaseBegin,
  handleEditLeaseGet,
  handleEditLeaseCommit,
  handleEditLeaseRelease,
  handleProjectSaveAll,
  handleSceneGetTree,
  handleSceneListLoaded,
  handleSceneSave,
  handleScriptAttach,
  handleScriptDetach,
  handleScriptInstanceGet,
  handleScriptInstanceUpdate,
} from './editorLive.js';
import {
  LogGetRecentSchema,
  LogGetRuntimeErrorsSchema,
  LogSearchSchema,
  RuntimeInspectActorSchema,
  ViewportCaptureSchema,
  handleLogGetRecent,
  handleLogGetRuntimeErrors,
  handleLogSearch,
  handleRuntimeInspectActor,
  handleViewportCapture,
} from './liveObservability.js';
import {
  CodeCompileSchema,
  CodeGenerateProjectSchema,
  CodeGetDiagnosticsSchema,
  PlayGetStatusSchema,
  PlayPauseSchema,
  PlayResumeSchema,
  PlayRunForSchema,
  PlayStartGameSchema,
  PlayStartScenesSchema,
  PlayStepFrameSchema,
  PlayStopSchema,
  handleCodeCompile,
  handleCodeGenerateProject,
  handleCodeGetDiagnostics,
  handlePlayGetStatus,
  handlePlayPause,
  handlePlayResume,
  handlePlayRunFor,
  handlePlayStartGame,
  handlePlayStartScenes,
  handlePlayStepFrame,
  handlePlayStop,
} from './runtimeLive.js';
import {
  BuildCookSchema,
  BuildListTargetsSchema,
  BuildOperationSchema,
  BuildValidateSchema,
  handleBuildCancel,
  handleBuildCook,
  handleBuildGetResult,
  handleBuildGetStatus,
  handleBuildListTargets,
  handleBuildValidate,
} from './buildLive.js';

export interface ToolDefinition {
  name: string;
  description: string;
  /** Runtime source of truth; the JSON schema is only the protocol projection. */
  zodInputSchema: z.ZodTypeAny;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  outputSchema: ReturnType<typeof zodToJsonSchema>;
  annotations: ToolAnnotations;
  handler: (args: unknown, ctx: ProjectMeta) => Promise<ToolResponse>;
}

const INPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  get_server_capabilities: GetServerCapabilitiesSchema,
  editor_get_status: EditorGetStatusSchema,
  server_get_health: ServerGetHealthSchema,
  server_get_metrics: ServerGetMetricsSchema,
  server_get_recent_errors: ServerGetRecentErrorsSchema,
  get_editor_bridge_installation: GetEditorBridgeInstallationSchema,
  install_editor_bridge: InstallEditorBridgeSchema,
  scene_list_loaded: SceneListLoadedSchema,
  scene_get_tree: SceneGetTreeSchema,
  scene_save: SceneSaveSchema,
  project_save_all: ProjectSaveAllSchema,
  actor_get: ActorGetSchema,
  actor_find: ActorFindSchema,
  actor_create: ActorCreateSchema,
  actor_update: ActorUpdateSchema,
  actor_delete: ActorDeleteSchema,
  actor_duplicate: ActorDuplicateSchema,
  actor_reparent: ActorReparentSchema,
  script_attach: ScriptAttachSchema,
  script_detach: ScriptDetachSchema,
  script_instance_get: ScriptInstanceGetSchema,
  script_instance_update: ScriptInstanceUpdateSchema,
  edit_undo: EditUndoSchema,
  edit_redo: EditRedoSchema,
  edit_begin_lease: EditLeaseBeginSchema,
  edit_get_lease: EditLeaseGetSchema,
  edit_commit_lease: EditLeaseCommitSchema,
  edit_release_lease: EditLeaseReleaseSchema,
  log_get_recent: LogGetRecentSchema,
  log_search: LogSearchSchema,
  log_get_runtime_errors: LogGetRuntimeErrorsSchema,
  viewport_capture: ViewportCaptureSchema,
  runtime_inspect_actor: RuntimeInspectActorSchema,
  code_compile: CodeCompileSchema,
  code_get_diagnostics: CodeGetDiagnosticsSchema,
  code_generate_project: CodeGenerateProjectSchema,
  operation_get_status: OperationGetStatusSchema,
  operation_cancel: OperationCancelSchema,
  build_list_targets: BuildListTargetsSchema,
  build_validate: BuildValidateSchema,
  build_cook: BuildCookSchema,
  build_get_status: BuildOperationSchema,
  build_get_result: BuildOperationSchema,
  build_cancel: BuildOperationSchema,
  play_get_status: PlayGetStatusSchema,
  play_start_scenes: PlayStartScenesSchema,
  play_start_game: PlayStartGameSchema,
  play_stop: PlayStopSchema,
  play_pause: PlayPauseSchema,
  play_resume: PlayResumeSchema,
  play_step_frame: PlayStepFrameSchema,
  play_run_for: PlayRunForSchema,
  get_project_info: GetProjectInfoSchema,
  get_game_settings: GetGameSettingsSchema,
  get_project_summary: GetProjectSummarySchema,
  list_scripts: ListScriptsSchema,
  read_script: ReadScriptSchema,
  write_script: WriteScriptSchema,
  apply_script_patch: ApplyScriptPatchSchema,
  get_audit_entries: GetAuditEntriesSchema,
  get_script_classes: GetScriptClassesSchema,
  find_references: FindReferencesSchema,
  list_networked_scripts: ListNetworkedScriptsSchema,
  search_in_files: SearchInFilesSchema,
  generate_script: GenerateScriptSchema,
  get_scene_actors: GetSceneActorsSchema,
  create_actor: CreateActorSchema,
  modify_actor: ModifyActorSchema,
  get_asset_info: GetAssetInfoSchema,
  reimport_asset: ReimportAssetSchema,
  list_assets: ListAssetsSchema,
  asset_search: AssetSearchSchema,
  asset_get: AssetGetSchema,
  asset_dependencies: AssetDependenciesSchema,
  asset_find_references: AssetFindReferencesSchema,
  asset_import: AssetImportSchema,
  asset_import_status: AssetOperationStatusSchema,
  asset_reimport: AssetReimportSchema,
  asset_reimport_status: AssetOperationStatusSchema,
  asset_move: AssetMoveSchema,
  asset_rename: AssetRenameSchema,
  asset_duplicate: AssetDuplicateSchema,
  prefab_create_from_actor: PrefabCreateFromActorSchema,
  prefab_instantiate: PrefabInstantiateSchema,
  prefab_get_instances: PrefabGetInstancesSchema,
  prefab_get_overrides: PrefabGetOverridesSchema,
  prefab_apply_overrides: PrefabApplyOverridesSchema,
  prefab_revert_overrides: PrefabRevertOverridesSchema,
  prefab_break_link: PrefabBreakLinkSchema,
  read_settings: ReadSettingsSchema,
  get_input_actions: GetInputActionsSchema,
  get_physics_settings: GetPhysicsSettingsSchema,
  get_compiler_errors: GetCompilerErrorsSchema,
  validate_project: ValidateProjectSchema,
  list_docs: ListDocsSchema,
  read_doc: ReadDocSchema,
  get_latest_log: GetLatestLogSchema,
};

const TOOL_OUTPUT_SCHEMA = zodToJsonSchema(z.object({
  operationId: z.string().uuid(),
  mode: z.enum(['offline', 'editor-connected']),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
  warnings: z.array(z.string()),
  changes: z.array(z.unknown()),
  timing: z.object({ durationMs: z.number().nonnegative() }),
}).strict());

const WRITE_TOOL_NAMES = new Set([
  'write_script',
  'apply_script_patch',
  'generate_script',
  'create_actor',
  'modify_actor',
  'reimport_asset',
  'asset_import',
  'asset_reimport',
  'asset_move',
  'asset_rename',
  'asset_duplicate',
  'prefab_create_from_actor',
  'prefab_instantiate',
  'prefab_apply_overrides',
  'prefab_revert_overrides',
  'prefab_break_link',
  'install_editor_bridge',
  'scene_save',
  'project_save_all',
  'actor_create',
  'actor_update',
  'actor_delete',
  'actor_duplicate',
  'actor_reparent',
  'script_attach',
  'script_detach',
  'script_instance_update',
  'edit_undo',
  'edit_redo',
  'edit_begin_lease',
  'edit_commit_lease',
  'edit_release_lease',
  'viewport_capture',
  'code_compile',
  'code_generate_project',
  'operation_cancel',
  'build_cook',
  'build_cancel',
  'play_start_scenes',
  'play_start_game',
  'play_stop',
  'play_pause',
  'play_resume',
  'play_step_frame',
  'play_run_for',
]);

function annotationsFor(name: string): ToolAnnotations {
  const writes = WRITE_TOOL_NAMES.has(name);
  return {
    readOnlyHint: !writes,
    destructiveHint: name === 'write_script' ||
      name === 'apply_script_patch' ||
      name === 'create_actor' ||
      name === 'modify_actor' ||
      name === 'install_editor_bridge' ||
      name === 'actor_delete' ||
      name === 'script_detach' ||
      name === 'prefab_apply_overrides' ||
      name === 'prefab_revert_overrides' ||
      name === 'prefab_break_link',
    idempotentHint: !writes,
    openWorldHint: false,
  };
}

export function buildToolRegistry(ctx: ProjectMeta): ToolDefinition[] {
  const tools: Array<Omit<ToolDefinition, 'zodInputSchema' | 'outputSchema' | 'annotations'>> = [
    {
      name: 'get_server_capabilities',
      description: 'Reports server, project, and feature capabilities plus live Flax Editor Bridge availability.',
      inputSchema: zodToJsonSchema(GetServerCapabilitiesSchema),
      handler: (a, c) => handleGetServerCapabilities(a, c),
    },
    {
      name: 'editor_get_status',
      description: 'Reports whether a matching, live, recently heartbeating Flax Editor Bridge is connected.',
      inputSchema: zodToJsonSchema(EditorGetStatusSchema),
      handler: (a, c) => handleEditorGetStatus(a, c),
    },
    {
      name: 'server_get_health',
      description: 'Reports process-local server health and bridge availability without cloud telemetry or secrets.',
      inputSchema: zodToJsonSchema(ServerGetHealthSchema),
      handler: (a, c) => handleServerGetHealth(a, c),
    },
    {
      name: 'server_get_metrics',
      description: 'Returns bounded process-local tool timing, error, and IPC failure metrics. Metrics reset on restart.',
      inputSchema: zodToJsonSchema(ServerGetMetricsSchema),
      handler: (a, c) => handleServerGetMetrics(a, c),
    },
    {
      name: 'server_get_recent_errors',
      description: 'Returns up to 100 recent redacted process-local tool and IPC errors.',
      inputSchema: zodToJsonSchema(ServerGetRecentErrorsSchema),
      handler: (a, c) => handleServerGetRecentErrors(a as Parameters<typeof handleServerGetRecentErrors>[0], c),
    },
    {
      name: 'get_editor_bridge_installation',
      description: 'Reports bundled and installed Editor Bridge versions and hashes without exposing full filesystem paths.',
      inputSchema: zodToJsonSchema(GetEditorBridgeInstallationSchema),
      handler: (a, c) => handleGetEditorBridgeInstallation(a as Parameters<typeof handleGetEditorBridgeInstallation>[0], c),
    },
    {
      name: 'install_editor_bridge',
      description: 'Safely previews or installs the bundled Editor Bridge in a detected Flax game module with replacement guards.',
      inputSchema: zodToJsonSchema(InstallEditorBridgeSchema),
      handler: (a, c) => handleInstallEditorBridge(a as Parameters<typeof handleInstallEditorBridge>[0], c),
    },
    {
      name: 'scene_list_loaded',
      description: 'Lists scenes currently loaded in the connected Flax Editor.',
      inputSchema: zodToJsonSchema(SceneListLoadedSchema),
      handler: (a, c) => handleSceneListLoaded(a, c),
    },
    {
      name: 'scene_get_tree',
      description: 'Returns the live actor tree for a loaded scene from Flax Editor.',
      inputSchema: zodToJsonSchema(SceneGetTreeSchema),
      handler: (a, c) => handleSceneGetTree(a as Parameters<typeof handleSceneGetTree>[0], c),
    },
    {
      name: 'scene_save',
      description: 'Requests Flax Editor to save a loaded scene.',
      inputSchema: zodToJsonSchema(SceneSaveSchema),
      handler: (a, c) => handleSceneSave(a as Parameters<typeof handleSceneSave>[0], c),
    },
    {
      name: 'project_save_all',
      description: 'Requests Flax Editor to save all edited project content.',
      inputSchema: zodToJsonSchema(ProjectSaveAllSchema),
      handler: (a, c) => handleProjectSaveAll(a, c),
    },
    {
      name: 'actor_get',
      description: 'Reads a live actor by GUID from the connected editor.',
      inputSchema: zodToJsonSchema(ActorGetSchema),
      handler: (a, c) => handleActorGet(a as Parameters<typeof handleActorGet>[0], c),
    },
    {
      name: 'actor_find',
      description: 'Finds live actors by case-insensitive name substring and optional exact type, direct parent, or active-state filters.',
      inputSchema: zodToJsonSchema(ActorFindSchema),
      handler: (a, c) => handleActorFind(a as Parameters<typeof handleActorFind>[0], c),
    },
    {
      name: 'actor_create',
      description: 'Creates a resolved project or engine Actor type through Flax Editor with validated dry-run.',
      inputSchema: zodToJsonSchema(ActorCreateSchema),
      handler: (a, c) => handleActorCreate(a as Parameters<typeof handleActorCreate>[0], c),
    },
    {
      name: 'actor_update',
      description: 'Patches allowlisted live actor fields: name, active, one transform space (world or local), and layer. Uses editor Undo; arbitrary properties are not exposed.',
      inputSchema: zodToJsonSchema(ActorUpdateSchema),
      handler: (a, c) => handleActorUpdate(a as Parameters<typeof handleActorUpdate>[0], c),
    },
    {
      name: 'actor_delete',
      description: 'Deletes a live actor using the editor undo stack; supports dry-run.',
      inputSchema: zodToJsonSchema(ActorDeleteSchema),
      handler: (a, c) => handleActorDelete(a as Parameters<typeof handleActorDelete>[0], c),
    },
    {
      name: 'actor_duplicate',
      description: 'Duplicates a live actor using the editor undo stack; supports dry-run.',
      inputSchema: zodToJsonSchema(ActorDuplicateSchema),
      handler: (a, c) => handleActorDuplicate(a as Parameters<typeof handleActorDuplicate>[0], c),
    },
    {
      name: 'actor_reparent',
      description: 'Reparents a live actor with an optional preserved world transform.',
      inputSchema: zodToJsonSchema(ActorReparentSchema),
      handler: (a, c) => handleActorReparent(a as Parameters<typeof handleActorReparent>[0], c),
    },
    {
      name: 'script_attach',
      description: 'Attaches a resolved Script type to a live actor through Flax Editor.',
      inputSchema: zodToJsonSchema(ScriptAttachSchema),
      handler: (a, c) => handleScriptAttach(a as Parameters<typeof handleScriptAttach>[0], c),
    },
    {
      name: 'script_detach',
      description: 'Detaches a live script instance by GUID.',
      inputSchema: zodToJsonSchema(ScriptDetachSchema),
      handler: (a, c) => handleScriptDetach(a as Parameters<typeof handleScriptDetach>[0], c),
    },
    {
      name: 'script_instance_get',
      description: 'Reads a live script instance and its enabled state. Arbitrary serialized script properties are not exposed.',
      inputSchema: zodToJsonSchema(ScriptInstanceGetSchema),
      handler: (a, c) => handleScriptInstanceGet(a as Parameters<typeof handleScriptInstanceGet>[0], c),
    },
    {
      name: 'script_instance_update',
      description: 'Patches the enabled state of a live script instance. Arbitrary serialized script properties are not exposed.',
      inputSchema: zodToJsonSchema(ScriptInstanceUpdateSchema),
      handler: (a, c) => handleScriptInstanceUpdate(a as Parameters<typeof handleScriptInstanceUpdate>[0], c),
    },
    {
      name: 'edit_undo',
      description: 'Performs the last available Flax Editor undo action.',
      inputSchema: zodToJsonSchema(EditUndoSchema),
      handler: (a, c) => handleEditUndo(a, c),
    },
    {
      name: 'edit_redo',
      description: 'Performs the last available Flax Editor redo action.',
      inputSchema: zodToJsonSchema(EditRedoSchema),
      handler: (a, c) => handleEditRedo(a, c),
    },
    {
      name: 'edit_begin_lease',
      description: 'Begins a v7 scene edit lease with a bounded TTL. It is a visible-immediately coordination lock, not an atomic transaction.',
      inputSchema: zodToJsonSchema(EditLeaseBeginSchema),
      handler: (a, c) => handleEditLeaseBegin(a as Parameters<typeof handleEditLeaseBegin>[0], c),
    },
    {
      name: 'edit_get_lease',
      description: 'Gets a live v7 scene edit lease by scene or lease ID.',
      inputSchema: zodToJsonSchema(EditLeaseGetSchema),
      handler: (a, c) => handleEditLeaseGet(a as Parameters<typeof handleEditLeaseGet>[0], c),
    },
    {
      name: 'edit_commit_lease',
      description: 'Ends a v7 edit lease after visible edits. It does not create an atomic commit or rollback boundary.',
      inputSchema: zodToJsonSchema(EditLeaseCommitSchema),
      handler: (a, c) => handleEditLeaseCommit(a as Parameters<typeof handleEditLeaseCommit>[0], c),
    },
    {
      name: 'edit_release_lease',
      description: 'Releases a v7 edit lease. Existing edits remain visible; release never rolls them back.',
      inputSchema: zodToJsonSchema(EditLeaseReleaseSchema),
      handler: (a, c) => handleEditLeaseRelease(a as Parameters<typeof handleEditLeaseRelease>[0], c),
    },
    {
      name: 'code_compile',
      description: 'Starts Flax script compilation and optionally polls through assembly reload to a terminal result.',
      inputSchema: zodToJsonSchema(CodeCompileSchema),
      handler: (a, c) => handleCodeCompile(a as Parameters<typeof handleCodeCompile>[0], c),
    },
    {
      name: 'code_get_diagnostics',
      description: 'Reads structured, compilation-scoped diagnostics with bounded filtering and pagination.',
      inputSchema: zodToJsonSchema(CodeGetDiagnosticsSchema),
      handler: (a, c) => handleCodeGetDiagnostics(a as Parameters<typeof handleCodeGetDiagnostics>[0], c),
    },
    {
      name: 'code_generate_project',
      description: 'Starts generation of Flax solution/project files and optionally waits for completion.',
      inputSchema: zodToJsonSchema(CodeGenerateProjectSchema),
      handler: (a, c) => handleCodeGenerateProject(a as Parameters<typeof handleCodeGenerateProject>[0], c),
    },
    {
      name: 'operation_get_status',
      description: 'Reads one bounded persisted Bridge v11 operation by its exact handle. Raw operation handles are used; this is not MCP Tasks.',
      inputSchema: zodToJsonSchema(OperationGetStatusSchema),
      handler: (a, c) => handleOperationGetStatus(a as Parameters<typeof handleOperationGetStatus>[0], c),
    },
    {
      name: 'operation_cancel',
      description: 'Requests cancellation only when the active Bridge v11 backend advertises a safe cancellation checkpoint. Unsupported backends are reported accurately.',
      inputSchema: zodToJsonSchema(OperationCancelSchema),
      handler: (a, c) => handleOperationCancel(a as Parameters<typeof handleOperationCancel>[0], c),
    },
    {
      name: 'build_list_targets',
      description: 'Lists the small reviewed Flax GameCooker target allowlist. Listed targets are not a claim that the local platform toolchain is installed.',
      inputSchema: zodToJsonSchema(BuildListTargetsSchema),
      handler: (a, c) => handleBuildListTargets(a as Parameters<typeof handleBuildListTargets>[0], c),
    },
    {
      name: 'build_validate',
      description: 'Performs a non-mutating build/cook preflight for a reviewed target and an empty project-relative Builds/ output directory. Toolchain availability remains unknown until start.',
      inputSchema: zodToJsonSchema(BuildValidateSchema),
      handler: (a, c) => handleBuildValidate(a as Parameters<typeof handleBuildValidate>[0], c),
    },
    {
      name: 'build_cook',
      description: 'Starts one bounded Flax GameCooker build into an empty project-relative Builds/ directory. Supports dry-run and returns a raw operation handle; no arbitrary command line or preset is exposed.',
      inputSchema: zodToJsonSchema(BuildCookSchema),
      handler: (a, c) => handleBuildCook(a as Parameters<typeof handleBuildCook>[0], c),
    },
    {
      name: 'build_get_status',
      description: 'Reads the current bounded status of one bridge v13 build/cook operation.',
      inputSchema: zodToJsonSchema(BuildOperationSchema),
      handler: (a, c) => handleBuildGetStatus(a as Parameters<typeof handleBuildGetStatus>[0], c),
    },
    {
      name: 'build_get_result',
      description: 'Reads the terminal result of one bridge v13 build/cook operation; running operations return BUILD_NOT_COMPLETE.',
      inputSchema: zodToJsonSchema(BuildOperationSchema),
      handler: (a, c) => handleBuildGetResult(a as Parameters<typeof handleBuildGetResult>[0], c),
    },
    {
      name: 'build_cancel',
      description: 'Requests cancellation from Flax GameCooker for one active build/cook operation. The result is confirmed only by later status/result polling.',
      inputSchema: zodToJsonSchema(BuildOperationSchema),
      handler: (a, c) => handleBuildCancel(a as Parameters<typeof handleBuildCancel>[0], c),
    },
    {
      name: 'play_get_status',
      description: 'Returns the observed Flax play state, session, pause, compile, and dirty-scene status.',
      inputSchema: zodToJsonSchema(PlayGetStatusSchema),
      handler: (a, c) => handlePlayGetStatus(a as Parameters<typeof handlePlayGetStatus>[0], c),
    },
    {
      name: 'play_start_scenes',
      description: 'Starts the currently loaded scenes after compile and dirty-scene safety gates.',
      inputSchema: zodToJsonSchema(PlayStartScenesSchema),
      handler: (a, c) => handlePlayStartScenes(a as Parameters<typeof handlePlayStartScenes>[0], c),
    },
    {
      name: 'play_start_game',
      description: 'Starts play from the project first scene after compile and dirty-scene safety gates.',
      inputSchema: zodToJsonSchema(PlayStartGameSchema),
      handler: (a, c) => handlePlayStartGame(a as Parameters<typeof handlePlayStartGame>[0], c),
    },
    {
      name: 'play_stop',
      description: 'Stops play mode idempotently and optionally waits until the editor is stopped.',
      inputSchema: zodToJsonSchema(PlayStopSchema),
      handler: (a, c) => handlePlayStop(a as Parameters<typeof handlePlayStop>[0], c),
    },
    {
      name: 'play_pause',
      description: 'Pauses a running play session and optionally verifies the paused state.',
      inputSchema: zodToJsonSchema(PlayPauseSchema),
      handler: (a, c) => handlePlayPause(a as Parameters<typeof handlePlayPause>[0], c),
    },
    {
      name: 'play_resume',
      description: 'Resumes a paused play session and optionally verifies the running state.',
      inputSchema: zodToJsonSchema(PlayResumeSchema),
      handler: (a, c) => handlePlayResume(a as Parameters<typeof handlePlayResume>[0], c),
    },
    {
      name: 'play_step_frame',
      description: 'Advances a paused play session by a bounded number of frames.',
      inputSchema: zodToJsonSchema(PlayStepFrameSchema),
      handler: (a, c) => handlePlayStepFrame(a as Parameters<typeof handlePlayStepFrame>[0], c),
    },
    {
      name: 'play_run_for',
      description: 'Runs a bounded smoke-test session for time, frames, or a log condition and always attempts cleanup.',
      inputSchema: zodToJsonSchema(PlayRunForSchema),
      handler: (a, c) => handlePlayRunFor(a as Parameters<typeof handlePlayRunFor>[0], c),
    },
    {
      name: 'log_get_recent',
      description: 'Reads bounded, cursor-based log entries from the active editor session.',
      inputSchema: zodToJsonSchema(LogGetRecentSchema),
      handler: (a, c) => handleLogGetRecent(a as Parameters<typeof handleLogGetRecent>[0], c),
    },
    {
      name: 'log_search',
      description: 'Searches bounded live editor logs by safe substring or regular expression.',
      inputSchema: zodToJsonSchema(LogSearchSchema),
      handler: (a, c) => handleLogSearch(a as Parameters<typeof handleLogSearch>[0], c),
    },
    {
      name: 'log_get_runtime_errors',
      description: 'Returns bounded error, fatal, and exception logs for a play session.',
      inputSchema: zodToJsonSchema(LogGetRuntimeErrorsSchema),
      handler: (a, c) => handleLogGetRuntimeErrors(a as Parameters<typeof handleLogGetRuntimeErrors>[0], c),
    },
    {
      name: 'viewport_capture',
      description: 'Captures a bounded game or editor viewport image into the bridge cache and returns a resource URI.',
      inputSchema: zodToJsonSchema(ViewportCaptureSchema),
      handler: (a, c) => handleViewportCapture(a as Parameters<typeof handleViewportCapture>[0], c),
    },
    {
      name: 'runtime_inspect_actor',
      description: 'Reads an allowlisted, depth-bounded live actor snapshot while play mode is active.',
      inputSchema: zodToJsonSchema(RuntimeInspectActorSchema),
      handler: (a, c) => handleRuntimeInspectActor(a as Parameters<typeof handleRuntimeInspectActor>[0], c),
    },

    // ── Project Info ──────────────────────────────────────────────────────────
    {
      name: 'get_project_info',
      description: 'Returns Flax project config from .flaxproj and meta.xml: name, version, default scene, engine version, and directory layout.',
      inputSchema: zodToJsonSchema(GetProjectInfoSchema),
      handler: (a, c) => handleGetProjectInfo(a, c),
    },
    {
      name: 'get_game_settings',
      description: 'Returns Content/GameSettings.json with product name, company, first scene ID, and all sub-settings references.',
      inputSchema: zodToJsonSchema(GetGameSettingsSchema),
      handler: (a, c) => handleGetGameSettings(a, c),
    },
    {
      name: 'get_project_summary',
      description: 'Generates a full project overview in one call: all scripts with classes and fields, all scenes with actor counts, asset breakdown by type, settings list, and docs list. Best first tool to run in a new session.',
      inputSchema: zodToJsonSchema(GetProjectSummarySchema),
      handler: (a, c) => handleGetProjectSummary(a as Parameters<typeof handleGetProjectSummary>[0], c),
    },

    // ── Scripts ───────────────────────────────────────────────────────────────
    {
      name: 'list_scripts',
      description: 'Lists all C# game scripts in Source/ with name, path, size, and modification time. Optional name filter.',
      inputSchema: zodToJsonSchema(ListScriptsSchema),
      handler: (a, c) => handleListScripts(a as Parameters<typeof handleListScripts>[0], c),
    },
    {
      name: 'read_script',
      description: 'Reads the full source of a C# script by file name (e.g. "PlayerScript.cs") or relative path.',
      inputSchema: zodToJsonSchema(ReadScriptSchema),
      handler: (a, c) => handleReadScript(a as Parameters<typeof handleReadScript>[0], c),
    },
    {
      name: 'write_script',
      description: 'Creates or overwrites a C# script in Source/Game/. Set overwrite:true to replace an existing file. Supports dry_run and expected_hash; writes are atomic and audited.',
      inputSchema: zodToJsonSchema(WriteScriptSchema),
      handler: (a, c) => handleWriteScript(a as Parameters<typeof handleWriteScript>[0], c),
    },
    {
      name: 'apply_script_patch',
      description: 'Atomically applies a bounded unified diff to an existing C# script. The full patch is validated before any write; supports dry_run and expected_hash.',
      inputSchema: zodToJsonSchema(ApplyScriptPatchSchema),
      handler: (a, c) => handleApplyScriptPatch(a as Parameters<typeof handleApplyScriptPatch>[0], c),
    },
    {
      name: 'get_audit_entries',
      description: 'Returns recent redacted audit entries for script write and patch operations. Source content and patch text are never included.',
      inputSchema: zodToJsonSchema(GetAuditEntriesSchema),
      handler: (a, c) => handleGetAuditEntries(a as Parameters<typeof handleGetAuditEntries>[0], c),
    },

    // ── Code Analysis ─────────────────────────────────────────────────────────
    {
      name: 'get_script_classes',
      description: 'Parses C# files and extracts class structure: namespace, base class, public fields (with attributes like [Limit], [Tooltip]), and methods. Essential for understanding the codebase without reading every file.',
      inputSchema: zodToJsonSchema(GetScriptClassesSchema),
      handler: (a, c) => handleGetScriptClasses(a as Parameters<typeof handleGetScriptClasses>[0], c),
    },
    {
      name: 'find_references',
      description: 'Finds all scripts that reference a given class, type, method, or field name. Returns file and line number for each hit.',
      inputSchema: zodToJsonSchema(FindReferencesSchema),
      handler: (a, c) => handleFindReferences(a as Parameters<typeof handleFindReferences>[0], c),
    },
    {
      name: 'list_networked_scripts',
      description: 'Finds all scripts using Flax networking attributes: [NetworkReplicated], [NetworkRpc], NetworkScript, INetworkObject. Returns file and line for each usage.',
      inputSchema: zodToJsonSchema(ListNetworkedScriptsSchema),
      handler: (a, c) => handleListNetworkedScripts(a, c),
    },
    {
      name: 'search_in_files',
      description: 'Searches for a text pattern in C# scripts and/or markdown docs. Returns file:line:text in grep-style format.',
      inputSchema: zodToJsonSchema(SearchInFilesSchema),
      handler: (a, c) => handleSearchInFiles(a as Parameters<typeof handleSearchInFiles>[0], c),
    },

    // ── Code Generation ───────────────────────────────────────────────────────
    {
      name: 'generate_script',
      description: 'Generates a C# script from a built-in template. Templates: basic_script, network_script, weapon_script, player_input, animation_driver, scene_manager. Set save:true to write directly to Source/Game/.',
      inputSchema: zodToJsonSchema(GenerateScriptSchema),
      handler: (a, c) => handleGenerateScript(a as Parameters<typeof handleGenerateScript>[0], c),
    },

    // ── Scene (Read) ──────────────────────────────────────────────────────────
    {
      name: 'get_scene_actors',
      description: 'Parses a .scene file and returns the actor hierarchy with TypeNames and attached game scripts. Defaults to DefaultScene from .flaxproj.',
      inputSchema: zodToJsonSchema(GetSceneActorsSchema),
      handler: (a, c) => handleGetSceneActors(a as Parameters<typeof handleGetSceneActors>[0], c),
    },

    // ── Scene (Write) ─────────────────────────────────────────────────────────
    {
      name: 'create_actor',
      description: 'Adds a new actor to a .scene file. Specify TypeName (e.g. "FlaxEngine.EmptyActor"), display name, optional parent ID, and optional position. Automatically backs up the scene before writing.',
      inputSchema: zodToJsonSchema(CreateActorSchema),
      handler: (a, c) => handleCreateActor(a as Parameters<typeof handleCreateActor>[0], c),
    },
    {
      name: 'modify_actor',
      description: 'Updates an existing actor in a .scene file by ID or name. Can change display name, active state, and position. Backs up the scene before writing.',
      inputSchema: zodToJsonSchema(ModifyActorSchema),
      handler: (a, c) => handleModifyActor(a as Parameters<typeof handleModifyActor>[0], c),
    },

    // ── Asset Info ────────────────────────────────────────────────────────────
    {
      name: 'get_asset_info',
      description: 'Compatibility alias to asset_get for Content/... paths when bridge v8 is connected; otherwise preserves the legacy offline file inspection behavior.',
      inputSchema: zodToJsonSchema(GetAssetInfoSchema),
      handler: (a, c) => handleGetAssetInfoCompatibility(a as Parameters<typeof handleGetAssetInfoCompatibility>[0], c),
    },
    {
      name: 'reimport_asset',
      description: 'Shows current asset type and, if open_editor:true, launches FlaxEditor so you can reimport manually. NOTE: headless reimport is not supported by Flax CLI — the actual reimport must be done in the editor.',
      inputSchema: zodToJsonSchema(ReimportAssetSchema),
      handler: (a, c) => handleReimportAsset(a as Parameters<typeof handleReimportAsset>[0], c),
    },

    // ── Assets ────────────────────────────────────────────────────────────────
    {
      name: 'list_assets',
      description: 'Compatibility alias to asset_search for safe all/scene queries when bridge v8 is connected; otherwise preserves the legacy offline Content scanner.',
      inputSchema: zodToJsonSchema(ListAssetsSchema),
      handler: (a, c) => handleListAssetsCompatibility(a as Parameters<typeof handleListAssetsCompatibility>[0], c),
    },
    {
      name: 'asset_search',
      description: 'Searches the connected Flax Content registry with bounded, cursor-paginated metadata and direct dependency/reference counts. Requires bridge v8.',
      inputSchema: zodToJsonSchema(AssetSearchSchema),
      handler: (a, c) => handleAssetSearch(a as Parameters<typeof handleAssetSearch>[0], c),
    },
    {
      name: 'asset_get',
      description: 'Reads stable registry metadata for exactly one Content asset by GUID or project-relative path. Import settings are explicitly unavailable in Flax 1.12 public APIs. Requires bridge v8.',
      inputSchema: zodToJsonSchema(AssetGetSchema),
      handler: (a, c) => handleAssetGet(a as Parameters<typeof handleAssetGet>[0], c),
    },
    {
      name: 'asset_dependencies',
      description: 'Returns direct dependencies by default, or a cycle-safe transitive asset graph to max_depth 16. Results are cursor-paginated and use only public Asset.GetReferences data. Requires bridge v8.',
      inputSchema: zodToJsonSchema(AssetDependenciesSchema),
      handler: (a, c) => handleAssetDependencies(a as Parameters<typeof handleAssetDependencies>[0], c),
    },
    {
      name: 'asset_find_references',
      description: 'Finds bounded direct reverse references by scanning public asset references. Returns source asset/scene/prefab kinds only; actor/property locations are unavailable. Requires bridge v8.',
      inputSchema: zodToJsonSchema(AssetFindReferencesSchema),
      handler: (a, c) => handleAssetFindReferences(a as Parameters<typeof handleAssetFindReferences>[0], c),
    },
    {
      name: 'asset_import',
      description: 'Imports one allowlisted external source into Content/ through Flax Editor. No roots means denied; destination is a .flax file and never overwrites by default. Requires bridge v9.',
      inputSchema: zodToJsonSchema(AssetImportSchema),
      handler: (a, c) => handleAssetImport(a as Parameters<typeof handleAssetImport>[0], c),
    },
    {
      name: 'asset_import_status',
      description: 'Gets the bounded status for one asset_import operation. Requires bridge v9.',
      inputSchema: zodToJsonSchema(AssetOperationStatusSchema),
      handler: (a, c) => handleAssetImportStatus(a as Parameters<typeof handleAssetImportStatus>[0], c),
    },
    {
      name: 'asset_reimport',
      description: 'Reimports one binary Content asset using only its existing Flax source metadata and configured import roots. Requires bridge v9.',
      inputSchema: zodToJsonSchema(AssetReimportSchema),
      handler: (a, c) => handleAssetReimport(a as Parameters<typeof handleAssetReimport>[0], c),
    },
    {
      name: 'asset_reimport_status',
      description: 'Gets the bounded status for one asset_reimport operation. Requires bridge v9.',
      inputSchema: zodToJsonSchema(AssetOperationStatusSchema),
      handler: (a, c) => handleAssetReimportStatus(a as Parameters<typeof handleAssetReimportStatus>[0], c),
    },
    {
      name: 'asset_move',
      description: 'Moves one Content registry asset to an existing Content-relative folder through the Flax Editor Content database. Supports dry_run, collision policy, expected path/index guards, and idempotent retries. Requires bridge v10.',
      inputSchema: zodToJsonSchema(AssetMoveSchema),
      handler: (a, c) => handleAssetMove(a as Parameters<typeof handleAssetMove>[0], c),
    },
    {
      name: 'asset_rename',
      description: 'Renames one Content registry asset while preserving its extension through the Flax Content API. Supports dry_run, collision policy, expected path/index guards, and idempotent retries. Requires bridge v10.',
      inputSchema: zodToJsonSchema(AssetRenameSchema),
      handler: (a, c) => handleAssetRename(a as Parameters<typeof handleAssetRename>[0], c),
    },
    {
      name: 'asset_duplicate',
      description: 'Duplicates one Content registry asset into an existing Content-relative folder through the Flax Editor Content database. Existing references remain bound to the source asset. Requires bridge v10.',
      inputSchema: zodToJsonSchema(AssetDuplicateSchema),
      handler: (a, c) => handleAssetDuplicate(a as Parameters<typeof handleAssetDuplicate>[0], c),
    },

    // ── Prefabs ───────────────────────────────────────────────────────────────
    {
      name: 'prefab_create_from_actor',
      description: 'Creates a new Content/*.prefab from one loaded actor hierarchy using Flax’s public PrefabManager API. Existing files are never overwritten; auto_link defaults to false. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabCreateFromActorSchema),
      handler: (a, c) => handlePrefabCreateFromActor(a as Parameters<typeof handlePrefabCreateFromActor>[0], c),
    },
    {
      name: 'prefab_instantiate',
      description: 'Instantiates one prefab below a required loaded parent actor with bounded world transform and optional name. Supports dry-run, scene revision, lease, and idempotency guards. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabInstantiateSchema),
      handler: (a, c) => handlePrefabInstantiate(a as Parameters<typeof handlePrefabInstantiate>[0], c),
    },
    {
      name: 'prefab_get_instances',
      description: 'Lists prefab instance roots in currently loaded scenes with opaque cursor pagination. It cannot enumerate unloaded-scene instances. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabGetInstancesSchema),
      handler: (a, c) => handlePrefabGetInstances(a as Parameters<typeof handlePrefabGetInstances>[0], c),
    },
    {
      name: 'prefab_get_overrides',
      description: 'Reports a stable unsupported capability in Flax 1.12: public APIs do not expose a verified prefab override-diff reader. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabGetOverridesSchema),
      handler: (a, c) => handlePrefabGetOverrides(a as Parameters<typeof handlePrefabGetOverrides>[0], c),
    },
    {
      name: 'prefab_apply_overrides',
      description: 'Reports a stable unsupported capability. Although Flax exposes apply APIs, bridge v12 has no reviewed undo/preview/confirmation-safe path. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabApplyOverridesSchema),
      handler: (a, c) => handlePrefabApplyOverrides(a as Parameters<typeof handlePrefabApplyOverrides>[0], c),
    },
    {
      name: 'prefab_revert_overrides',
      description: 'Reports a stable unsupported capability. Dry-run defaults to true because Flax 1.12 has no verified public revert-overrides API. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabRevertOverridesSchema),
      handler: (a, c) => handlePrefabRevertOverrides(a as Parameters<typeof handlePrefabRevertOverrides>[0], c),
    },
    {
      name: 'prefab_break_link',
      description: 'Reports a stable unsupported capability. Link breaking needs an audited undo/preview/confirmation path before it can be exposed. Requires bridge v12.',
      inputSchema: zodToJsonSchema(PrefabBreakLinkSchema),
      handler: (a, c) => handlePrefabBreakLink(a as Parameters<typeof handlePrefabBreakLink>[0], c),
    },

    // ── Settings ──────────────────────────────────────────────────────────────
    {
      name: 'read_settings',
      description: 'Reads a settings file from Content/Settings/ by partial name. E.g. "Input" returns Input Settings.json.',
      inputSchema: zodToJsonSchema(ReadSettingsSchema),
      handler: (a, c) => handleReadSettings(a as Parameters<typeof handleReadSettings>[0], c),
    },
    {
      name: 'get_input_actions',
      description: 'Parses Input Settings.json and returns all input action mappings (key bindings, mouse buttons) and axis mappings (Mouse X/Y, gamepad sticks) in a readable format.',
      inputSchema: zodToJsonSchema(GetInputActionsSchema),
      handler: (a, c) => handleGetInputActions(a, c),
    },
    {
      name: 'get_physics_settings',
      description: 'Returns physics configuration: gravity, collision settings, bounce threshold, and layer masks.',
      inputSchema: zodToJsonSchema(GetPhysicsSettingsSchema),
      handler: (a, c) => handleGetPhysicsSettings(a, c),
    },

    // ── Project Intelligence ──────────────────────────────────────────────────
    {
      name: 'get_compiler_errors',
      description: 'Parses Flax Engine log files for C# compilation errors and warnings (error CS*, Build FAILED). Defaults to the most recent log file.',
      inputSchema: zodToJsonSchema(GetCompilerErrorsSchema),
      handler: (a, c) => handleGetCompilerErrors(a as Parameters<typeof handleGetCompilerErrors>[0], c),
    },
    {
      name: 'validate_project',
      description: 'Runs a health check on the project: unbalanced braces in scripts, missing required settings files, DefaultScene existence, and broken asset references. Returns a list of issues with severity.',
      inputSchema: zodToJsonSchema(ValidateProjectSchema),
      handler: (a, c) => handleValidateProject(a as Parameters<typeof handleValidateProject>[0], c),
    },

    // ── Documentation ─────────────────────────────────────────────────────────
    {
      name: 'list_docs',
      description: 'Lists all markdown (.md) documentation files in the project with name, size, and path.',
      inputSchema: zodToJsonSchema(ListDocsSchema),
      handler: (a, c) => handleListDocs(a, c),
    },
    {
      name: 'read_doc',
      description: 'Reads a markdown documentation file by name or partial name (e.g. "architecture" or "01-thiet-ke").',
      inputSchema: zodToJsonSchema(ReadDocSchema),
      handler: (a, c) => handleReadDoc(a as Parameters<typeof handleReadDoc>[0], c),
    },

    // ── Logs ──────────────────────────────────────────────────────────────────
    {
      name: 'get_latest_log',
      description: 'Reads the most recent Flax Engine log file. Supports tail mode (last N lines) and text filtering. Use all_logs:true to list all log files.',
      inputSchema: zodToJsonSchema(GetLatestLogSchema),
      handler: (a, c) => handleGetLatestLog(a as Parameters<typeof handleGetLatestLog>[0], c),
    },
  ];

  const registry = tools.map(tool => {
    const zodInputSchema = INPUT_SCHEMAS[tool.name];
    if (!zodInputSchema) {
      throw new Error(`Tool "${tool.name}" is missing its Zod input schema.`);
    }
    // Most schemas are objects and are made strict centrally. Schemas with
    // selector cross-field validation are already strict before superRefine.
    const strictSchema = zodInputSchema instanceof z.ZodObject ? zodInputSchema.strict() : zodInputSchema;
    return {
      ...tool,
      zodInputSchema: strictSchema,
      inputSchema: zodToJsonSchema(strictSchema),
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: annotationsFor(tool.name),
    };
  });
  assertPermissionRegistryCoverage(registry.map(tool => tool.name));
  return registry;
}
