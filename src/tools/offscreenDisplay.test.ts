import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { DEFAULT_OFFSCREEN_SIZE, offscreenDisplayBackend, parseOffscreenSize, waylandRuntimeDir, WESTON_INSTALL_HINT } from '../platform.js';
import { handleEditorLaunch, type EditorLaunchDeps } from './editorLaunch.js';
import { EditorLaunchSchema, EditorQuitSchema, handleEditorQuit, type EditorLifecycleDeps } from './editorLifecycle.js';
import {
  OFFSCREEN_RECORD_FILE,
  offscreenEditorEnv,
  offscreenWatcherScript,
  readOffscreenRecord,
  defaultOffscreenDeps,
  stopOffscreenDisplayForEditor,
  westonArguments,
  type OffscreenDeps,
} from './offscreenDisplay.js';
import { handleEditorGetStatus, type EditorBridgeStatus } from './serverStatus.js';

const WESTON_PID = 5001;
const EDITOR_PID = 4321;
const WATCHER_PID = 5002;
const RUNTIME_DIR = '/run/user/1000';

const CONNECTED = (pid: number): EditorBridgeStatus => ({ connected: true, reason: 'connected', pid, heartbeatAgeMs: 10, editorVersion: '1.12.0', bridgeVersion: '36', protocolVersion: '1', endpoint: null });
const DISCONNECTED: EditorBridgeStatus = { connected: false, reason: 'heartbeat_missing', pid: null, heartbeatAgeMs: null, editorVersion: null, bridgeVersion: null, protocolVersion: null, endpoint: null };

interface Fixture { root: string; editor: string; ctx: ProjectMeta; cleanup(): Promise<void> }

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-offscreen-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const editor = path.join(root, 'tools', 'FlaxEditor');
  await fs.mkdir(path.dirname(editor), { recursive: true });
  await fs.writeFile(editor, '');
  const ctx = await createProjectContext(root);
  ctx.flaxEditorPath = editor;
  return { root, editor, ctx, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

interface FakeChild extends EventEmitter { pid: number; unref(): void; unrefCalled: boolean }
interface Spawned { file: string; args: string[]; options: SpawnOptions; child: FakeChild }

interface Rig {
  deps: EditorLaunchDeps;
  spawned: Spawned[];
  signals: Array<[number, string]>;
  alive: Set<number>;
  /** Names of the steps in the order they happened, e.g. spawn:weston, socket, spawn:editor. */
  events: string[];
  westonSocket(): string | null;
}

function rig(options: {
  platform?: NodeJS.Platform;
  weston?: string | null;
  socketAfterPolls?: number | null;
  westonExit?: number;
  westonIgnoresTerm?: boolean;
  editorExit?: number;
  editorSpawnError?: Error;
  inspect?: (call: number) => EditorBridgeStatus;
  env?: NodeJS.ProcessEnv;
  runtimeDirExists?: boolean;
  /** Pre-seeded cmdlines for pids this rig did not spawn. */
  cmdlines?: Record<number, string>;
} = {}): Rig {
  const spawned: Spawned[] = [];
  const signals: Array<[number, string]> = [];
  const alive = new Set<number>();
  const events: string[] = [];
  const clock = { now: 2_000_000 };
  let inspectCalls = 0;
  let socketPolls = 0;
  const socketOf = () => {
    const weston = spawned.find(call => call.file.endsWith('weston'));
    const arg = weston?.args.find(a => a.startsWith('--socket='));
    return arg ? arg.slice('--socket='.length) : null;
  };
  const cmdlineOf = (pid: number): string | null => {
    if (options.cmdlines?.[pid] !== undefined) return options.cmdlines[pid]!;
    const call = spawned.find(entry => entry.child.pid === pid);
    return call ? [call.file, ...call.args].join(' ') : null;
  };
  const offscreen: Partial<OffscreenDeps> = {
    platform: options.platform ?? 'linux',
    env: options.env ?? { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: RUNTIME_DIR, SDL_VIDEODRIVER: 'x11', HOME: '/home/u' },
    uid: 1000,
    findExecutable: async name => (name === 'weston' ? (options.weston === undefined ? '/usr/bin/weston' : options.weston) : null),
    pathExists: async target => {
      if (target === RUNTIME_DIR) return options.runtimeDirExists !== false;
      const socket = socketOf();
      if (socket && target === path.join(RUNTIME_DIR, socket)) {
        socketPolls += 1;
        const ready = options.socketAfterPolls !== null && socketPolls > (options.socketAfterPolls ?? 0);
        if (ready) events.push('socket');
        return ready;
      }
      return false;
    },
    isAlive: pid => alive.has(pid),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      events.push(`signal:${pid}:${signal}`);
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !(options.westonIgnoresTerm && pid === WESTON_PID))) alive.delete(pid);
    },
    readCommandLine: async pid => cmdlineOf(pid),
  };
  const deps: EditorLaunchDeps = {
    spawn: (file, args, spawnOptions) => {
      const pid = file.endsWith('weston') ? WESTON_PID : file === '/bin/sh' ? WATCHER_PID : EDITOR_PID;
      const child = Object.assign(new EventEmitter(), { pid, unrefCalled: false, unref() { this.unrefCalled = true; } }) as FakeChild;
      spawned.push({ file, args: [...args], options: spawnOptions, child });
      events.push(`spawn:${path.basename(file)}`);
      alive.add(pid);
      process.nextTick(() => {
        if (pid === EDITOR_PID && options.editorSpawnError) { child.emit('error', options.editorSpawnError); return; }
        child.emit('spawn');
        if (pid === WESTON_PID && options.westonExit !== undefined) setImmediate(() => { alive.delete(pid); child.emit('exit', options.westonExit, null); });
        if (pid === EDITOR_PID && options.editorExit !== undefined) setImmediate(() => { alive.delete(pid); child.emit('exit', options.editorExit, null); });
      });
      return child as unknown as ChildProcess;
    },
    listProcesses: async () => [],
    inspectBridge: async () => (options.inspect ?? (() => DISCONNECTED))(inspectCalls++),
    sleep: async ms => { clock.now += ms; await new Promise(resolve => setImmediate(resolve)); },
    now: () => clock.now,
    offscreen,
  };
  return { deps, spawned, signals, alive, events, westonSocket: socketOf };
}

/** The rig's off-screen seams completed with sleep/now, as handleEditorLaunch resolves them. */
const stopDeps = (r: Rig, overrides: Partial<OffscreenDeps> = {}): OffscreenDeps => ({ ...defaultOffscreenDeps(), spawn: r.deps.spawn, sleep: r.deps.sleep, now: r.deps.now, ...r.deps.offscreen, ...overrides });

const parse = (input: Record<string, unknown> = {}) => EditorLaunchSchema.parse(input);
const envelope = (result: Awaited<ReturnType<typeof handleEditorLaunch>>) => result.structuredContent as Record<string, any>;
const offscreenArgs = (extra: Record<string, unknown> = {}) => parse({ display: 'offscreen', wait_ready: false, ...extra });

test('editor_launch display schema: desktop by default, offscreen with an optional WIDTHxHEIGHT, no free text', () => {
  const defaults = EditorLaunchSchema.parse({});
  assert.equal(defaults.display, 'desktop');
  assert.equal(defaults.offscreen_size, undefined);
  assert.equal(EditorLaunchSchema.parse({ display: 'offscreen', offscreen_size: '1280x720' }).offscreen_size, '1280x720');
  for (const bad of ['1920', '1920x', 'big', '1920x1080; rm', '12x12x12', '19200x1080']) {
    assert.equal(EditorLaunchSchema.safeParse({ display: 'offscreen', offscreen_size: bad }).success, false, bad);
  }
  assert.equal(EditorLaunchSchema.safeParse({ display: 'tv' }).success, false);
  assert.equal(EditorLaunchSchema.safeParse({ socket: 'x' }).success, false);
});

test('size parsing, backend per OS and runtime dir helpers', () => {
  assert.deepEqual(parseOffscreenSize('1920x1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseOffscreenSize(' 800X600 '), { width: 800, height: 600 });
  assert.equal(parseOffscreenSize('100x100'), null);
  assert.equal(parseOffscreenSize('9000x1080'), null);
  assert.equal(parseOffscreenSize('abc'), null);
  assert.equal(DEFAULT_OFFSCREEN_SIZE, '1920x1080');
  assert.equal(offscreenDisplayBackend('linux'), 'weston');
  assert.equal(offscreenDisplayBackend('win32'), null);
  assert.equal(offscreenDisplayBackend('darwin'), null);
  assert.equal(waylandRuntimeDir({ XDG_RUNTIME_DIR: '/x' }, 1000), '/x');
  assert.equal(waylandRuntimeDir({}, 1000), '/run/user/1000');
  assert.equal(waylandRuntimeDir({}, null), null);
});

test('off-screen environment: DISPLAY removed, WAYLAND_DISPLAY and XDG_RUNTIME_DIR set, a conflicting SDL driver dropped, base untouched', () => {
  const base = { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', WAYLAND_SOCKET: '7', SDL_VIDEODRIVER: 'x11', HOME: '/h' };
  const env = offscreenEditorEnv(base, 'flaxmcp-1-ab', RUNTIME_DIR);
  assert.equal('DISPLAY' in env, false);
  assert.equal('WAYLAND_SOCKET' in env, false);
  assert.equal('SDL_VIDEODRIVER' in env, false);
  assert.equal(env['WAYLAND_DISPLAY'], 'flaxmcp-1-ab');
  assert.equal(env['XDG_RUNTIME_DIR'], RUNTIME_DIR);
  assert.equal(env['PATH'], '/usr/bin');
  assert.equal(env['HOME'], '/h');
  assert.equal(base.DISPLAY, ':0');
  assert.equal(base.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(offscreenEditorEnv({ SDL_VIDEODRIVER: 'wayland' }, 's', RUNTIME_DIR)['SDL_VIDEODRIVER'], 'wayland');
});

test('weston command line and watcher script are fixed text built from numbers and the generated socket', () => {
  assert.deepEqual(westonArguments('flaxmcp-9-ab12cd34', { width: 1280, height: 720 }, '/p/Cache/MCP/offscreen-weston.log'), [
    '--backend=headless', '--renderer=gl', '--socket=flaxmcp-9-ab12cd34', '--width=1280', '--height=720', '--idle-time=0', '--log=/p/Cache/MCP/offscreen-weston.log',
  ]);
  const script = offscreenWatcherScript(4321, 5001, 'flaxmcp-9-ab12cd34');
  assert.match(script, /while kill -0 4321 /);
  assert.match(script, /--socket=flaxmcp-9-ab12cd34' \/proc\/5001\/cmdline/);
  assert.match(script, /kill 5001/);
  assert.match(script, /kill -9 5001/);
  assert.match(script, /flax-mcp-offscreen-watch/);
  assert.doesNotMatch(script, /FlaxEditor/i);
  assert.throws(() => offscreenWatcherScript(4321, 5001, 'x; rm -rf /'), /invalid pid or socket/);
  assert.throws(() => offscreenWatcherScript(0, 5001, 'ok'), /invalid pid or socket/);
  assert.throws(() => offscreenWatcherScript(1.5, 5001, 'ok'), /invalid pid or socket/);
});

test('offscreen launch: weston first on a unique socket, then the Editor with DISPLAY removed, a watcher, and a record', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 2 });
    const result = await handleEditorLaunch(offscreenArgs({ offscreen_size: '1280x720' }), f.ctx, r.deps);
    const body = envelope(result);
    assert.equal(body.ok, true, JSON.stringify(body.error));
    assert.deepEqual(r.events.filter(e => e.startsWith('spawn') || e === 'socket'), ['spawn:weston', 'socket', 'spawn:FlaxEditor', 'spawn:sh']);

    const [weston, editor, watcher] = r.spawned;
    const socket = r.westonSocket()!;
    assert.match(socket, /^flaxmcp-\d+-[0-9a-f]{8}$/);
    assert.equal(weston!.file, '/usr/bin/weston');
    assert.deepEqual(weston!.args, westonArguments(socket, { width: 1280, height: 720 }, path.join(f.root, 'Cache', 'MCP', 'offscreen-weston.log')));
    assert.equal(weston!.options.detached, true);
    assert.equal(weston!.options.stdio, 'ignore');
    assert.equal(weston!.child.unrefCalled, true);

    assert.equal(editor!.file, f.editor);
    assert.deepEqual(editor!.args, ['-project', f.ctx.projectPath]);
    const env = editor!.options.env as NodeJS.ProcessEnv;
    assert.equal('DISPLAY' in env, false);
    assert.equal(env['WAYLAND_DISPLAY'], socket);
    assert.equal(env['XDG_RUNTIME_DIR'], RUNTIME_DIR);
    assert.equal('SDL_VIDEODRIVER' in env, false);

    assert.equal(watcher!.file, '/bin/sh');
    assert.equal(watcher!.args[0], '-c');
    assert.match(watcher!.args[1]!, new RegExp(`kill -0 ${EDITOR_PID} .*proc/${WESTON_PID}/cmdline`, 's'));
    assert.equal(watcher!.options.detached, true);

    assert.equal(body.data.display, 'offscreen');
    assert.equal(body.data.pid, EDITOR_PID);
    assert.deepEqual(body.data.offscreen, { backend: 'weston', socket, size: '1280x720', westonPid: WESTON_PID, log: 'Cache/MCP/offscreen-weston.log' });
    assert.deepEqual(body.changes[0], { kind: 'editor-launch', pid: EDITOR_PID });
    assert.deepEqual(body.changes[1], { kind: 'offscreen-display-start', backend: 'weston', pid: WESTON_PID, socket });

    const record = await readOffscreenRecord(f.ctx);
    assert.equal(record?.westonPid, WESTON_PID);
    assert.equal(record?.editorPid, EDITOR_PID);
    assert.equal(record?.watcherPid, WATCHER_PID);
    assert.equal(record?.socket, socket);
    assert.equal(r.signals.length, 0, 'a successful launch stops nothing');
  } finally { await f.cleanup(); }
});

test('offscreen launch defaults the size to 1920x1080; a desktop launch spawns one process and passes no env', async () => {
  const f = await fixture();
  try {
    const off = rig({ socketAfterPolls: 0 });
    await handleEditorLaunch(offscreenArgs(), f.ctx, off.deps);
    assert.ok(off.spawned[0]!.args.includes('--width=1920'));
    assert.ok(off.spawned[0]!.args.includes('--height=1080'));

    const desktopRoot = await fixture();
    try {
      const desk = rig();
      const result = await handleEditorLaunch(parse({ wait_ready: false }), desktopRoot.ctx, desk.deps);
      assert.equal(envelope(result).data.display, 'desktop');
      assert.equal(envelope(result).data.offscreen, undefined);
      assert.equal(desk.spawned.length, 1);
      assert.equal('env' in desk.spawned[0]!.options, false);
      assert.equal(await readOffscreenRecord(desktopRoot.ctx), null);
      const sized = await handleEditorLaunch(parse({ wait_ready: false, offscreen_size: '800x600' }), desktopRoot.ctx, rig().deps);
      assert.match(envelope(sized).warnings.join(' '), /offscreen_size is ignored/);
    } finally { await desktopRoot.cleanup(); }
  } finally { await f.cleanup(); }
});

test('offscreen launch on Windows and macOS is refused honestly before anything starts', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const f = await fixture();
    try {
      const r = rig({ platform });
      const result = await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
      assert.equal(result.isError, true);
      assert.equal(envelope(result).error.code, 'UNSUPPORTED_PLATFORM', platform);
      assert.match(envelope(result).error.message, /only implemented on Linux/);
      assert.match(envelope(result).error.message, /not started/);
      assert.equal(r.spawned.length, 0, platform);
      // The same host still launches on the desktop.
      const desk = await handleEditorLaunch(parse({ wait_ready: false }), f.ctx, rig({ platform }).deps);
      assert.equal(envelope(desk).ok, true);
    } finally { await f.cleanup(); }
  }
});

test('offscreen launch without weston answers DEPENDENCY_MISSING with an install hint and starts nothing', async () => {
  const f = await fixture();
  try {
    const r = rig({ weston: null });
    const result = await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    assert.equal(envelope(result).error.code, 'DEPENDENCY_MISSING');
    assert.match(envelope(result).error.message, /weston/);
    assert.match(envelope(result).error.message, /dnf install weston/);
    assert.equal(envelope(result).error.details.hint, WESTON_INSTALL_HINT);
    assert.equal(r.spawned.length, 0);
    assert.equal(await readOffscreenRecord(f.ctx), null);

    const noRuntime = rig({ runtimeDirExists: false });
    const missing = await handleEditorLaunch(offscreenArgs(), f.ctx, noRuntime.deps);
    assert.equal(envelope(missing).error.code, 'DEPENDENCY_MISSING');
    assert.match(envelope(missing).error.message, /XDG_RUNTIME_DIR/);
    assert.equal(noRuntime.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('offscreen and headless are mutually exclusive, and a bad size is rejected before weston starts', async () => {
  const f = await fixture();
  try {
    const both = rig();
    const conflict = await handleEditorLaunch(offscreenArgs({ headless: true }), f.ctx, both.deps);
    assert.equal(envelope(conflict).error.code, 'INVALID_ARGUMENT');
    assert.equal(both.spawned.length, 0);

    const small = rig();
    const tiny = await handleEditorLaunch(offscreenArgs({ offscreen_size: '100x100' }), f.ctx, small.deps);
    assert.equal(envelope(tiny).error.code, 'INVALID_ARGUMENT');
    assert.match(envelope(tiny).error.message, /between 320 and 8192/);
    assert.equal(small.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('EDITOR_BUSY still wins for an offscreen launch: no weston is started when an Editor is already there', async () => {
  const f = await fixture();
  try {
    const live = rig({ inspect: () => CONNECTED(777) });
    const busy = await handleEditorLaunch(offscreenArgs(), f.ctx, live.deps);
    assert.equal(envelope(busy).error.code, 'EDITOR_BUSY');
    assert.equal(live.spawned.length, 0);

    const running = rig();
    running.deps.listProcesses = async () => [{ pid: 55, commandLine: `"${f.editor}" -project "${f.root}"` }];
    const refused = await handleEditorLaunch(offscreenArgs(), f.ctx, running.deps);
    assert.equal(envelope(refused).error.code, 'EDITOR_BUSY');
    assert.deepEqual(envelope(refused).error.details.pids, [55]);
    assert.equal(running.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('weston that never creates its socket is stopped, the Editor never starts, and no record is left', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: null });
    const result = await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    assert.equal(envelope(result).error.code, 'INTERNAL_ERROR');
    assert.match(envelope(result).error.message, /did not create its socket/);
    assert.deepEqual(r.spawned.map(call => path.basename(call.file)), ['weston']);
    assert.deepEqual(r.signals, [[WESTON_PID, 'SIGTERM']]);
    assert.equal(r.alive.has(WESTON_PID), false);
    assert.equal(await readOffscreenRecord(f.ctx), null);
  } finally { await f.cleanup(); }
});

test('weston that exits early reports its log tail, starts no Editor and leaves nothing behind', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Cache', 'MCP'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'Cache', 'MCP', 'offscreen-weston.log'), 'Date: x\nfailed to create gl renderer\n');
    const r = rig({ socketAfterPolls: null, westonExit: 1 });
    const result = await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    assert.equal(envelope(result).error.code, 'INTERNAL_ERROR');
    assert.match(envelope(result).error.message, /exited \(code 1\)/);
    assert.match(envelope(result).error.message, /failed to create gl renderer/);
    assert.equal(r.spawned.length, 1);
    assert.equal(await readOffscreenRecord(f.ctx), null);
  } finally { await f.cleanup(); }
});

test('a weston that ignores SIGTERM is killed after the grace period', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: null, westonIgnoresTerm: true });
    await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    assert.deepEqual(r.signals, [[WESTON_PID, 'SIGTERM'], [WESTON_PID, 'SIGKILL']]);
    assert.equal(r.alive.has(WESTON_PID), false);
  } finally { await f.cleanup(); }
});

test('an Editor that fails to spawn, or exits before its bridge is ready, takes its weston with it', async () => {
  const f = await fixture();
  try {
    const failing = rig({ socketAfterPolls: 0, editorSpawnError: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
    const failed = await handleEditorLaunch(offscreenArgs(), f.ctx, failing.deps);
    assert.match(envelope(failed).error.message, /could not be started/);
    assert.deepEqual(failing.signals, [[WESTON_PID, 'SIGTERM']]);
    assert.equal(failing.alive.has(WESTON_PID), false);
    assert.equal(await readOffscreenRecord(f.ctx), null);

    const crashing = rig({ socketAfterPolls: 0, editorExit: 3 });
    const exited = await handleEditorLaunch(parse({ display: 'offscreen', timeout_ms: 60_000 }), f.ctx, crashing.deps);
    assert.equal(envelope(exited).error.code, 'EDITOR_NOT_CONNECTED');
    assert.equal(envelope(exited).error.details.exitCode, 3);
    assert.deepEqual(crashing.signals.filter(([pid]) => pid === WESTON_PID), [[WESTON_PID, 'SIGTERM']], 'stopped exactly once');
    assert.equal(crashing.alive.has(WESTON_PID), false);
    assert.equal(await readOffscreenRecord(f.ctx), null);
  } finally { await f.cleanup(); }
});

test('a launch that merely times out keeps the Editor and its display running', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 0 });
    const result = await handleEditorLaunch(parse({ display: 'offscreen', timeout_ms: 2_000 }), f.ctx, r.deps);
    assert.equal(envelope(result).error.code, 'TIMEOUT');
    assert.equal(envelope(result).error.details.display, 'offscreen');
    assert.match(envelope(result).error.message, /off-screen display/);
    assert.equal(r.signals.length, 0);
    assert.equal(r.alive.has(WESTON_PID), true);
    assert.equal((await readOffscreenRecord(f.ctx))?.editorPid, EDITOR_PID);
  } finally { await f.cleanup(); }
});

test('wait_ready reports the display in the ready result', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 0, inspect: call => (call < 3 ? DISCONNECTED : CONNECTED(EDITOR_PID)) });
    const result = await handleEditorLaunch(parse({ display: 'offscreen' }), f.ctx, r.deps);
    const body = envelope(result);
    assert.equal(body.ok, true);
    assert.equal(body.data.ready, true);
    assert.equal(body.data.display, 'offscreen');
    assert.equal(body.data.offscreen.westonPid, WESTON_PID);
    assert.equal(body.data.bridgeVersion, '36');
  } finally { await f.cleanup(); }
});

test('a record whose Editor is gone is reaped by the next offscreen launch; a live Editor record is not touched', async () => {
  const f = await fixture();
  try {
    const first = rig({ socketAfterPolls: 0 });
    await handleEditorLaunch(offscreenArgs(), f.ctx, first.deps);
    const stale = (await readOffscreenRecord(f.ctx))!;
    // The old Editor died and its watcher never ran. A new rig knows the old weston is still alive with its socket.
    const second = rig({ socketAfterPolls: 0, cmdlines: { [WESTON_PID]: `weston --socket=${stale.socket}` } });
    second.alive.add(WESTON_PID);
    const result = await handleEditorLaunch(offscreenArgs(), f.ctx, second.deps);
    assert.equal(envelope(result).ok, true);
    assert.match(envelope(result).warnings.join(' '), /left behind by an earlier off-screen launch/);
    assert.deepEqual(second.signals.slice(0, 1), [[WESTON_PID, 'SIGTERM']]);
    assert.notEqual((await readOffscreenRecord(f.ctx))?.socket, stale.socket);
  } finally { await f.cleanup(); }
});

test('stopping never signals a pid whose command line is not this display (recycled pid)', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 0 });
    await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    const record = (await readOffscreenRecord(f.ctx))!;
    const recycled = rig({ cmdlines: { [WESTON_PID]: '/usr/bin/firefox', [WATCHER_PID]: '/usr/bin/python3' } });
    recycled.alive.add(WESTON_PID);
    recycled.alive.add(WATCHER_PID);
    assert.deepEqual(await stopOffscreenDisplayForEditor(f.ctx, EDITOR_PID, stopDeps(recycled, { isAlive: pid => recycled.alive.has(pid) && pid !== EDITOR_PID })), { stopped: false, socket: record.socket });
    assert.equal(recycled.signals.length, 0);
    assert.equal(await readOffscreenRecord(f.ctx), null, 'the record is dropped either way');
  } finally { await f.cleanup(); }
});

function lifecycleDeps(extra: Partial<EditorLifecycleDeps> & { alivePid: () => boolean }): EditorLifecycleDeps {
  let t = 0;
  return {
    call: async () => ({ data: { Accepted: true, Phase: 'exiting', Pid: EDITOR_PID }, warnings: [] }) as never,
    isAlive: () => extra.alivePid(),
    heartbeatPid: async () => EDITOR_PID,
    sleep: async ms => { t += ms; },
    now: () => t,
    ...extra,
  };
}

test('editor_quit stops the display of an off-screen Editor once the process is gone', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 0 });
    await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    const record = (await readOffscreenRecord(f.ctx))!;
    // Editor already exited (alive false) while weston and the watcher are still up.
    r.alive.delete(EDITOR_PID);
    const stopper = (ctx: ProjectMeta, pid: number) => stopOffscreenDisplayForEditor(ctx, pid, stopDeps(r));
    const result = await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, lifecycleDeps({ alivePid: () => false, stopOffscreen: stopper }));
    const body = result.structuredContent as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.data.exited, true);
    assert.equal(body.data.display, 'offscreen');
    assert.equal(body.data.offscreenStopped, true);
    assert.equal(body.data.offscreenAlreadyGone, false);
    assert.deepEqual(r.signals.map(([pid, signal]) => `${pid}:${signal}`), [`${WESTON_PID}:SIGTERM`, `${WATCHER_PID}:SIGTERM`]);
    assert.equal(await readOffscreenRecord(f.ctx), null);
    assert.equal(record.westonPid, WESTON_PID);
  } finally { await f.cleanup(); }
});

test('editor_quit leaves the display alone while the Editor still runs, and ignores Editors without a display', async () => {
  const f = await fixture();
  try {
    const r = rig({ socketAfterPolls: 0 });
    await handleEditorLaunch(offscreenArgs(), f.ctx, r.deps);
    const stopper = (ctx: ProjectMeta, pid: number) => stopOffscreenDisplayForEditor(ctx, pid, stopDeps(r));
    const result = await handleEditorQuit(EditorQuitSchema.parse({ timeout_ms: 1000 }), f.ctx, lifecycleDeps({ alivePid: () => true, stopOffscreen: stopper }));
    const body = result.structuredContent as Record<string, any>;
    assert.equal(body.data.exited, false);
    assert.equal(body.data.display, undefined);
    assert.equal(r.signals.length, 0);
    assert.notEqual(await readOffscreenRecord(f.ctx), null);

    const plain = await fixture();
    try {
      const quit = await handleEditorQuit(EditorQuitSchema.parse({}), plain.ctx, lifecycleDeps({ alivePid: () => false }));
      assert.equal((quit.structuredContent as Record<string, any>).data.display, undefined);
    } finally { await plain.cleanup(); }
  } finally { await f.cleanup(); }
});

test('editor_get_status reports the display only for the Editor that was launched off-screen', async () => {
  const f = await fixture();
  try {
    const cache = path.join(f.root, 'Cache', 'MCP');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: f.root, Timestamp: Date.now(), BridgeVersion: 36, ProtocolVersion: 1 }));
    const status = async () => (await handleEditorGetStatus({}, f.ctx)).structuredContent as Record<string, any>;

    assert.equal((await status()).data.display, undefined, 'no record: unknown, not guessed');

    const record = { version: 1, backend: 'weston', socket: 'flaxmcp-1-aabbccdd', runtimeDir: RUNTIME_DIR, size: '1920x1080', westonPid: 2_000_000_001, watcherPid: null, editorPid: process.pid, startedAtMs: Date.now(), log: 'Cache/MCP/offscreen-weston.log' };
    await fs.writeFile(path.join(cache, OFFSCREEN_RECORD_FILE), JSON.stringify(record));
    const shown = (await status()).data;
    assert.equal(shown.display, 'offscreen');
    assert.equal(shown.offscreen.socket, 'flaxmcp-1-aabbccdd');
    assert.equal(shown.offscreen.size, '1920x1080');
    assert.equal(shown.offscreen.westonAlive, false);

    await fs.writeFile(path.join(cache, OFFSCREEN_RECORD_FILE), JSON.stringify({ ...record, editorPid: process.pid + 1 }));
    assert.equal((await status()).data.display, undefined, 'a record of another Editor is not this Editor\'s display');
    await fs.writeFile(path.join(cache, OFFSCREEN_RECORD_FILE), 'not json');
    assert.equal((await status()).data.display, undefined);
  } finally { await f.cleanup(); }
});
