import { zodToJsonSchema } from 'zod-to-json-schema';
import { ProjectMeta } from '../projectContext.js';
import { ToolResponse } from '../errors.js';

import { GetProjectInfoSchema, GetGameSettingsSchema, handleGetProjectInfo, handleGetGameSettings } from './project.js';
import { ListScriptsSchema, ReadScriptSchema, WriteScriptSchema, handleListScripts, handleReadScript, handleWriteScript } from './scripts.js';
import { ListAssetsSchema, GetSceneActorsSchema, handleListAssets, handleGetSceneActors } from './assets.js';
import { ReadSettingsSchema, handleReadSettings } from './settings.js';
import { SearchInFilesSchema, handleSearchInFiles } from './files.js';
import { GetLatestLogSchema, handleGetLatestLog } from './logs.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  handler: (args: unknown, ctx: ProjectMeta) => Promise<ToolResponse>;
}

export function buildToolRegistry(ctx: ProjectMeta): ToolDefinition[] {
  return [
    {
      name: 'get_project_info',
      description: 'Returns Flax project configuration from .flaxproj and meta.xml: name, version, default scene, engine version, and directory overview.',
      inputSchema: zodToJsonSchema(GetProjectInfoSchema),
      handler: (a, c) => handleGetProjectInfo(a, c),
    },
    {
      name: 'get_game_settings',
      description: 'Returns parsed Content/GameSettings.json with product name, company, first scene ID, and references to all sub-settings (Input, Physics, Graphics, etc.).',
      inputSchema: zodToJsonSchema(GetGameSettingsSchema),
      handler: (a, c) => handleGetGameSettings(a, c),
    },
    {
      name: 'list_scripts',
      description: 'Lists all C# game scripts in Source/. Returns name, path, size, and modification time. Optional name filter.',
      inputSchema: zodToJsonSchema(ListScriptsSchema),
      handler: (a, c) => handleListScripts(a as Parameters<typeof handleListScripts>[0], c),
    },
    {
      name: 'read_script',
      description: 'Reads the full source of a C# script by file name (e.g. "PlayerScript.cs") or relative path from project root.',
      inputSchema: zodToJsonSchema(ReadScriptSchema),
      handler: (a, c) => handleReadScript(a as Parameters<typeof handleReadScript>[0], c),
    },
    {
      name: 'write_script',
      description: 'Creates or overwrites a C# script in Source/Game/. Set overwrite:true to replace an existing file. Creates parent directories automatically.',
      inputSchema: zodToJsonSchema(WriteScriptSchema),
      handler: (a, c) => handleWriteScript(a as Parameters<typeof handleWriteScript>[0], c),
    },
    {
      name: 'list_assets',
      description: 'Lists assets in Content/ by type (scene, material, settings, other). Returns name, path, and GUID for each asset.',
      inputSchema: zodToJsonSchema(ListAssetsSchema),
      handler: (a, c) => handleListAssets(a as Parameters<typeof handleListAssets>[0], c),
    },
    {
      name: 'get_scene_actors',
      description: 'Parses a .scene file and returns the actor hierarchy with TypeNames and attached game scripts. Defaults to DefaultScene from .flaxproj.',
      inputSchema: zodToJsonSchema(GetSceneActorsSchema),
      handler: (a, c) => handleGetSceneActors(a as Parameters<typeof handleGetSceneActors>[0], c),
    },
    {
      name: 'read_settings',
      description: 'Reads a settings file from Content/Settings/ by partial name (e.g. "Input" returns "Input Settings.json"). Lists all available files if name is ambiguous.',
      inputSchema: zodToJsonSchema(ReadSettingsSchema),
      handler: (a, c) => handleReadSettings(a as Parameters<typeof handleReadSettings>[0], c),
    },
    {
      name: 'search_in_files',
      description: 'Searches for a text pattern across C# scripts and/or markdown docs. Returns file:line:text in grep-style format.',
      inputSchema: zodToJsonSchema(SearchInFilesSchema),
      handler: (a, c) => handleSearchInFiles(a as Parameters<typeof handleSearchInFiles>[0], c),
    },
    {
      name: 'get_latest_log',
      description: 'Reads the most recent Flax Engine log file. Supports tail mode (last N lines) and text filtering. Use all_logs:true to list all log files.',
      inputSchema: zodToJsonSchema(GetLatestLogSchema),
      handler: (a, c) => handleGetLatestLog(a as Parameters<typeof handleGetLatestLog>[0], c),
    },
  ];
}
