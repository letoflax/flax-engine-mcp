import type { ProjectMeta } from './projectContext.js';

export const PERMISSION_PROFILES = ['read-only', 'code-edit', 'scene-edit', 'full'] as const;
export type PermissionProfile = typeof PERMISSION_PROFILES[number];

export interface PermissionPolicy {
  profile: PermissionProfile;
  allowTools: readonly string[];
  denyTools: readonly string[];
  emergencyReadOnly: boolean;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  profile: 'full',
  allowTools: [],
  denyTools: [],
  emergencyReadOnly: false,
};

/** Every released tool is deliberately placed in exactly one capability family. */
const TOOL_FAMILIES = {
  read: [
    'get_server_capabilities', 'editor_get_status', 'get_editor_bridge_installation',
    'scene_list_loaded', 'scene_get_tree', 'actor_get', 'actor_find', 'script_instance_get', 'edit_get_lease',
    'code_get_diagnostics', 'play_get_status', 'log_get_recent', 'log_search',
    'log_get_runtime_errors', 'get_project_info', 'get_game_settings', 'get_project_summary',
    'list_scripts', 'read_script', 'get_audit_entries', 'get_script_classes',
    'find_references', 'list_networked_scripts', 'search_in_files', 'get_scene_actors',
    'get_asset_info', 'list_assets', 'asset_search', 'asset_get', 'asset_dependencies', 'asset_find_references', 'asset_import_status', 'asset_reimport_status', 'read_settings', 'get_input_actions',
    'get_physics_settings', 'get_compiler_errors', 'validate_project', 'list_docs',
    'read_doc', 'get_latest_log',
  ],
  code: [
    'install_editor_bridge', 'code_compile', 'code_generate_project', 'write_script',
    'apply_script_patch', 'generate_script',
  ],
  scene: [
    'scene_save', 'project_save_all', 'actor_create', 'actor_update', 'actor_delete',
    'actor_duplicate', 'actor_reparent', 'script_attach', 'script_detach',
    'script_instance_update', 'edit_undo', 'edit_redo', 'edit_begin_lease', 'edit_commit_lease', 'edit_release_lease', 'create_actor', 'modify_actor',
  ],
  asset: ['reimport_asset', 'asset_import', 'asset_reimport'],
  runtime: [
    'play_start_scenes', 'play_start_game', 'play_stop', 'play_pause', 'play_resume',
    'play_step_frame', 'play_run_for', 'viewport_capture', 'runtime_inspect_actor',
  ],
} as const;

export type ToolFamily = keyof typeof TOOL_FAMILIES;
const TOOL_FAMILY_BY_NAME = new Map<string, ToolFamily>(
  Object.entries(TOOL_FAMILIES).flatMap(([family, names]) =>
    names.map(name => [name, family as ToolFamily] as const))
);

export function classifiedToolNames(): string[] {
  return [...TOOL_FAMILY_BY_NAME.keys()];
}

export function parsePermissionPolicy(argv: readonly string[]): PermissionPolicy {
  let profile: PermissionProfile = 'full';
  const allowTools: string[] = [];
  const denyTools: string[] = [];
  let emergencyReadOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--permission-profile') {
      const value = argv[++index];
      if (!PERMISSION_PROFILES.includes(value as PermissionProfile)) {
        throw new Error(`Invalid --permission-profile. Expected one of: ${PERMISSION_PROFILES.join(', ')}.`);
      }
      profile = value as PermissionProfile;
    } else if (arg === '--allow-tool' || arg === '--deny-tool') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a tool name.`);
      (arg === '--allow-tool' ? allowTools : denyTools).push(value);
    } else if (arg === '--emergency-read-only') {
      emergencyReadOnly = true;
    }
  }
  return { profile, allowTools, denyTools, emergencyReadOnly };
}

export function policyForContext(ctx: ProjectMeta): PermissionPolicy {
  return ctx.permissionPolicy ?? DEFAULT_PERMISSION_POLICY;
}

export function assertPermissionRegistryCoverage(toolNames: Iterable<string>): void {
  const names = [...toolNames];
  const unclassified = names.filter(name => !TOOL_FAMILY_BY_NAME.has(name));
  const classifiedNames = Object.values(TOOL_FAMILIES).flat();
  const duplicates = classifiedNames.filter((name, index) => classifiedNames.indexOf(name) !== index);
  const stale = classifiedNames.filter(name => !names.includes(name));
  if (unclassified.length || duplicates.length || stale.length) {
    throw new Error(`Permission registry coverage failed: ${[
      unclassified.length ? `unclassified: ${unclassified.join(', ')}` : '',
      duplicates.length ? `duplicate: ${duplicates.join(', ')}` : '',
      stale.length ? `not registered: ${stale.join(', ')}` : '',
    ].filter(Boolean).join('; ')}`);
  }
}

export function isToolAllowed(name: string, policy: PermissionPolicy): boolean {
  const family = TOOL_FAMILY_BY_NAME.get(name);
  // Unknown tools fail closed even if an override names them.
  if (!family) return false;
  if (policy.emergencyReadOnly && family !== 'read') return false;
  if (policy.denyTools.includes(name)) return false;
  if (policy.allowTools.includes(name)) return true;
  if (policy.profile === 'full') return true;
  if (policy.profile === 'read-only') return family === 'read';
  if (policy.profile === 'code-edit') return family === 'read' || family === 'code';
  return family === 'read' || family === 'scene' || family === 'runtime';
}

export function allowedToolNames(toolNames: Iterable<string>, policy: PermissionPolicy): string[] {
  return [...toolNames].filter(name => isToolAllowed(name, policy));
}

export function permissionSummary(policy: PermissionPolicy, toolNames: Iterable<string>) {
  const allTools = [...toolNames];
  return {
    profile: policy.profile,
    emergencyReadOnly: policy.emergencyReadOnly,
    allowTools: [...policy.allowTools],
    denyTools: [...policy.denyTools],
    availableTools: allowedToolNames(allTools, policy),
  };
}
