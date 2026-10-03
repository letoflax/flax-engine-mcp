import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import { reportProgress } from '../progress.js';
import type { EditorLaunchSchema } from './editorLifecycle.js';
import { inspectEditorBridge, type EditorBridgeStatus } from './serverStatus.js';

// editor_launch is the only place this server starts a process. It is enabled by
// --flax-editor <FlaxEditor.exe>, accepts exactly two optional Editor switches
// (-headless, -skipcompile) plus the fixed "-project <this project>", and never
// forwards caller text to the command line.

const EDITOR_FILE_NAME = 'flaxeditor.exe';
const POLL_INTERVAL_MS = 500;

/** Reads the value of `--flax-editor`, or null when the flag is absent. Throws on a missing value. */
export function parseFlaxEditorArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf('--flax-editor');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--flax-editor requires the path of FlaxEditor.exe.');
  return value;
}

/**
 * Validates the configured editor path once at startup: it must be an existing file named
 * FlaxEditor.exe (case-insensitive; on non-Windows hosts the extension-less FlaxEditor binary too).
 * Returns the absolute path, or undefined when the flag is not given.
 */
export async function resolveFlaxEditorPath(argv: readonly string[]): Promise<string | undefined> {
  const requested = parseFlaxEditorArgument(argv);
  if (requested === null) return undefined;
  const absolute = path.resolve(requested);
  const name = path.basename(absolute).toLowerCase();
  if (name !== EDITOR_FILE_NAME && !(process.platform !== 'win32' && name === 'flaxeditor')) {
    throw new Error('--flax-editor must name FlaxEditor.exe.');
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    throw new Error('--flax-editor must name an existing FlaxEditor.exe file.');
  }
  if (!stat.isFile()) throw new Error('--flax-editor must name an existing FlaxEditor.exe file.');
  return absolute;
}

export interface EditorProcessInfo {
  pid: number;
  commandLine: string;
}

/** Splits a Windows/POSIX command line into arguments, honouring double and single quotes. */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let started = false;
  for (const char of commandLine) {
    if (quote) {
      if (char === quote) quote = null; else current += char;
    } else if (char === '"' || char === '\'') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
    }
  }
  if (started || current) args.push(current);
  return args;
}

function comparablePath(value: string): string {
  let resolved = path.resolve(value);
  if (resolved.toLowerCase().endsWith('.flaxproj')) resolved = path.dirname(resolved);
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase().replaceAll('/', '\\') : resolved;
}

/** Pids of FlaxEditor processes whose command line carries `-project <projectPath>` (folder or .flaxproj spelling). */
export function findProjectEditorPids(processes: readonly EditorProcessInfo[], projectPath: string): number[] {
  const wanted = comparablePath(projectPath);
  const pids: number[] = [];
  for (const info of processes) {
    const args = splitCommandLine(info.commandLine);
    const exe = path.basename((args[0] ?? '').replaceAll('\\', '/')).toLowerCase();
    if (!exe.startsWith('flaxeditor')) continue;
    const at = args.findIndex(arg => arg.toLowerCase() === '-project');
    const value = at === -1 ? undefined : args[at + 1];
    if (value && comparablePath(value) === wanted) pids.push(info.pid);
  }
  return pids;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

/** Lists running FlaxEditor processes with their command lines. Throws when the OS query is unavailable. */
export async function listEditorProcesses(): Promise<EditorProcessInfo[]> {
  if (process.platform === 'win32') {
    // Single quotes only: embedded double quotes do not survive the CreateProcess command line to powershell.exe.
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'FlaxEditor.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const raw = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap(row => {
      const entry = row as { ProcessId?: unknown; CommandLine?: unknown };
      return typeof entry.ProcessId === 'number' && typeof entry.CommandLine === 'string'
        ? [{ pid: entry.ProcessId, commandLine: entry.CommandLine }]
        : [];
    });
  }
  const out = await run('ps', ['-eo', 'pid=,args=']);
  return parseProcessList(out);
}

/** Parses `ps -eo pid=,args=` output. */
export function parseProcessList(output: string): EditorProcessInfo[] {
  const found: EditorProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) found.push({ pid: Number(match[1]), commandLine: match[2]! });
  }
  return found;
}

export interface EditorLaunchDeps {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  listProcesses: () => Promise<EditorProcessInfo[]>;
  inspectBridge: (ctx: ProjectMeta) => Promise<EditorBridgeStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultEditorLaunchDeps: EditorLaunchDeps = {
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  listProcesses: listEditorProcesses,
  inspectBridge: ctx => inspectEditorBridge(ctx),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** The complete, fixed argument list of a launch: nothing but these switches ever reaches the command line. */
export function editorLaunchArguments(projectPath: string, options: { headless: boolean; skip_compile: boolean }): string[] {
  return ['-project', projectPath, ...(options.headless ? ['-headless'] : []), ...(options.skip_compile ? ['-skipcompile'] : [])];
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.removeListener('error', reject); resolve(); });
  });
}

export async function handleEditorLaunch(
  args: z.infer<typeof EditorLaunchSchema>,
  ctx: ProjectMeta,
  deps: EditorLaunchDeps = defaultEditorLaunchDeps,
): Promise<ToolResponse> {
  try {
    if (!ctx.flaxEditorPath) {
      throw new ToolDomainError(
        'UNSUPPORTED_FLAX_VERSION',
        'editor_launch is disabled: start the MCP server with --flax-editor <path to FlaxEditor.exe> to enable it.',
        { hint: '--flax-editor <FlaxEditor.exe>' },
      );
    }

    const bridge = await deps.inspectBridge(ctx);
    if (bridge.connected) {
      throw new ToolDomainError('EDITOR_BUSY', `A Flax Editor (pid ${bridge.pid}) already has a live bridge heartbeat for this project; editor_launch will not start a second one.`, { pid: bridge.pid });
    }
    const warnings: string[] = [];
    try {
      const running = findProjectEditorPids(await deps.listProcesses(), ctx.projectPath);
      if (running.length > 0) {
        throw new ToolDomainError('EDITOR_BUSY', `A FlaxEditor process (pid ${running.join(', ')}) is already running with -project for this project; editor_launch will not start a second one.`, { pids: running });
      }
    } catch (error) {
      if (error instanceof ToolDomainError) throw error;
      warnings.push('Could not list running FlaxEditor processes, so only the bridge heartbeat was checked for an Editor already open on this project.');
    }

    const launchArgs = editorLaunchArguments(ctx.projectPath, args);
    const child = deps.spawn(ctx.flaxEditorPath, launchArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: args.headless,
      cwd: path.dirname(ctx.flaxEditorPath),
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once('exit', (code, signal) => { exited = { code, signal }; });
    try {
      await started(child);
    } catch (error) {
      throw new ToolDomainError('INTERNAL_ERROR', `FlaxEditor could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }
    child.unref();
    const pid = child.pid;
    const launched = { pid, headless: args.headless, skipCompile: args.skip_compile };
    const changes = [{ kind: 'editor-launch', pid }];

    if (!args.wait_ready) {
      return toolResult(JSON.stringify({ ...launched, ready: false }, null, 2), {
        mode: 'offline',
        data: { ...launched, ready: false },
        warnings: [...warnings, 'The Editor was started without waiting; poll editor_get_status until the bridge is connected.'],
        changes,
      });
    }

    const startedAt = deps.now();
    const deadline = startedAt + args.timeout_ms;
    for (;;) {
      const status = await deps.inspectBridge(ctx);
      if (status.connected) {
        const data = { ...launched, ready: true, bridgeVersion: status.bridgeVersion, editorVersion: status.editorVersion, bridgePid: status.pid, waitedMs: deps.now() - startedAt };
        return toolResult(JSON.stringify(data, null, 2), {
          mode: 'editor-connected',
          data,
          warnings: status.pid !== pid ? [...warnings, `The bridge heartbeat belongs to pid ${status.pid}, not the launched process ${pid}.`] : warnings,
          changes,
        });
      }
      const gone = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
      if (gone) {
        throw new ToolDomainError('EDITOR_NOT_CONNECTED', `The launched Flax Editor (pid ${pid}) exited (${gone.signal ?? `code ${gone.code}`}) before its bridge became ready.`, { ...launched, ready: false, exitCode: gone.code });
      }
      if (deps.now() >= deadline) {
        throw new ToolDomainError('TIMEOUT', `The Flax Editor was started (pid ${pid}) but its bridge was not ready within ${args.timeout_ms} ms. It keeps running; poll editor_get_status.`, { ...launched, ready: false, waitedMs: deps.now() - startedAt, bridgeReason: status.reason });
      }
      reportProgress(`Waiting for the Editor bridge (${status.reason})`, args.timeout_ms);
      await deps.sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    return toolError(error);
  }
}
