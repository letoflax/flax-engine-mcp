import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { BridgeRpcError } from '../bridge/protocol.js';
import { listRuntimeBridges, type RuntimeBridgeStatus } from '../bridge/runtimeHeartbeat.js';
import { toolFamily } from '../permissions.js';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { createServerContext } from '../serverContext.js';
import {
  GameLaunchSchema,
  GameListInstancesSchema,
  GameStopSchema,
  gameLaunchArguments,
  handleGameLaunch,
  handleGameListInstances,
  handleGameStop,
  importGameCapture,
  parseAllowGameLaunchArgument,
  resolveGameExecutable,
  type GameRuntimeDeps,
  type GameRuntimeState,
} from './gameRuntime.js';
import { buildToolRegistry } from './index.js';

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

interface Fixture { root: string; outside: string; exe: string; ctx: ProjectMeta; cleanup(): Promise<void> }

async function fixture(allow = true): Promise<Fixture> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-game-'));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(path.join(root, 'Builds'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const exe = path.join(root, 'Builds', 'Game.exe');
  await fs.writeFile(exe, '');
  await fs.writeFile(path.join(outside, 'Evil.exe'), '');
  const ctx = await createProjectContext(root);
  if (allow) ctx.allowGameLaunch = true;
  return { root, outside, exe, ctx, cleanup: () => fs.rm(parent, { recursive: true, force: true }) };
}

function status(instance: string, pid: number | null, connected: boolean, extra: Partial<RuntimeBridgeStatus> = {}): RuntimeBridgeStatus {
  return {
    connected, reason: connected ? 'connected' : 'heartbeat_stale', instance, pid, heartbeatAgeMs: 100,
    bridgeVersion: '35', protocolVersion: '1', productName: 'Fixture', engineVersion: '1.12.6912', ...extra,
  };
}
const MISSING = (instance: string): RuntimeBridgeStatus => ({ ...status(instance, null, false), reason: 'heartbeat_missing', heartbeatAgeMs: null, bridgeVersion: null, protocolVersion: null, productName: null, engineVersion: null });

interface FakeChild extends EventEmitter { pid: number; unrefCalled: boolean; unref(): void }
interface Harness {
  deps: GameRuntimeDeps;
  state: GameRuntimeState;
  spawned: Array<{ file: string; args: string[]; options: SpawnOptions; child: FakeChild }>;
  calls: Array<{ instance: string; method: string; params: Record<string, unknown> }>;
  killed: number[];
  clock: { now: number };
  /** Heartbeat answer per instance; defaults to missing. */
  heartbeats: Map<string, (poll: number) => RuntimeBridgeStatus>;
  /** Process liveness; defaults to "alive until removed". */
  alive: Set<number>;
}

function harness(options: { pid?: number; spawnError?: Error; exitAfterSpawn?: number; callError?: Error; quitKillsAfterPolls?: number } = {}): Harness {
  const spawned: Harness['spawned'] = [];
  const calls: Harness['calls'] = [];
  const killed: number[] = [];
  const clock = { now: 1_000_000 };
  const heartbeats = new Map<string, (poll: number) => RuntimeBridgeStatus>();
  const polls = new Map<string, number>();
  const alive = new Set<number>();
  const state: GameRuntimeState = { pids: new Set(), instances: new Map() };
  let nextPid = options.pid ?? 4321;
  const deps: GameRuntimeDeps = {
    spawn: (file, args, spawnOptions) => {
      const pid = nextPid++;
      const child = Object.assign(new EventEmitter(), { pid, unrefCalled: false, unref() { this.unrefCalled = true; } }) as FakeChild;
      spawned.push({ file, args: [...args], options: spawnOptions, child });
      alive.add(pid);
      process.nextTick(() => {
        if (options.spawnError) child.emit('error', options.spawnError);
        else {
          child.emit('spawn');
          if (options.exitAfterSpawn !== undefined) setImmediate(() => { alive.delete(pid); child.emit('exit', options.exitAfterSpawn, null); });
        }
      });
      return child as unknown as ChildProcess;
    },
    isAlive: pid => alive.has(pid),
    kill: pid => { killed.push(pid); alive.delete(pid); },
    inspect: async (_ctx, instance) => {
      const poll = polls.get(instance) ?? 0;
      polls.set(instance, poll + 1);
      return heartbeats.get(instance)?.(poll) ?? MISSING(instance);
    },
    list: async () => [],
    call: async (_ctx, instance, method, params) => {
      calls.push({ instance, method, params });
      if (options.callError) throw options.callError;
      if (method === 'game.quit') return { data: { Accepted: true }, mode: 'game-connected', bridge: {} as never, warnings: [] };
      return { data: { FrameCount: 12, LoadedSceneCount: 1 }, mode: 'game-connected', bridge: {} as never, warnings: [] };
    },
    sleep: async ms => { clock.now += ms; await new Promise(resolve => setImmediate(resolve)); },
    now: () => clock.now,
    state,
  };
  return { deps, state, spawned, calls, killed, clock, heartbeats, alive };
}

const launch = (input: Record<string, unknown>) => GameLaunchSchema.parse(input);
const envelope = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;

test('--allow-game-launch is a plain switch parsed with the other server flags', async () => {
  assert.equal(parseAllowGameLaunchArgument(['node', 'server']), false);
  assert.equal(parseAllowGameLaunchArgument(['node', 'server', '--allow-game-launch']), true);
  const f = await fixture(false);
  try {
    assert.equal((await createServerContext(['node', 'server'], f.root)).allowGameLaunch, undefined);
    assert.equal((await createServerContext(['node', 'server', '--allow-game-launch'], f.root)).allowGameLaunch, true);
  } finally { await f.cleanup(); }
});

test('flax-mcp call honours --allow-game-launch like the server', async () => {
  const f = await fixture(false);
  try {
    const run = (args: string[]) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', timeout: 60_000 });
    const denied = run(['call', 'game_launch', '{"exe":"Builds/Missing.exe"}', '--project-path', f.root]);
    assert.equal(denied.status, 1, denied.stderr);
    const deniedError = (JSON.parse(denied.stdout) as { error: { code: string; message: string; details: { hint: string } } }).error;
    assert.equal(deniedError.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.equal(deniedError.details.hint, '--allow-game-launch');

    // With the switch the launch gets past the gate; the missing exe stops it before any process starts.
    const allowed = run(['call', 'game_launch', '{"exe":"Builds/Missing.exe"}', '--project-path', f.root, '--allow-game-launch']);
    assert.equal(allowed.status, 1, allowed.stderr);
    assert.equal((JSON.parse(allowed.stdout) as { error: { code: string } }).error.code, 'NOT_FOUND');

    const tools = run(['tools', '--project-path', f.root, '--allow-game-launch']);
    assert.match(tools.stdout, /^game_launch\s+runtime$/m);
    assert.match(tools.stdout, /^game_list_instances\s+read$/m);
    assert.match(tools.stdout, /^game_stop\s+runtime$/m);
  } finally { await f.cleanup(); }
});

test('the three game tools are registered in their permission families with strict schemas', async () => {
  const f = await fixture();
  try {
    const tools = buildToolRegistry(f.ctx);
    for (const [name, family] of [['game_launch', 'runtime'], ['game_list_instances', 'read'], ['game_stop', 'runtime']] as const) {
      assert.equal(toolFamily(name), family, name);
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, name);
      assert.equal(tool.zodInputSchema.safeParse({ exe: 'x.exe', instance: 'a', bogus: 1 }).success, false, `${name} must reject unknown fields`);
    }
    assert.equal(tools.find(tool => tool.name === 'game_list_instances')!.annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'game_launch')!.annotations.readOnlyHint, false);
  } finally { await f.cleanup(); }
});

test('game_launch schema validates instance names and switches', () => {
  assert.deepEqual(launch({ exe: 'Builds/Game.exe' }).args, []);
  assert.equal(launch({ exe: 'Builds/Game.exe' }).wait_ready, true);
  assert.deepEqual(launch({ exe: 'Builds/Game.exe', args: ['-windowed', '-w=1280', '-novsync', '-opt=a:b/c.d'] }).args, ['-windowed', '-w=1280', '-novsync', '-opt=a:b/c.d']);
  for (const bad of ['', '../x', 'a b', 'a/b', 'a\\b', '.', 'a.b', 'x'.repeat(65)]) {
    assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', instance: bad }).success, false, `instance ${JSON.stringify(bad)}`);
  }
  assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', instance: 'x'.repeat(64) }).success, true);
  for (const bad of ['windowed', '-', '--x', '-a b', '-x="q"', '-x=a b', '-x=y"', '-a-b', '-x=' + 'y'.repeat(257), '-mcpdir=C:/x', '-MCPDIR=x', '-mcpinstance=g9', '-McpInstance', '']) {
    assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', args: [bad] }).success, false, `arg ${JSON.stringify(bad)}`);
  }
  assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', args: Array.from({ length: 33 }, () => '-a') }).success, false);
  assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', args: Array.from({ length: 32 }, () => '-a') }).success, true);
  assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', timeout_ms: 120_001 }).success, false);
  assert.equal(GameLaunchSchema.safeParse({ exe: 'a.exe', unknown: true }).success, false);
  assert.equal(GameStopSchema.safeParse({}).success, false);
  assert.equal(GameStopSchema.safeParse({ instance: '../x' }).success, false);
  assert.equal(GameStopSchema.parse({ instance: 'g1' }).force, false);
  assert.equal(GameListInstancesSchema.safeParse({ x: 1 }).success, false);
});

test('game_launch is disabled without --allow-game-launch and starts nothing', async () => {
  const f = await fixture(false);
  const h = harness();
  try {
    const result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe' }), f.ctx, h.deps);
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.equal(envelope(result).error.details.hint, '--allow-game-launch');
    assert.equal(h.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('game_launch refuses an exe outside the project, a directory, a missing file and a non-exe', async () => {
  const f = await fixture();
  const h = harness();
  try {
    await fs.mkdir(path.join(f.root, 'Builds', 'Dir.exe'));
    await fs.writeFile(path.join(f.root, 'Builds', 'readme.txt'), 'x');
    const cases: Array<[string, string]> = [
      ['../outside/Evil.exe', 'INVALID_PATH'],
      [path.join(f.outside, 'Evil.exe'), 'INVALID_PATH'],
      ['Builds/../../outside/Evil.exe', 'INVALID_PATH'],
      ['Builds/Dir.exe', 'INVALID_PATH'],
      ['Builds/Missing.exe', 'NOT_FOUND'],
      ['.', 'INVALID_PATH'],
    ];
    if (process.platform === 'win32') cases.push(['Builds/readme.txt', 'INVALID_PATH']);
    for (const [exe, code] of cases) {
      const result = await handleGameLaunch(launch({ exe }), f.ctx, h.deps);
      assert.equal(result.isError, true, exe);
      assert.equal(envelope(result).error.code, code, exe);
    }
    assert.equal(h.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('game_launch refuses a symlink that leads outside the project', async () => {
  const f = await fixture();
  const h = harness();
  try {
    const link = path.join(f.root, 'Builds', 'Link.exe');
    try { await fs.symlink(path.join(f.outside, 'Evil.exe'), link, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    const result = await handleGameLaunch(launch({ exe: 'Builds/Link.exe' }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'INVALID_PATH');
    assert.equal(h.spawned.length, 0);
    await assert.rejects(resolveGameExecutable(f.ctx, 'Builds/Link.exe'));
  } finally { await f.cleanup(); }
});

test('game_launch spawns detached with only the fixed switches, records the pid, and waits for status', async () => {
  const f = await fixture();
  const h = harness();
  try {
    // A heartbeat/token left by a dead game must not be mistaken for the new one.
    const dir = path.join(f.root, 'Cache', 'MCP-Runtime', 'g1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bridge.json'), '{}');
    await fs.writeFile(path.join(dir, 'token'), 'stale');
    h.heartbeats.set('g1', poll => (poll < 3 ? MISSING('g1') : status('g1', 4321, true)));

    const result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'g1', args: ['-windowed', '-w=1280'] }), f.ctx, h.deps);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal(h.spawned.length, 1);
    const spawned = h.spawned[0]!;
    assert.equal(spawned.file, await fs.realpath(f.exe));
    assert.deepEqual(spawned.args, [`-mcpdir=${path.join(f.root, 'Cache', 'MCP-Runtime', 'g1')}`, '-mcpinstance=g1', '-windowed', '-w=1280']);
    assert.equal(spawned.options.detached, true);
    assert.equal(spawned.options.stdio, 'ignore');
    assert.equal(spawned.child.unrefCalled, true);
    assert.ok(h.state.pids.has(4321));
    assert.equal(h.state.instances.get('g1'), 4321);
    await assert.rejects(fs.access(path.join(dir, 'bridge.json')));
    await assert.rejects(fs.access(path.join(dir, 'token')));
    assert.deepEqual(h.calls.map(call => call.method), ['status']);

    const data = envelope(result).data;
    assert.equal(envelope(result).mode, 'game-connected');
    assert.equal(data.ready, true);
    assert.equal(data.instance, 'g1');
    assert.equal(data.pid, 4321);
    assert.equal(data.exe, 'Builds/Game.exe');
    assert.equal(data.bridge_version, '35');
    assert.equal(data.frame_count, 12);
    assert.deepEqual(envelope(result).changes, [{ kind: 'game-launch', instance: 'g1', pid: 4321 }]);
    assert.ok(!JSON.stringify(result).includes(f.root), 'no absolute path may reach the client');
  } finally { await f.cleanup(); }
});

test('two launches get distinct default names, even while the first is still starting', async () => {
  const f = await fixture();
  const h = harness();
  try {
    const first = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', wait_ready: false }), f.ctx, h.deps);
    const second = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', wait_ready: false }), f.ctx, h.deps);
    assert.equal(envelope(first).data.instance, 'g1');
    assert.equal(envelope(second).data.instance, 'g2');
    assert.equal(envelope(first).data.ready, false);
    assert.match(h.spawned[1]!.args[1]!, /^-mcpinstance=g2$/);
    assert.deepEqual([...h.state.pids].sort(), [4321, 4322]);
    // The same explicit name is refused while its process is still running.
    const again = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'g1', wait_ready: false }), f.ctx, h.deps);
    assert.equal(envelope(again).error.code, 'EDITOR_BUSY');
    assert.equal(h.spawned.length, 2);
  } finally { await f.cleanup(); }
});

test('game_launch refuses an instance that already has a live heartbeat', async () => {
  const f = await fixture();
  const h = harness();
  try {
    h.heartbeats.set('live', () => status('live', 777, true));
    const result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'live' }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'EDITOR_BUSY');
    assert.match(envelope(result).error.message, /already has a live bridge heartbeat/);
    assert.equal(h.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('game_launch reports a game that exits early, a start failure, and a readiness timeout', async () => {
  const f = await fixture();
  try {
    const exits = harness({ exitAfterSpawn: 3 });
    let result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'e1' }), f.ctx, exits.deps);
    assert.equal(envelope(result).error.code, 'GAME_NOT_CONNECTED');
    assert.match(envelope(result).error.message, /exited \(code 3\)/);
    assert.equal(exits.state.pids.size, 0, 'a process seen to exit leaves the launched set');

    const broken = harness({ spawnError: new Error('spawn EACCES') });
    result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'e2' }), f.ctx, broken.deps);
    assert.equal(envelope(result).error.code, 'INTERNAL_ERROR');
    assert.equal(broken.state.pids.size, 0);

    const slow = harness();
    result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'e3', timeout_ms: 1_000 }), f.ctx, slow.deps);
    assert.equal(envelope(result).error.code, 'TIMEOUT');
    assert.equal(envelope(result).error.details.pid, 4321);
    assert.equal(envelope(result).error.details.ready, false);
    assert.ok(slow.state.pids.has(4321), 'a game that is merely slow stays in the launched set');

    const old = harness({ callError: new BridgeRpcError('BRIDGE_UNSUPPORTED', 'too old') });
    old.heartbeats.set('e4', poll => (poll < 1 ? MISSING('e4') : status('e4', 4321, true, { bridgeVersion: '34' })));
    result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'e4' }), f.ctx, old.deps);
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await f.cleanup(); }
});

test('game_launch keeps polling while the bridge heartbeat is live but status is not answering yet', async () => {
  const f = await fixture();
  const h = harness();
  try {
    let attempts = 0;
    const call = h.deps.call;
    h.deps.call = async (...args) => {
      if (++attempts < 3) throw new BridgeRpcError('BRIDGE_TIMEOUT', 'not yet');
      return call(...args);
    };
    h.heartbeats.set('g1', poll => (poll < 1 ? MISSING('g1') : status('g1', 4321, true)));
    const result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'g1' }), f.ctx, h.deps);
    assert.equal(result.isError, undefined);
    assert.equal(attempts, 3);
  } finally { await f.cleanup(); }
});

test('game_launch waits for the first scene to load, then warns when none ever does', async () => {
  const f = await fixture();
  try {
    const h = harness();
    let attempts = 0;
    const call = h.deps.call;
    h.deps.call = async (...args) => {
      if (args[2] !== 'status') return call(...args);
      return { data: { FrameCount: 2, LoadedSceneCount: ++attempts < 4 ? 0 : 1 }, mode: 'game-connected', bridge: {} as never, warnings: [] };
    };
    h.heartbeats.set('g1', poll => (poll < 1 ? MISSING('g1') : status('g1', 4321, true)));
    const result = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'g1' }), f.ctx, h.deps);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal(attempts, 4);
    assert.equal(envelope(result).data.loaded_scene_count, 1);
    assert.deepEqual(envelope(result).warnings, []);

    const none = harness();
    none.deps.call = async () => ({ data: { FrameCount: 2, LoadedSceneCount: 0 }, mode: 'game-connected', bridge: {} as never, warnings: [] });
    none.heartbeats.set('g2', poll => (poll < 1 ? MISSING('g2') : status('g2', 4321, true)));
    const empty = await handleGameLaunch(launch({ exe: 'Builds/Game.exe', instance: 'g2' }), f.ctx, none.deps);
    assert.equal(empty.isError, undefined, JSON.stringify(empty.structuredContent));
    assert.equal(envelope(empty).data.loaded_scene_count, 0);
    assert.match(String(envelope(empty).warnings[0]), /No scene was loaded yet/);
  } finally { await f.cleanup(); }
});

test('game_list_instances scans heartbeats, classifies them, and never prints a path', async () => {
  const f = await fixture();
  const h = harness();
  try {
    const now = Date.now();
    const write = async (name: string, body: Record<string, unknown> | null) => {
      const dir = path.join(f.root, 'Cache', 'MCP-Runtime', name);
      await fs.mkdir(dir, { recursive: true });
      if (body) await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify(body));
    };
    const base = { BridgeVersion: 35, ProtocolVersion: 1, Kind: 'game', Pid: process.pid, ProductName: 'Fixture', EngineVersion: '1.12.6912', Timestamp: now };
    await write('live', { ...base, Instance: 'live' });
    await write('stale', { ...base, Instance: 'stale', Timestamp: now - 60_000 });
    await write('dead', { ...base, Instance: 'dead', Pid: 2_000_000_000 });
    await write('editor', { ...base, Instance: 'editor', Kind: 'editor' });
    await write('renamed', { ...base, Instance: 'someone-else' });
    await write('empty', null);
    await write('bad name', { ...base });
    h.state.pids.add(process.pid);
    h.deps.list = ctx => listRuntimeBridges(ctx, now);

    const result = await handleGameListInstances({}, f.ctx, h.deps);
    assert.equal(result.isError, undefined);
    const data = envelope(result).data as { instances: Array<Record<string, any>>; live_count: number; launch_enabled: boolean };
    const byName = Object.fromEntries(data.instances.map(entry => [entry.instance, entry]));
    assert.deepEqual(Object.keys(byName).sort(), ['dead', 'editor', 'live', 'renamed', 'stale']);
    assert.equal(byName.live.state, 'live');
    assert.equal(byName.live.reason, 'connected');
    assert.equal(byName.live.pid, process.pid);
    assert.equal(byName.live.bridge_version, '35');
    assert.equal(byName.live.product_name, 'Fixture');
    assert.equal(byName.live.launched_by_this_server, true);
    assert.equal(byName.stale.state, 'stale');
    assert.equal(byName.stale.reason, 'heartbeat_stale');
    assert.equal(byName.dead.reason, 'process_not_running');
    assert.equal(byName.editor.reason, 'wrong_kind');
    assert.equal(byName.renamed.reason, 'instance_mismatch');
    assert.equal(data.live_count, 1);
    assert.equal(data.launch_enabled, true);
    assert.ok(!JSON.stringify(result).includes(f.root));
    assert.ok(!JSON.stringify(result).includes(path.basename(path.dirname(f.root))), 'not even the temp folder name');

    h.state.pids.clear();
    const again = await handleGameListInstances({}, f.ctx, h.deps);
    assert.equal((envelope(again).data.instances as Array<Record<string, any>>).find(entry => entry.instance === 'live')!.launched_by_this_server, false);
  } finally { await f.cleanup(); }
});

test('game_list_instances is empty without a runtime cache directory', async () => {
  const f = await fixture();
  try {
    const result = await handleGameListInstances({}, f.ctx, { ...harness().deps, list: ctx => listRuntimeBridges(ctx) });
    assert.deepEqual(envelope(result).data.instances, []);
  } finally { await f.cleanup(); }
});

test('game_stop sends game.quit and waits for the process to exit', async () => {
  const f = await fixture();
  const h = harness();
  try {
    h.alive.add(500);
    h.state.pids.add(500);
    h.heartbeats.set('g1', () => status('g1', 500, true));
    let sleeps = 0;
    const sleep = h.deps.sleep;
    h.deps.sleep = async ms => { if (++sleeps === 3) h.alive.delete(500); await sleep(ms); };
    const result = await handleGameStop(GameStopSchema.parse({ instance: 'g1' }), f.ctx, h.deps);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.deepEqual(h.calls, [{ instance: 'g1', method: 'game.quit', params: {} }]);
    const data = envelope(result).data;
    assert.equal(data.exited, true);
    assert.equal(data.forced, false);
    assert.equal(data.accepted, true);
    assert.equal(data.pid, 500);
    assert.deepEqual(h.killed, []);
    assert.equal(h.state.pids.has(500), false);
    assert.equal(envelope(result).mode, 'game-connected');
  } finally { await f.cleanup(); }
});

test('game_stop without force never kills, even a game this server launched', async () => {
  const f = await fixture();
  const h = harness();
  try {
    h.alive.add(500);
    h.state.pids.add(500);
    h.heartbeats.set('g1', () => status('g1', 500, true));
    const result = await handleGameStop(GameStopSchema.parse({ instance: 'g1', timeout_ms: 600 }), f.ctx, h.deps);
    assert.equal(result.isError, undefined);
    assert.equal(envelope(result).data.exited, false);
    assert.equal(envelope(result).data.forced, false);
    assert.match(envelope(result).warnings.join(' '), /still running after 600 ms/);
    assert.deepEqual(h.killed, []);
    assert.ok(h.alive.has(500));
  } finally { await f.cleanup(); }
});

test('game_stop force is refused for a pid this server did not launch and does nothing', async () => {
  const f = await fixture();
  const h = harness();
  try {
    h.alive.add(900);
    h.heartbeats.set('foreign', () => status('foreign', 900, true));
    h.state.pids.add(901); // a different launched pid must not unlock pid 900
    const result = await handleGameStop(GameStopSchema.parse({ instance: 'foreign', force: true }), f.ctx, h.deps);
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'PERMISSION_DENIED');
    assert.deepEqual(h.calls, [], 'a refused force must not even send game.quit');
    assert.deepEqual(h.killed, []);
    assert.ok(h.alive.has(900));
  } finally { await f.cleanup(); }
});

test('game_stop force kills only the launched pid when the graceful quit does not finish', async () => {
  const f = await fixture();
  const h = harness();
  try {
    h.alive.add(500);
    h.alive.add(501);
    h.state.pids.add(500);
    h.heartbeats.set('g1', () => status('g1', 500, true));
    const result = await handleGameStop(GameStopSchema.parse({ instance: 'g1', force: true, timeout_ms: 400 }), f.ctx, h.deps);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.deepEqual(h.calls.map(call => call.method), ['game.quit']);
    assert.deepEqual(h.killed, [500]);
    assert.equal(envelope(result).data.forced, true);
    assert.equal(envelope(result).data.exited, true);
    assert.ok(h.alive.has(501), 'an unrelated process is untouched');
    assert.equal(h.state.pids.has(500), false);
  } finally { await f.cleanup(); }
});

test('game_stop force still works when game.quit fails but needs the pid to be launched here', async () => {
  const f = await fixture();
  const h = harness({ callError: new BridgeRpcError('BRIDGE_TIMEOUT', 'game frozen') });
  try {
    h.alive.add(500);
    h.state.pids.add(500);
    h.heartbeats.set('g1', () => status('g1', 500, true));
    const withoutForce = await handleGameStop(GameStopSchema.parse({ instance: 'g1' }), f.ctx, h.deps);
    assert.equal(envelope(withoutForce).error.code, 'TIMEOUT');
    assert.deepEqual(h.killed, []);
    const forced = await handleGameStop(GameStopSchema.parse({ instance: 'g1', force: true, timeout_ms: 400 }), f.ctx, h.deps);
    assert.equal(forced.isError, undefined);
    assert.deepEqual(h.killed, [500]);
    assert.match(envelope(forced).warnings.join(' '), /game\.quit failed/);
  } finally { await f.cleanup(); }
});

test('game_stop reports an instance that is not running as GAME_NOT_CONNECTED', async () => {
  const f = await fixture();
  const h = harness();
  try {
    let result = await handleGameStop(GameStopSchema.parse({ instance: 'nobody' }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'GAME_NOT_CONNECTED');

    h.heartbeats.set('dead', () => status('dead', 600, false, { reason: 'process_not_running' }));
    result = await handleGameStop(GameStopSchema.parse({ instance: 'dead' }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'GAME_NOT_CONNECTED');

    // A hung game: stale heartbeat, process alive. Plain stop explains; force works only for a launched pid.
    h.alive.add(700);
    h.heartbeats.set('hung', () => status('hung', 700, false));
    result = await handleGameStop(GameStopSchema.parse({ instance: 'hung' }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'GAME_NOT_CONNECTED');
    assert.match(envelope(result).error.message, /may be hung/);
    result = await handleGameStop(GameStopSchema.parse({ instance: 'hung', force: true }), f.ctx, h.deps);
    assert.equal(envelope(result).error.code, 'PERMISSION_DENIED');
    h.state.pids.add(700);
    result = await handleGameStop(GameStopSchema.parse({ instance: 'hung', force: true, timeout_ms: 400 }), f.ctx, h.deps);
    assert.equal(result.isError, undefined);
    assert.deepEqual(h.killed, [700]);
    assert.deepEqual(h.calls, [], 'no quit can be sent without a live bridge');
  } finally { await f.cleanup(); }
});

test('gameLaunchArguments puts the fixed switches first and the validated extras after', () => {
  assert.deepEqual(gameLaunchArguments('/p/Cache/MCP-Runtime/a', 'a', ['-x=1']), ['-mcpdir=/p/Cache/MCP-Runtime/a', '-mcpinstance=a', '-x=1']);
});

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake png body')]);

test('importGameCapture copies a game PNG into the capture cache and refuses anything else', async () => {
  const f = await fixture();
  try {
    const captures = path.join(f.root, 'Cache', 'MCP-Runtime', 'g1', 'captures');
    await fs.mkdir(captures, { recursive: true });
    await fs.writeFile(path.join(captures, 'cap1.png'), PNG);
    const imported = await importGameCapture(f.ctx, 'g1', 'cap1', 'captures/cap1.png');
    assert.match(imported.id, /^[0-9a-f]{32}$/);
    assert.equal(imported.size, PNG.length);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'Cache', 'MCP', 'captures', `${imported.id}.png`)), PNG);
    await assert.rejects(fs.access(path.join(captures, 'cap1.png')), 'the source is consumed');

    await fs.writeFile(path.join(captures, 'bad.png'), 'not a png at all');
    await assert.rejects(importGameCapture(f.ctx, 'g1', 'bad'), /not a valid PNG/);
    await fs.writeFile(path.join(captures, 'empty.png'), '');
    await assert.rejects(importGameCapture(f.ctx, 'g1', 'empty'), /empty or larger/);
    await assert.rejects(importGameCapture(f.ctx, 'g1', 'missing'), /not found/);
    // Only the base name of a reported path is used: traversal in the report cannot leave the captures folder.
    await fs.writeFile(path.join(f.root, 'secret.png'), PNG);
    await assert.rejects(importGameCapture(f.ctx, 'g1', 'x', '../../../../secret.png'), /not found/);
    await assert.rejects(importGameCapture(f.ctx, 'g1', 'bad id!'), /invalid capture file name/);
    await assert.rejects(importGameCapture(f.ctx, '../g1', 'cap1'), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_PROTOCOL_ERROR');
  } finally { await f.cleanup(); }
});
