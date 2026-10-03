import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { callRuntimeBridge, type RuntimeBridgeCall } from '../bridge/fileRpcClient.js';
import { mapRuntimeBridgeError } from '../bridge/mapBridgeError.js';
import {
  BridgeMethod,
  BridgeRpcError,
  RUNTIME_BRIDGE_CAPTURES_DIRECTORY,
  RUNTIME_INSTANCE_NAME_PATTERN,
} from '../bridge/protocol.js';
import {
  RuntimeBridgeStatus,
  inspectRuntimeBridge,
  listRuntimeBridges,
  runtimeInstanceDirectory,
} from '../bridge/runtimeHeartbeat.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import { reportProgress } from '../progress.js';
import { MaxCaptureBytes } from '../resources.js';
import { isProcessAlive } from './serverStatus.js';

// Bridge v35: cooked games with the runtime bridge (bridge/FlaxMcpRuntimeBridge.cs).
//
// game_launch is, with editor_launch, the only place this server starts a process. It is enabled by
// --allow-game-launch, starts only a file inside the project root (a Windows host also requires .exe),
// passes only -mcpdir/-mcpinstance plus validated "-name[=value]" switches, and never forwards free text.
// Each running game owns <project>/Cache/MCP-Runtime/<instance>; tools address it by instance name only
// and never see paths or the session token.

const POLL_INTERVAL_MS = 250;
/** A cooked game answers status before its first scene has loaded; wait_ready allows this long for one. */
const SCENE_GRACE_MS = 10_000;
const GAME_ARGUMENT = /^-[A-Za-z0-9_]+(=[^\s"]{0,256})?$/;
const RESERVED_ARGUMENTS = new Set(['-mcpdir', '-mcpinstance']);

export const GAME_LAUNCH_DISABLED_HINT = '--allow-game-launch';

/** True when `--allow-game-launch` is present. The flag takes no value. */
export function parseAllowGameLaunchArgument(argv: readonly string[]): boolean {
  return argv.includes('--allow-game-launch');
}

export const RuntimeInstanceName = z.string().regex(RUNTIME_INSTANCE_NAME_PATTERN, 'Instance names use only letters, digits, "_" and "-" (1-64 characters).');

/** The optional `instance` parameter other tools accept to target a running cooked game instead of the Editor. */
export const InstanceParam = RuntimeInstanceName.optional()
  .describe('Name of a running game instance (see game_list_instances) with the runtime bridge. When given, the call goes to that cooked game instead of the Flax Editor (bridge v35); omit it for the Editor.');

export const GameLaunchSchema = z.object({
  exe: z.string().min(1).max(512)
    .describe('Game executable, relative to the project root (for example Cache/Cooker/Windows/Development/Game.exe or Builds/Game.exe). Must resolve (symlinks included) to a file inside the project root; on Windows it must end in .exe.'),
  instance: RuntimeInstanceName.optional()
    .describe('Instance name (letters, digits, "_" and "-", at most 64). Default "g<n>" with the lowest free n.'),
  args: z.array(z.string().max(300).regex(GAME_ARGUMENT, 'Each argument must look like -name or -name=value (letters, digits, "_" in the name; no whitespace or quotes in the value).')).max(32).optional().default([])
    .describe('Extra game switches, at most 32, each -name or -name=value. -mcpdir and -mcpinstance are set by the server and refused here.'),
  wait_ready: z.boolean().optional().default(true)
    .describe('Wait until the new instance bridge heartbeat is live and it answers status.'),
  timeout_ms: z.number().int().min(1).max(120_000).optional().default(60_000)
    .describe('How long to wait for readiness (at most 120000).'),
}).strict().superRefine((value, ctx) => {
  value.args.forEach((arg, index) => {
    const name = arg.split('=')[0]!.toLowerCase();
    if (RESERVED_ARGUMENTS.has(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args', index], message: `${name} is set by game_launch and cannot be passed.` });
    }
  });
});

export const GameListInstancesSchema = z.object({}).strict();

export const GameStopSchema = z.object({
  instance: RuntimeInstanceName,
  force: z.boolean().optional().default(false)
    .describe('Kill the process when it has not exited after the graceful game.quit. Only a process this server launched with game_launch can be killed.'),
  timeout_ms: z.number().int().min(1).max(120_000).optional().default(15_000)
    .describe('How long to wait for the process to exit after the quit is accepted (at most 120000).'),
}).strict();

/** Process-local record of what this server launched; a force-kill is limited to it. */
export interface GameRuntimeState {
  /** pids of games started by this server process that have not been seen to exit. */
  pids: Set<number>;
  /** instance name -> pid for those launches (so a second launch cannot reuse a still-starting name). */
  instances: Map<string, number>;
}

export const defaultGameRuntimeState: GameRuntimeState = { pids: new Set(), instances: new Map() };

/** Seams for tests: process start/kill/liveness, the bridge, time, and the launched-pid record. */
export interface GameRuntimeDeps {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  inspect: (ctx: ProjectMeta, instance: string) => Promise<RuntimeBridgeStatus>;
  list: (ctx: ProjectMeta) => Promise<RuntimeBridgeStatus[]>;
  call: (ctx: ProjectMeta, instance: string, method: BridgeMethod, params: Record<string, unknown>, deadlineMs: number) => Promise<RuntimeBridgeCall>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  state: GameRuntimeState;
}

export const defaultGameRuntimeDeps: GameRuntimeDeps = {
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  isAlive: isProcessAlive,
  kill: pid => { process.kill(pid, 'SIGKILL'); },
  inspect: (ctx, instance) => inspectRuntimeBridge(ctx, instance),
  list: ctx => listRuntimeBridges(ctx),
  call: (ctx, instance, method, params, deadlineMs) => callRuntimeBridge(ctx, instance, method, params, { deadlineMs }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  state: defaultGameRuntimeState,
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A tool result for a call that reached a running game instance. */
export function gameToolResult(data: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'game-connected', data, warnings, changes });
}

/** Resolves `exe` against the project root; it must be an existing file inside the root once symlinks are resolved. */
export async function resolveGameExecutable(ctx: ProjectMeta, exe: string): Promise<{ file: string; relative: string }> {
  if (exe.includes('\0')) throw new ToolDomainError('INVALID_PATH', 'exe contains a NUL character.');
  const root = await fs.realpath(ctx.projectPath);
  const candidate = path.resolve(root, exe);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new ToolDomainError('NOT_FOUND', 'exe was not found inside the project.');
  }
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToolDomainError('INVALID_PATH', 'exe must resolve to a file inside the project root.');
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ToolDomainError('INVALID_PATH', 'exe must be a file.');
  if (process.platform === 'win32' && !real.toLowerCase().endsWith('.exe')) {
    throw new ToolDomainError('INVALID_PATH', 'exe must be an .exe file on Windows.');
  }
  return { file: real, relative: relative.replaceAll('\\', '/') };
}

/** The complete, fixed argument list of a launch: nothing but these switches ever reaches the command line. */
export function gameLaunchArguments(instanceDirectory: string, instance: string, extra: readonly string[]): string[] {
  return [`-mcpdir=${instanceDirectory}`, `-mcpinstance=${instance}`, ...extra];
}

function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.removeListener('error', reject); resolve(); });
  });
}

/** True while this server started `instance` and that process has not been seen to exit. */
function launchedAndRunning(deps: GameRuntimeDeps, instance: string): boolean {
  const pid = deps.state.instances.get(instance);
  if (pid === undefined) return false;
  if (deps.isAlive(pid)) return true;
  deps.state.instances.delete(instance);
  deps.state.pids.delete(pid);
  return false;
}

async function pickInstanceName(ctx: ProjectMeta, deps: GameRuntimeDeps): Promise<string> {
  for (let n = 1; n < 10_000; n += 1) {
    const name = `g${n}`;
    if (launchedAndRunning(deps, name)) continue;
    if ((await deps.inspect(ctx, name)).connected) continue;
    return name;
  }
  throw new ToolDomainError('INTERNAL_ERROR', 'No free default game instance name.');
}

async function clearStaleInstanceFiles(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  // A heartbeat/token left by a dead game must not be mistaken for the new process.
  await Promise.all(['bridge.json', 'token'].map(name => fs.rm(path.join(directory, name), { force: true }).catch(() => undefined)));
}

export async function handleGameLaunch(
  args: z.infer<typeof GameLaunchSchema>,
  ctx: ProjectMeta,
  deps: GameRuntimeDeps = defaultGameRuntimeDeps,
): Promise<ToolResponse> {
  try {
    if (!ctx.allowGameLaunch) {
      throw new ToolDomainError(
        'UNSUPPORTED_FLAX_VERSION',
        'game_launch is disabled: start the MCP server with --allow-game-launch to enable it.',
        { hint: GAME_LAUNCH_DISABLED_HINT },
      );
    }
    const exe = await resolveGameExecutable(ctx, args.exe);
    const instance = args.instance ?? await pickInstanceName(ctx, deps);

    const existing = await deps.inspect(ctx, instance);
    if (existing.connected) {
      throw new ToolDomainError('EDITOR_BUSY', `Game instance "${instance}" already has a live bridge heartbeat (pid ${existing.pid}); game_launch will not start a second one under that name.`, { instance, pid: existing.pid });
    }
    if (launchedAndRunning(deps, instance)) {
      throw new ToolDomainError('EDITOR_BUSY', `Game instance "${instance}" was launched by this server and is still running (pid ${deps.state.instances.get(instance)}).`, { instance, pid: deps.state.instances.get(instance) });
    }

    const directory = runtimeInstanceDirectory(ctx, instance);
    await clearStaleInstanceFiles(directory);
    const child = deps.spawn(exe.file, gameLaunchArguments(directory, instance, args.args), {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exe.file),
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      if (child.pid !== undefined) {
        deps.state.pids.delete(child.pid);
        if (deps.state.instances.get(instance) === child.pid) deps.state.instances.delete(instance);
      }
    });
    try {
      await started(child);
    } catch (error) {
      throw new ToolDomainError('INTERNAL_ERROR', `The game could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new ToolDomainError('INTERNAL_ERROR', 'The game started without a process id.');
    deps.state.pids.add(pid);
    deps.state.instances.set(instance, pid);
    const launched = { instance, pid, exe: exe.relative };
    const changes = [{ kind: 'game-launch', instance, pid }];

    if (!args.wait_ready) {
      return toolResult(JSON.stringify({ ...launched, ready: false }, null, 2), {
        mode: 'offline',
        data: { ...launched, ready: false },
        warnings: ['The game was started without waiting; poll game_list_instances until the instance is live.'],
        changes,
      });
    }

    const startedAt = deps.now();
    const deadline = startedAt + args.timeout_ms;
    let sceneDeadline: number | null = null;
    for (;;) {
      const heartbeat = await deps.inspect(ctx, instance);
      if (heartbeat.connected) {
        try {
          const response = await deps.call(ctx, instance, 'status', {}, Math.max(50, Math.min(5_000, deadline - deps.now())));
          const status = asRecord(response.data);
          const sceneCount = finiteNumber(status.LoadedSceneCount);
          if (sceneCount === 0 && heartbeat.pid === pid) {
            sceneDeadline ??= Math.min(deadline, deps.now() + SCENE_GRACE_MS);
            if (deps.now() < sceneDeadline) {
              reportProgress(`Waiting for game instance ${instance} to load its first scene`, args.timeout_ms);
              await deps.sleep(POLL_INTERVAL_MS);
              continue;
            }
          }
          const data = {
            ...launched,
            ready: true,
            bridge_pid: heartbeat.pid,
            bridge_version: heartbeat.bridgeVersion,
            product_name: heartbeat.productName,
            engine_version: heartbeat.engineVersion,
            frame_count: finiteNumber(status.FrameCount),
            loaded_scene_count: finiteNumber(status.LoadedSceneCount),
            waited_ms: deps.now() - startedAt,
          };
          return toolResult(JSON.stringify(data, null, 2), {
            mode: 'game-connected',
            data,
            warnings: [
              ...(heartbeat.pid !== pid ? [`The bridge heartbeat belongs to pid ${heartbeat.pid}, not the launched process ${pid}.`] : []),
              ...(sceneCount === 0 ? ['No scene was loaded yet; scene-dependent calls may answer NOT_FOUND until the game finishes loading.'] : []),
            ],
            changes,
          });
        } catch (error) {
          // A bridge that is too old can never become ready; a bridge that is not answering yet is retried.
          if (error instanceof BridgeRpcError && error.code === 'BRIDGE_UNSUPPORTED') throw mapRuntimeBridgeError(error);
        }
      }
      const gone = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
      if (gone) {
        throw new ToolDomainError('GAME_NOT_CONNECTED', `The launched game (pid ${pid}) exited (${gone.signal ?? `code ${gone.code}`}) before its bridge became ready.`, { ...launched, ready: false, exit_code: gone.code });
      }
      if (deps.now() >= deadline) {
        throw new ToolDomainError('TIMEOUT', `The game was started (pid ${pid}) but its bridge was not ready within ${args.timeout_ms} ms. It keeps running; poll game_list_instances.`, { ...launched, ready: false, waited_ms: deps.now() - startedAt, bridge_reason: heartbeat.reason });
      }
      reportProgress(`Waiting for game instance ${instance} (${heartbeat.reason})`, args.timeout_ms);
      await deps.sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    return toolError(error);
  }
}

export async function handleGameListInstances(
  _args: z.infer<typeof GameListInstancesSchema>,
  ctx: ProjectMeta,
  deps: GameRuntimeDeps = defaultGameRuntimeDeps,
): Promise<ToolResponse> {
  try {
    const statuses = await deps.list(ctx);
    const instances = statuses.map(status => ({
      instance: status.instance,
      state: status.connected ? 'live' : 'stale',
      reason: status.reason,
      pid: status.pid,
      bridge_version: status.bridgeVersion,
      protocol_version: status.protocolVersion,
      product_name: status.productName,
      engine_version: status.engineVersion,
      heartbeat_age_ms: status.heartbeatAgeMs,
      launched_by_this_server: status.pid !== null && deps.state.pids.has(status.pid),
    }));
    const data = { instances, live_count: instances.filter(entry => entry.state === 'live').length, launch_enabled: ctx.allowGameLaunch === true };
    return toolResult(JSON.stringify(data, null, 2), { mode: 'offline', data });
  } catch (error) {
    return toolError(error);
  }
}

const STOP_POLL_MS = 200;
const KILL_WAIT_MS = 3_000;

export async function handleGameStop(
  args: z.infer<typeof GameStopSchema>,
  ctx: ProjectMeta,
  deps: GameRuntimeDeps = defaultGameRuntimeDeps,
): Promise<ToolResponse> {
  try {
    const heartbeat = await deps.inspect(ctx, args.instance);
    const pid = heartbeat.pid;
    if (args.force && (pid === null || !deps.state.pids.has(pid))) {
      throw new ToolDomainError(
        'PERMISSION_DENIED',
        `force is only allowed for a game this server launched with game_launch; instance "${args.instance}" was not (or its process id is unknown). Nothing was stopped.`,
        { instance: args.instance },
      );
    }
    const startedAt = deps.now();
    const warnings: string[] = [];
    let accepted = false;
    let forced = false;

    if (heartbeat.connected) {
      try {
        const response = await deps.call(ctx, args.instance, 'game.quit', {}, 10_000);
        const result = asRecord(response.data);
        accepted = result.Accepted !== false;
        warnings.push(...response.warnings);
      } catch (error) {
        if (!args.force) throw mapRuntimeBridgeError(error);
        warnings.push(`game.quit failed (${error instanceof Error ? error.message : String(error)}); force was requested.`);
      }
    } else if (pid === null || !deps.isAlive(pid)) {
      throw new ToolDomainError('GAME_NOT_CONNECTED', `Game instance "${args.instance}" is not running (${heartbeat.reason}).`, { instance: args.instance, reason: heartbeat.reason });
    } else if (!args.force) {
      throw new ToolDomainError('GAME_NOT_CONNECTED', `Game instance "${args.instance}" has no live bridge heartbeat (${heartbeat.reason}) but its process (pid ${pid}) is still running; it may be hung. Use force:true to kill it (only possible for games this server launched).`, { instance: args.instance, reason: heartbeat.reason, pid });
    }

    let exited = pid === null ? false : !deps.isAlive(pid);
    if (pid !== null && !exited) {
      const end = startedAt + args.timeout_ms;
      for (;;) {
        if (!deps.isAlive(pid)) { exited = true; break; }
        reportProgress(`Waiting for game process ${pid} to exit`, args.timeout_ms);
        if (deps.now() + STOP_POLL_MS > end) break;
        await deps.sleep(STOP_POLL_MS);
      }
    }
    if (pid !== null && !exited && args.force) {
      deps.kill(pid);
      forced = true;
      const end = deps.now() + KILL_WAIT_MS;
      for (;;) {
        if (!deps.isAlive(pid)) { exited = true; break; }
        if (deps.now() + STOP_POLL_MS > end) break;
        await deps.sleep(STOP_POLL_MS);
      }
      if (!exited) warnings.push(`The process ${pid} was still running ${KILL_WAIT_MS} ms after it was killed.`);
    } else if (pid !== null && !exited) {
      warnings.push(`The game process ${pid} was still running after ${args.timeout_ms} ms. The quit was accepted and may still complete; check game_list_instances, or retry with force:true for a game this server launched.`);
    }
    if (exited && pid !== null) {
      deps.state.pids.delete(pid);
      if (deps.state.instances.get(args.instance) === pid) deps.state.instances.delete(args.instance);
    }
    const data = { instance: args.instance, pid, accepted, exited, forced, waited_ms: deps.now() - startedAt };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: heartbeat.connected ? 'game-connected' : 'offline',
      data,
      warnings,
      changes: [{ kind: 'game-stop', instance: args.instance, pid, exited, forced }],
    });
  } catch (error) {
    return toolError(error);
  }
}

// ---------------------------------------------------------------------------
// Helpers for the tools that accept an optional `instance`.
// ---------------------------------------------------------------------------

/** Calls a method on a running game instance; the caller maps errors with mapRuntimeBridgeError. */
export function callGame<R = unknown>(
  ctx: ProjectMeta,
  instance: string,
  method: BridgeMethod,
  params: Record<string, unknown>,
  deadlineMs?: number,
): Promise<RuntimeBridgeCall<R>> {
  return callRuntimeBridge<BridgeMethod, Record<string, unknown>, R>(ctx, instance, method, params, deadlineMs ? { deadlineMs } : {});
}

const GAME_CAPTURE_FILE = /^[A-Za-z0-9_.-]{1,160}\.png$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Copies a PNG a game wrote into <instance>/captures into the project capture cache
 * (Cache/MCP/captures/<id>.png) so the existing flax://capture/<id> resource serves it.
 * `reported` is the file name or relative path the bridge reported, if any; only its
 * base name is used and the file must be a regular file inside the instance captures
 * directory. Returns the new 32-hex capture id and the size.
 */
export async function importGameCapture(
  ctx: ProjectMeta,
  instance: string,
  gameCaptureId: string,
  reported?: string,
): Promise<{ id: string; size: number }> {
  const capturesDirectory = path.join(runtimeInstanceDirectory(ctx, instance), RUNTIME_BRIDGE_CAPTURES_DIRECTORY);
  const reportedName = typeof reported === 'string' && reported ? path.posix.basename(reported.replaceAll('\\', '/')) : '';
  const name = GAME_CAPTURE_FILE.test(reportedName) ? reportedName : `${gameCaptureId}.png`;
  if (!GAME_CAPTURE_FILE.test(name)) throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game reported an invalid capture file name.');
  const lexical = path.join(capturesDirectory, name);
  let realDirectory: string;
  let real: string;
  try {
    const link = await fs.lstat(lexical);
    if (link.isSymbolicLink() || !link.isFile()) throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game capture is not a regular file.');
    realDirectory = await fs.realpath(capturesDirectory);
    real = await fs.realpath(lexical);
  } catch (error) {
    if (error instanceof ToolDomainError) throw error;
    throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game capture file was not found in the instance capture directory.');
  }
  const relative = path.relative(realDirectory, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game capture escapes the instance capture directory.');
  }
  const handle = await fs.open(real, 'r');
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MaxCaptureBytes) {
      throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game capture is empty or larger than the capture size limit.');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ToolDomainError('CAPTURE_UNAVAILABLE', 'The game capture is not a valid PNG file.');
  }
  const id = randomBytes(16).toString('hex');
  const target = path.join(ctx.projectPath, 'Cache', 'MCP', 'captures');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, `${id}.png`), bytes, { flag: 'wx', mode: 0o600 });
  await fs.rm(real, { force: true }).catch(() => undefined);
  return { id, size: bytes.length };
}
