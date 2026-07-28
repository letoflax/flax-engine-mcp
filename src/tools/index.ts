import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ProjectMeta } from '../projectContext.js';
import { ToolResponse } from '../errors.js';

// Existing tools
import { GetProjectInfoSchema, GetGameSettingsSchema, handleGetProjectInfo, handleGetGameSettings } from './project.js';
import { ListScriptsSchema, ReadScriptSchema, WriteScriptSchema, ApplyScriptPatchSchema, handleListScripts, handleReadScript, handleWriteScript, handleApplyScriptPatch } from './scripts.js';
import { GetAuditEntriesSchema, handleGetAuditEntries } from '../audit.js';
import { ListAssetsSchema, GetSceneActorsSchema, handleListAssets, handleGetSceneActors } from './assets.js';
import { ReadSettingsSchema, handleReadSettings } from './settings.js';
import { SearchInFilesSchema, handleSearchInFiles } from './files.js';
import { GetLatestLogSchema, handleGetLatestLog } from './logs.js';

// New tools
import { GetAssetInfoSchema, ReimportAssetSchema, handleGetAssetInfo, handleReimportAsset } from './assetInfo.js';
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

export interface ToolDefinition {
  name: string;
  description: string;
  /** Runtime source of truth; the JSON schema is only the protocol projection. */
  zodInputSchema: z.AnyZodObject;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  outputSchema: ReturnType<typeof zodToJsonSchema>;
  annotations: ToolAnnotations;
  handler: (args: unknown, ctx: ProjectMeta) => Promise<ToolResponse>;
}

const INPUT_SCHEMAS: Record<string, z.AnyZodObject> = {
  get_server_capabilities: GetServerCapabilitiesSchema,
  editor_get_status: EditorGetStatusSchema,
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
]);

function annotationsFor(name: string): ToolAnnotations {
  const writes = WRITE_TOOL_NAMES.has(name);
  return {
    readOnlyHint: !writes,
    destructiveHint: name === 'write_script' || name === 'apply_script_patch' || name === 'create_actor' || name === 'modify_actor',
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
      description: 'Reads asset metadata from any file in Content/. For .flax binary assets extracts TypeName (e.g. SkinnedModel, Model, MaterialInstance) and GUID from the CFWF header. For .scene/.json returns full parsed data.',
      inputSchema: zodToJsonSchema(GetAssetInfoSchema),
      handler: (a, c) => handleGetAssetInfo(a as Parameters<typeof handleGetAssetInfo>[0], c),
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
      description: 'Lists assets in Content/ by type (scene, material, settings, other). Returns name, path, and GUID.',
      inputSchema: zodToJsonSchema(ListAssetsSchema),
      handler: (a, c) => handleListAssets(a as Parameters<typeof handleListAssets>[0], c),
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

  return tools.map(tool => {
    const zodInputSchema = INPUT_SCHEMAS[tool.name];
    if (!zodInputSchema) {
      throw new Error(`Tool "${tool.name}" is missing its Zod input schema.`);
    }
    const strictSchema = zodInputSchema.strict();
    return {
      ...tool,
      zodInputSchema: strictSchema,
      inputSchema: zodToJsonSchema(strictSchema),
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: annotationsFor(tool.name),
    };
  });
}
