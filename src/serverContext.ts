import { createAssetImportPolicy } from './assetImportPolicy.js';
import { parsePermissionPolicy } from './permissions.js';
import { createProjectContext, type ProjectMeta } from './projectContext.js';
import { resolveFlaxEditorPath } from './tools/editorLaunch.js';
import { parseAllowGameLaunchArgument } from './tools/gameRuntime.js';

/** First argument words that select a CLI command instead of naming a project path. */
export const CLI_COMMANDS = ['doctor', 'call', 'tools'] as const;

export function parseProjectPath(argv = process.argv): string {
  const idx = argv.indexOf('--project-path');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1]!;
  }
  const first = argv[2];
  if (first && !first.startsWith('--') && !(CLI_COMMANDS as readonly string[]).includes(first)) return first;
  throw new Error(
    'Usage: flax-mcp --project-path /path/to/flax/project\n' +
    'Example: flax-mcp --project-path /home/user/Projects/flax/test-flax'
  );
}

/**
 * Builds the project context exactly as the MCP server does: project path, permission policy
 * (--permission-profile/--allow-tool/--deny-tool/--emergency-read-only), canonical asset import roots
 * (relative roots resolve against the project path), the optional --flax-editor executable and the --allow-game-launch switch.
 * `projectPath` overrides the argv lookup (the CLI falls back to the working directory).
 */
export async function createServerContext(argv: readonly string[], projectPath = parseProjectPath(argv as string[])): Promise<ProjectMeta> {
  const ctx = await createProjectContext(projectPath);
  ctx.permissionPolicy = parsePermissionPolicy(argv);
  ctx.assetImportPolicy = await createAssetImportPolicy(argv, ctx.projectPath);
  const editor = await resolveFlaxEditorPath(argv);
  if (editor) ctx.flaxEditorPath = editor;
  if (parseAllowGameLaunchArgument(argv)) ctx.allowGameLaunch = true;
  return ctx;
}
