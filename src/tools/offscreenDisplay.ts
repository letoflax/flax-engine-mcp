import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolDomainError } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import {
  DEFAULT_OFFSCREEN_SIZE,
  isProcessAlive,
  offscreenDisplayBackend,
  parseOffscreenSize,
  waylandRuntimeDir,
  WESTON_INSTALL_HINT,
} from '../platform.js';

// Off-screen ("background") Editor display. Linux: a private headless Weston compositor on the real GPU. The
// Editor gets WAYLAND_DISPLAY=<private socket> and no DISPLAY, so SDL picks Wayland, Vulkan renders on the real
// GPU and nothing appears on the user's desktop. Windows and macOS have no equivalent this server can start, so
// they are refused with UNSUPPORTED_PLATFORM instead of pretending.
//
// Lifetime: Weston is started before the Editor and must never outlive it. Three independent paths stop it:
//  1. a detached `sh` watcher (survives this server and the one-shot CLI) that waits for the Editor pid to end,
//  2. the launch handler (launch failure, Editor exited early, in-process 'exit' event),
//  3. editor_quit, once the Editor process is gone.
// All three go through stopOffscreenDisplay(), which is idempotent and only signals a pid whose command line
// still carries this display's unique --socket=<name>, so a recycled pid is never touched.
// State lives in <project>/Cache/MCP/offscreen.json so a later tool call (a new CLI process) can find it.

export const OFFSCREEN_RECORD_FILE = 'offscreen.json';
export const OFFSCREEN_LOG_FILE = 'offscreen-weston.log';
const SOCKET_WAIT_MS = 10_000;
const SOCKET_POLL_MS = 100;
const STOP_GRACE_MS = 3_000;
const STOP_POLL_MS = 50;
const WATCHER_TAG = 'flax-mcp-offscreen-watch';

export interface OffscreenRecord {
  version: 1;
  backend: 'weston';
  socket: string;
  runtimeDir: string;
  size: string;
  westonPid: number;
  watcherPid: number | null;
  editorPid: number | null;
  startedAtMs: number;
  log: string;
}

/** What a tool result reports about the display the Editor runs on. */
export interface OffscreenInfo {
  backend: 'weston';
  socket: string;
  size: string;
  westonPid: number;
  westonAlive: boolean;
  log: string;
}

export interface OffscreenDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  uid: number | null;
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  findExecutable: (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  pathExists: (target: string) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  readCommandLine: (pid: number) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const folders = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const fallback of ['/usr/bin', '/usr/local/bin', '/bin']) if (!folders.includes(fallback)) folders.push(fallback);
  for (const folder of folders) {
    const candidate = path.join(folder, name);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if ((await fs.promises.stat(candidate)).isFile()) return candidate;
    } catch { /* next folder */ }
  }
  return null;
}

/** The full command line (NUL-separated argv joined by spaces) from /proc, or null when unreadable. */
export async function readProcCommandLine(pid: number): Promise<string | null> {
  try {
    return (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ').trim();
  } catch {
    return null;
  }
}

export function defaultOffscreenDeps(): OffscreenDeps {
  return {
    platform: process.platform,
    env: process.env,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    spawn: (file, args, options) => nodeSpawn(file, [...args], options),
    findExecutable: findExecutableOnPath,
    pathExists: target => fs.promises.stat(target).then(() => true, () => false),
    isAlive: isProcessAlive,
    signal: (pid, signal) => { process.kill(pid, signal); },
    readCommandLine: readProcCommandLine,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The unique Wayland socket name of one display: letters, digits and dashes only. */
export function newOffscreenSocketName(): string {
  return `flaxmcp-${process.pid}-${randomBytes(4).toString('hex')}`;
}

/** The fixed Weston command line: nothing but numbers and the generated socket and log names reach it. */
export function westonArguments(socket: string, size: { width: number; height: number }, logFile: string): string[] {
  return [
    '--backend=headless',
    '--renderer=gl',
    `--socket=${socket}`,
    `--width=${size.width}`,
    `--height=${size.height}`,
    '--idle-time=0',
    `--log=${logFile}`,
  ];
}

/**
 * Environment of an off-screen Editor: DISPLAY removed (so it cannot fall back to the real screen), the private
 * socket as WAYLAND_DISPLAY, and a conflicting SDL_VIDEODRIVER dropped so SDL picks Wayland.
 */
export function offscreenEditorEnv(base: NodeJS.ProcessEnv, socket: string, runtimeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['DISPLAY'];
  delete env['WAYLAND_SOCKET'];
  const driver = env['SDL_VIDEODRIVER'];
  if (driver !== undefined && !/wayland/i.test(driver)) delete env['SDL_VIDEODRIVER'];
  env['WAYLAND_DISPLAY'] = socket;
  env['XDG_RUNTIME_DIR'] = runtimeDir;
  return env;
}

/**
 * The detached watcher: waits for the Editor pid to end, then stops that Weston (TERM, then KILL after 10 s),
 * only while the pid's command line still carries this display's socket. Built from two integers and the
 * generated socket name, so nothing caller-controlled reaches the shell.
 */
export function offscreenWatcherScript(editorPid: number, westonPid: number, socket: string): string {
  if (!Number.isInteger(editorPid) || editorPid <= 0 || !Number.isInteger(westonPid) || westonPid <= 0 || !/^[A-Za-z0-9-]+$/.test(socket)) {
    throw new Error('offscreenWatcherScript: invalid pid or socket name.');
  }
  const mine = `grep -qa -e '--socket=${socket}' /proc/${westonPid}/cmdline 2>/dev/null`;
  return [
    `# ${WATCHER_TAG}`,
    `while kill -0 ${editorPid} 2>/dev/null; do sleep 1; done`,
    `if ${mine}; then`,
    `  kill ${westonPid} 2>/dev/null`,
    '  i=0',
    `  while [ $i -lt 10 ] && kill -0 ${westonPid} 2>/dev/null; do sleep 1; i=$((i+1)); done`,
    `  if ${mine}; then kill -9 ${westonPid} 2>/dev/null; fi`,
    'fi',
  ].join('\n');
}

function recordPath(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, 'Cache', 'MCP', OFFSCREEN_RECORD_FILE);
}

export async function readOffscreenRecord(ctx: ProjectMeta): Promise<OffscreenRecord | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(recordPath(ctx), 'utf8')) as Partial<OffscreenRecord>;
    if (parsed.version !== 1 || parsed.backend !== 'weston' || typeof parsed.socket !== 'string' || !/^[A-Za-z0-9-]+$/.test(parsed.socket)) return null;
    if (!Number.isInteger(parsed.westonPid) || (parsed.westonPid as number) <= 0) return null;
    return parsed as OffscreenRecord;
  } catch {
    return null;
  }
}

async function writeOffscreenRecord(ctx: ProjectMeta, record: OffscreenRecord): Promise<void> {
  const target = recordPath(ctx);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, JSON.stringify(record, null, 2), 'utf8');
}

async function deleteOffscreenRecord(ctx: ProjectMeta, westonPid: number): Promise<void> {
  const current = await readOffscreenRecord(ctx);
  if (current && current.westonPid !== westonPid) return; // a newer display owns the file
  await fs.promises.rm(recordPath(ctx), { force: true });
}

/** True when the pid still runs the Weston (or the watcher) this record describes: never signal a recycled pid. */
async function isOurProcess(pid: number, marker: string, deps: OffscreenDeps): Promise<boolean> {
  if (!deps.isAlive(pid)) return false;
  const commandLine = await deps.readCommandLine(pid);
  return commandLine !== null && commandLine.includes(marker);
}

/**
 * Stops the Weston of a record (TERM, then KILL after a short grace), stops its watcher, and deletes the record.
 * Idempotent: a Weston that is already gone is fine.
 */
export async function stopOffscreenDisplay(ctx: ProjectMeta, record: OffscreenRecord, deps: OffscreenDeps): Promise<{ stopped: boolean }> {
  const marker = `--socket=${record.socket}`;
  let stopped = false;
  if (await isOurProcess(record.westonPid, marker, deps)) {
    try { deps.signal(record.westonPid, 'SIGTERM'); } catch { /* gone meanwhile */ }
    const end = deps.now() + STOP_GRACE_MS;
    while (deps.isAlive(record.westonPid) && deps.now() < end) await deps.sleep(STOP_POLL_MS);
    if (deps.isAlive(record.westonPid) && await isOurProcess(record.westonPid, marker, deps)) {
      try { deps.signal(record.westonPid, 'SIGKILL'); } catch { /* gone meanwhile */ }
    }
    stopped = true;
  }
  if (record.watcherPid !== null && await isOurProcess(record.watcherPid, WATCHER_TAG, deps)) {
    try { deps.signal(record.watcherPid, 'SIGTERM'); } catch { /* gone meanwhile */ }
  }
  await deleteOffscreenRecord(ctx, record.westonPid).catch(() => undefined);
  return { stopped };
}

export interface OffscreenSession {
  record: OffscreenRecord;
  /** Environment to start the Editor with. */
  editorEnv: NodeJS.ProcessEnv;
  westonChild: ChildProcess;
}

/** Refuses an off-screen request the host cannot satisfy, before anything is started. */
export function assertOffscreenSupported(platform: NodeJS.Platform): void {
  if (offscreenDisplayBackend(platform) === null) {
    throw new ToolDomainError(
      'UNSUPPORTED_PLATFORM',
      `display "offscreen" is only implemented on Linux (a private headless Weston compositor); ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform} has no equivalent this server can start. The Editor was not started. Use display "desktop", or headless:true for a window-less Editor without viewport capture.`,
      { platform, supported: ['linux'] },
    );
  }
}

async function logTail(file: string): Promise<string> {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return text.trim().split(/\r?\n/).slice(-6).join(' | ').slice(-600);
  } catch {
    return '';
  }
}

/** Reaps a display left by an earlier launch whose Editor is gone (watcher missed, server killed, crash). */
export async function reapStaleOffscreenDisplay(ctx: ProjectMeta, deps: OffscreenDeps): Promise<boolean> {
  const stale = await readOffscreenRecord(ctx);
  if (!stale) return false;
  if (stale.editorPid !== null && deps.isAlive(stale.editorPid)) return false;
  await stopOffscreenDisplay(ctx, stale, deps);
  return true;
}

/**
 * Starts the private Weston and waits for its socket. On any failure Weston is stopped again before the error
 * leaves, so a failed start never leaks a compositor.
 */
export async function startOffscreenDisplay(ctx: ProjectMeta, sizeText: string | undefined, deps: OffscreenDeps): Promise<OffscreenSession> {
  assertOffscreenSupported(deps.platform);
  const size = parseOffscreenSize(sizeText ?? DEFAULT_OFFSCREEN_SIZE);
  if (!size) throw new ToolDomainError('INVALID_ARGUMENT', `offscreen_size must be WIDTHxHEIGHT with each edge between 320 and 8192, for example ${DEFAULT_OFFSCREEN_SIZE}.`);
  const weston = await deps.findExecutable('weston', deps.env);
  if (!weston) {
    throw new ToolDomainError('DEPENDENCY_MISSING', `display "offscreen" needs the weston executable, which was not found on PATH. ${WESTON_INSTALL_HINT} The Editor was not started.`, { executable: 'weston', hint: WESTON_INSTALL_HINT });
  }
  const runtimeDir = waylandRuntimeDir(deps.env, deps.uid);
  if (!runtimeDir || !(await deps.pathExists(runtimeDir))) {
    throw new ToolDomainError('DEPENDENCY_MISSING', 'display "offscreen" needs a per-user runtime directory for the Wayland socket: set XDG_RUNTIME_DIR (normally /run/user/<uid>, created by a login session).', { runtimeDir });
  }

  const socket = newOffscreenSocketName();
  const logFile = path.join(ctx.projectPath, 'Cache', 'MCP', OFFSCREEN_LOG_FILE);
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const westonEnv: NodeJS.ProcessEnv = { ...deps.env, XDG_RUNTIME_DIR: runtimeDir };
  const child = deps.spawn(weston, westonArguments(socket, size, logFile), { detached: true, stdio: 'ignore', env: westonEnv });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    throw new ToolDomainError('INTERNAL_ERROR', `weston could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  child.unref();
  const westonPid = child.pid;
  if (westonPid === undefined) throw new ToolDomainError('INTERNAL_ERROR', 'weston started without a pid.');
  const record: OffscreenRecord = {
    version: 1, backend: 'weston', socket, runtimeDir, size: `${size.width}x${size.height}`,
    westonPid, watcherPid: null, editorPid: null, startedAtMs: deps.now(), log: path.relative(ctx.projectPath, logFile).split(path.sep).join('/'),
  };
  // Written before the wait so a crash of this server during it still leaves a record that reaps the compositor.
  await writeOffscreenRecord(ctx, record);

  const socketPath = path.join(runtimeDir, socket);
  const end = deps.now() + SOCKET_WAIT_MS;
  for (;;) {
    if (await deps.pathExists(socketPath)) break;
    const gone = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
    if (gone || deps.now() >= end) {
      const why = gone ? `exited (${gone.signal ?? `code ${gone.code}`})` : `did not create its socket within ${SOCKET_WAIT_MS} ms`;
      const tail = await logTail(logFile);
      await stopOffscreenDisplay(ctx, record, deps);
      throw new ToolDomainError('INTERNAL_ERROR', `The private Weston compositor ${why}. The Editor was not started.${tail ? ` Weston log: ${tail}` : ''}`, { socket, log: record.log });
    }
    await deps.sleep(SOCKET_POLL_MS);
  }
  return { record, editorEnv: offscreenEditorEnv(deps.env, socket, runtimeDir), westonChild: child };
}

/**
 * Binds a started Editor to its display: records the Editor pid and starts the detached watcher that stops
 * Weston when the Editor exits, even if this server or the one-shot CLI is gone by then.
 */
export async function bindEditorToDisplay(ctx: ProjectMeta, session: OffscreenSession, editorPid: number, deps: OffscreenDeps): Promise<void> {
  session.record.editorPid = editorPid;
  try {
    const watcher = deps.spawn('/bin/sh', ['-c', offscreenWatcherScript(editorPid, session.record.westonPid, session.record.socket)], { detached: true, stdio: 'ignore' });
    watcher.on('error', () => undefined);
    watcher.unref();
    session.record.watcherPid = watcher.pid ?? null;
  } catch {
    session.record.watcherPid = null; // the launch and quit handlers still stop Weston
  }
  await writeOffscreenRecord(ctx, session.record);
}

/**
 * Display facts for a status result: the recorded off-screen display of the Editor with this pid (the connected
 * bridge's pid), or, when no pid is given, of a launched Editor that is still starting. Null otherwise: an Editor
 * this server did not start on an off-screen display is reported as unknown, never guessed.
 */
export async function describeOffscreenDisplay(ctx: ProjectMeta, editorPid: number | null, deps: OffscreenDeps = defaultOffscreenDeps()): Promise<OffscreenInfo | null> {
  const record = await readOffscreenRecord(ctx);
  if (!record || record.editorPid === null) return null;
  if (editorPid !== null ? record.editorPid !== editorPid : !deps.isAlive(record.editorPid)) return null;
  return {
    backend: record.backend,
    socket: record.socket,
    size: record.size,
    westonPid: record.westonPid,
    westonAlive: await isOurProcess(record.westonPid, `--socket=${record.socket}`, deps),
    log: record.log,
  };
}

/**
 * editor_quit hook: once the Editor process `editorPid` is gone, stops the Weston it ran on. Returns null when
 * that Editor did not run on a recorded off-screen display, or is still running.
 */
export async function stopOffscreenDisplayForEditor(ctx: ProjectMeta, editorPid: number | null, deps: OffscreenDeps = defaultOffscreenDeps()): Promise<{ stopped: boolean; socket: string } | null> {
  if (editorPid === null) return null;
  const record = await readOffscreenRecord(ctx);
  if (!record || record.editorPid !== editorPid || deps.isAlive(editorPid)) return null;
  const { stopped } = await stopOffscreenDisplay(ctx, record, deps);
  return { stopped, socket: record.socket };
}
