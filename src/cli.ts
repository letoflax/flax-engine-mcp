import fs from 'node:fs/promises';
import { assertPermissionRegistryCoverage, allowedToolNames, policyForContext, toolFamily } from './permissions.js';
import { createServerContext } from './serverContext.js';
import { buildToolRegistry } from './tools/index.js';
import type { ProjectMeta } from './projectContext.js';
import type { ToolResponse } from './errors.js';

export const CLI_EXIT_OK = 0;
export const CLI_EXIT_TOOL_ERROR = 1;
export const CLI_EXIT_USAGE = 2;

export interface CliResult { exitCode: number; stdout: string; stderr: string }

export type CliDispatch = (
  tools: ReturnType<typeof buildToolRegistry>,
  name: string,
  rawArgs: unknown,
  ctx: ProjectMeta,
) => Promise<ToolResponse>;

/** Flags that take a value, shared with the server (parsed by parsePermissionPolicy, createAssetImportPolicy, ...). */
const VALUE_FLAGS = new Set(['--project-path', '--permission-profile', '--allow-tool', '--deny-tool', '--asset-import-root', '--flax-editor']);
const BOOLEAN_FLAGS = new Set(['--emergency-read-only', '--json', '--allow-game-launch']);

const USAGE = [
  'Usage:',
  '  flax-mcp call <tool> [json|@file|-] [--project-path <dir>] [policy flags]',
  '  flax-mcp tools [--json] [--project-path <dir>] [policy flags]',
  '',
  'Policy flags (same as the server): --permission-profile <profile>, --allow-tool <name>, --deny-tool <name>,',
  '  --emergency-read-only, --asset-import-root <dir>, --flax-editor <FlaxEditor.exe>, --allow-game-launch.',
  'Without --project-path the current directory is used.',
  'Exit codes: 0 success, 1 tool error, 2 usage error.',
].join('\n');

class UsageError extends Error {}

/** Splits the words after the command into positionals, rejecting flags this CLI does not know. */
function positionals(args: readonly string[], allowJson: boolean): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      if (index >= args.length) throw new UsageError(`${arg} requires a value.`);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json' && !allowJson) throw new UsageError('--json is only valid for "tools".');
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}.`);
    } else {
      words.push(arg);
    }
  }
  return words;
}

async function readToolInput(source: string | undefined): Promise<unknown> {
  if (source === undefined) return {};
  let text = source;
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  } else if (source.startsWith('@')) {
    try { text = await fs.readFile(source.slice(1), 'utf8'); }
    catch { throw new UsageError(`Cannot read the JSON file ${source.slice(1)}.`); }
  }
  try { return JSON.parse(text.replace(/^﻿/, '')) as unknown; }
  catch (error) { throw new UsageError(`Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function projectPathFrom(argv: readonly string[]): string {
  const index = argv.indexOf('--project-path');
  const value = index === -1 ? undefined : argv[index + 1];
  if (index !== -1 && (!value || value.startsWith('--'))) throw new UsageError('--project-path requires a directory.');
  return value ?? process.cwd();
}

/**
 * `flax-mcp tools` / `flax-mcp call <tool> [json|@file|-]`. Builds the same context and registry as the server
 * (project, permission policy, asset import roots, --flax-editor, --allow-game-launch) and runs the call through the one dispatch path,
 * so permission checks and schema defaults behave identically. The result printed is the tool envelope
 * (operationId, ok, data/error, warnings, changes, timing).
 */
export async function runCli(argv: readonly string[], dispatch: CliDispatch): Promise<CliResult> {
  const command = argv[2];
  const rest = argv.slice(3);
  try {
    const words = positionals(rest, command === 'tools');
    if (command === 'call' && (words.length < 1 || words.length > 2)) throw new UsageError('Usage: flax-mcp call <tool> [json|@file|-]');
    if (command === 'tools' && words.length > 0) throw new UsageError('"tools" takes no positional arguments.');

    let ctx: ProjectMeta;
    try { ctx = await createServerContext(argv, projectPathFrom(argv)); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }

    const tools = buildToolRegistry(ctx);
    assertPermissionRegistryCoverage(tools.map(tool => tool.name));

    if (command === 'tools') {
      const permitted = tools.filter(tool => allowedToolNames([tool.name], policyForContext(ctx)).includes(tool.name));
      if (rest.includes('--json')) {
        const list = permitted.map(tool => ({ name: tool.name, family: toolFamily(tool.name) }));
        return { exitCode: CLI_EXIT_OK, stdout: `${JSON.stringify(list)}\n`, stderr: '' };
      }
      const width = Math.max(0, ...permitted.map(tool => tool.name.length));
      const lines = permitted.map(tool => `${tool.name.padEnd(width)}  ${toolFamily(tool.name)}`);
      return { exitCode: CLI_EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    const name = words[0]!;
    if (!tools.some(tool => tool.name === name)) throw new UsageError(`Unknown tool: ${name}. Run "flax-mcp tools" for the list.`);
    const input = await readToolInput(words[1]);
    const result = await dispatch(tools, name, input, ctx);
    const output = result.structuredContent ?? result;
    return { exitCode: result.isError ? CLI_EXIT_TOOL_ERROR : CLI_EXIT_OK, stdout: `${JSON.stringify(output, null, 2)}\n`, stderr: '' };
  } catch (error) {
    if (error instanceof UsageError) return { exitCode: CLI_EXIT_USAGE, stdout: '', stderr: `${error.message}\n\n${USAGE}\n` };
    return { exitCode: CLI_EXIT_TOOL_ERROR, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}
