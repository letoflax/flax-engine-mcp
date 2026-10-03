import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import {
  editorLaunchArguments,
  findProjectEditorPids,
  handleEditorLaunch,
  parseProcessList,
  resolveFlaxEditorPath,
  splitCommandLine,
  type EditorLaunchDeps,
} from './editorLaunch.js';
import { EditorLaunchSchema } from './editorLifecycle.js';
import type { EditorBridgeStatus } from './serverStatus.js';

const CONNECTED = (pid: number): EditorBridgeStatus => ({ connected: true, reason: 'connected', pid, heartbeatAgeMs: 10, editorVersion: '1.12.0', bridgeVersion: '34', protocolVersion: '1', endpoint: null });
const DISCONNECTED: EditorBridgeStatus = { connected: false, reason: 'heartbeat_missing', pid: null, heartbeatAgeMs: null, editorVersion: null, bridgeVersion: null, protocolVersion: null, endpoint: null };

interface Fixture { root: string; editor: string; ctx: ProjectMeta; cleanup(): Promise<void> }

async function fixture(withEditor = true): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-launch-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const editor = path.join(root, 'tools', 'FlaxEditor.exe');
  await fs.mkdir(path.dirname(editor), { recursive: true });
  await fs.writeFile(editor, '');
  const ctx = await createProjectContext(root);
  if (withEditor) ctx.flaxEditorPath = editor;
  return { root, editor, ctx, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

interface FakeChild extends EventEmitter { pid: number; unref(): void; unrefCalled: boolean }
interface Harness { deps: EditorLaunchDeps; spawned: Array<{ file: string; args: string[]; options: SpawnOptions; child: FakeChild }>; clock: { now: number } }

function harness(options: {
  inspect?: (call: number) => EditorBridgeStatus;
  processes?: () => Promise<Array<{ pid: number; commandLine: string }>>;
  spawnError?: Error;
  exitAfterSpawn?: number;
} = {}): Harness {
  const spawned: Harness['spawned'] = [];
  const clock = { now: 1_000_000 };
  let inspectCalls = 0;
  const deps: EditorLaunchDeps = {
    spawn: (file, args, spawnOptions) => {
      const child = Object.assign(new EventEmitter(), { pid: 4321, unrefCalled: false, unref() { this.unrefCalled = true; } }) as FakeChild;
      spawned.push({ file, args: [...args], options: spawnOptions, child });
      process.nextTick(() => {
        if (options.spawnError) child.emit('error', options.spawnError);
        else {
          child.emit('spawn');
          if (options.exitAfterSpawn !== undefined) setImmediate(() => child.emit('exit', options.exitAfterSpawn, null));
        }
      });
      return child as unknown as ChildProcess;
    },
    listProcesses: options.processes ?? (async () => []),
    inspectBridge: async () => (options.inspect ?? (() => DISCONNECTED))(inspectCalls++),
    sleep: async ms => { clock.now += ms; await new Promise(resolve => setImmediate(resolve)); },
    now: () => clock.now,
  };
  return { deps, spawned, clock };
}

const parse = (input: Record<string, unknown> = {}) => EditorLaunchSchema.parse(input);
const envelope = (result: Awaited<ReturnType<typeof handleEditorLaunch>>) => result.structuredContent as Record<string, any>;

test('--flax-editor accepts only an existing FlaxEditor.exe file', async () => {
  const f = await fixture();
  try {
    assert.equal(await resolveFlaxEditorPath(['node', 'server']), undefined);
    assert.equal(await resolveFlaxEditorPath(['node', 'server', '--flax-editor', f.editor]), f.editor);
    const lower = path.join(f.root, 'tools', 'flaxeditor.EXE');
    await fs.writeFile(lower, '');
    assert.equal(path.basename((await resolveFlaxEditorPath(['node', 'server', '--flax-editor', lower]))!).toLowerCase(), 'flaxeditor.exe');
    await assert.rejects(() => resolveFlaxEditorPath(['node', 'server', '--flax-editor']), /requires the path of FlaxEditor\.exe/);
    await assert.rejects(() => resolveFlaxEditorPath(['node', 'server', '--flax-editor', '--other']), /requires the path/);
    await assert.rejects(() => resolveFlaxEditorPath(['node', 'server', '--flax-editor', path.join(f.root, 'Other.exe')]), /must name FlaxEditor\.exe/);
    await assert.rejects(() => resolveFlaxEditorPath(['node', 'server', '--flax-editor', path.join(f.root, 'tools', 'Missing', 'FlaxEditor.exe')]), /existing FlaxEditor\.exe file/);
    const directory = path.join(f.root, 'dir', 'FlaxEditor.exe');
    await fs.mkdir(directory, { recursive: true });
    await assert.rejects(() => resolveFlaxEditorPath(['node', 'server', '--flax-editor', directory]), /existing FlaxEditor\.exe file/);
  } finally { await f.cleanup(); }
});

test('editor_launch without --flax-editor answers UNSUPPORTED_FLAX_VERSION naming the flag and starts nothing', async () => {
  const f = await fixture(false);
  try {
    const h = harness();
    const result = await handleEditorLaunch(parse(), f.ctx, h.deps);
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.match(envelope(result).error.message, /--flax-editor/);
    assert.equal(h.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('command lines are matched on -project in folder or .flaxproj spelling, quoted or not', () => {
  const project = path.resolve('D:/Games/My Project');
  const procs = [
    { pid: 1, commandLine: `"C:\\Flax\\FlaxEditor.exe" -project "${project}"` },
    { pid: 2, commandLine: `C:\\Flax\\FlaxEditor.exe -project ${path.resolve('D:/Games/Other')}` },
    { pid: 3, commandLine: `"C:\\Flax\\FlaxEditor.exe" -PROJECT "${path.join(project, 'My.flaxproj')}" -headless` },
    { pid: 4, commandLine: `"C:\\Tools\\notepad.exe" -project "${project}"` },
    { pid: 5, commandLine: `"C:\\Flax\\FlaxEditor.exe" -headless` },
    { pid: 6, commandLine: `"C:\\Flax\\FlaxEditor.exe" -project "${project}${path.sep}"` },
  ];
  assert.deepEqual(findProjectEditorPids(procs, project), [1, 3, 6]);
  assert.deepEqual(splitCommandLine('a "b c" \'d e\' f=g ""'), ['a', 'b c', 'd e', 'f=g', '']);
  assert.deepEqual(parseProcessList('  12 /opt/flax/FlaxEditor -project /g/p\n 7 bash\n\nbad line'), [
    { pid: 12, commandLine: '/opt/flax/FlaxEditor -project /g/p' },
    { pid: 7, commandLine: 'bash' },
  ]);
});

test('launch arguments are fixed: -project plus only -headless and -skipcompile', () => {
  assert.deepEqual(editorLaunchArguments('P', { headless: false, skip_compile: false }), ['-project', 'P']);
  assert.deepEqual(editorLaunchArguments('P', { headless: true, skip_compile: true }), ['-project', 'P', '-headless', '-skipcompile']);
  assert.equal(EditorLaunchSchema.safeParse({ args: ['-exit'] }).success, false);
});

test('editor_launch refuses a project with a live bridge heartbeat or a running -project editor', async () => {
  const f = await fixture();
  try {
    const live = harness({ inspect: () => CONNECTED(777) });
    const busy = await handleEditorLaunch(parse(), f.ctx, live.deps);
    assert.equal(envelope(busy).error.code, 'EDITOR_BUSY');
    assert.match(envelope(busy).error.message, /live bridge heartbeat/);
    assert.equal(live.spawned.length, 0);

    const running = harness({ processes: async () => [{ pid: 55, commandLine: `"${f.editor}" -project "${f.root}"` }] });
    const refused = await handleEditorLaunch(parse(), f.ctx, running.deps);
    assert.equal(envelope(refused).error.code, 'EDITOR_BUSY');
    assert.deepEqual(envelope(refused).error.details.pids, [55]);
    assert.equal(running.spawned.length, 0);

    // A different project's Editor does not block this one.
    const other = harness({ processes: async () => [{ pid: 56, commandLine: `"${f.editor}" -project "${path.join(f.root, 'elsewhere')}"` }] });
    assert.equal(envelope(await handleEditorLaunch(parse({ wait_ready: false }), f.ctx, other.deps)).ok, true);
  } finally { await f.cleanup(); }
});

test('editor_launch uses the real heartbeat check: a fresh bridge.json of a live pid blocks the launch', async () => {
  const f = await fixture();
  try {
    const cache = path.join(f.root, 'Cache', 'MCP');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: f.root, Timestamp: Date.now(), BridgeVersion: 34, ProtocolVersion: 1 }));
    const h = harness();
    const { inspectBridge: _skip, ...rest } = h.deps;
    const { inspectEditorBridge } = await import('./serverStatus.js');
    const result = await handleEditorLaunch(parse(), f.ctx, { ...rest, inspectBridge: ctx => inspectEditorBridge(ctx) });
    assert.equal(envelope(result).error.code, 'EDITOR_BUSY');
    assert.equal(h.spawned.length, 0);
  } finally { await f.cleanup(); }
});

test('editor_launch spawns detached with only the allowed switches and returns the pid', async () => {
  const f = await fixture();
  try {
    const h = harness();
    const result = await handleEditorLaunch(parse({ wait_ready: false }), f.ctx, h.deps);
    assert.equal(envelope(result).ok, true);
    assert.equal(envelope(result).data.pid, 4321);
    assert.equal(envelope(result).data.ready, false);
    assert.deepEqual(envelope(result).changes, [{ kind: 'editor-launch', pid: 4321 }]);
    assert.equal(h.spawned.length, 1);
    const call = h.spawned[0]!;
    assert.equal(call.file, f.editor);
    assert.deepEqual(call.args, ['-project', f.ctx.projectPath]);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(call.child.unrefCalled, true);

    const flagged = harness();
    await handleEditorLaunch(parse({ wait_ready: false, headless: true, skip_compile: true }), f.ctx, flagged.deps);
    assert.deepEqual(flagged.spawned[0]!.args, ['-project', f.ctx.projectPath, '-headless', '-skipcompile']);
  } finally { await f.cleanup(); }
});

test('editor_launch wait_ready polls the heartbeat until it is live and reports the bridge version', async () => {
  const f = await fixture();
  try {
    const h = harness({ inspect: call => (call < 4 ? DISCONNECTED : CONNECTED(4321)) });
    const result = await handleEditorLaunch(parse({ timeout_ms: 60_000 }), f.ctx, h.deps);
    assert.equal(envelope(result).ok, true);
    assert.equal(envelope(result).mode, 'editor-connected');
    assert.equal(envelope(result).data.ready, true);
    assert.equal(envelope(result).data.bridgeVersion, '34');
    assert.equal(envelope(result).data.pid, 4321);
    assert.ok(envelope(result).data.waitedMs >= 1000);
    assert.deepEqual(envelope(result).warnings, []);

    const mismatch = harness({ inspect: call => (call < 1 ? DISCONNECTED : CONNECTED(999)) });
    const other = await handleEditorLaunch(parse(), f.ctx, mismatch.deps);
    assert.match(envelope(other).warnings[0], /pid 999/);
  } finally { await f.cleanup(); }
});

test('editor_launch wait_ready times out without killing the Editor and reports an early exit', async () => {
  const f = await fixture();
  try {
    const slow = harness();
    const timedOut = await handleEditorLaunch(parse({ timeout_ms: 2_000 }), f.ctx, slow.deps);
    assert.equal(envelope(timedOut).error.code, 'TIMEOUT');
    assert.equal(envelope(timedOut).error.details.pid, 4321);
    assert.equal(envelope(timedOut).error.details.ready, false);
    assert.equal(slow.spawned[0]!.child.unrefCalled, true);

    const crashing = harness({ exitAfterSpawn: 3 });
    const exited = await handleEditorLaunch(parse({ timeout_ms: 60_000 }), f.ctx, crashing.deps);
    assert.equal(envelope(exited).error.code, 'EDITOR_NOT_CONNECTED');
    assert.match(envelope(exited).error.message, /exited/);
    assert.equal(envelope(exited).error.details.exitCode, 3);
  } finally { await f.cleanup(); }
});

test('editor_launch reports a spawn failure and tolerates an unavailable process listing', async () => {
  const f = await fixture();
  try {
    const failing = harness({ spawnError: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
    const failed = await handleEditorLaunch(parse({ wait_ready: false }), f.ctx, failing.deps);
    assert.equal(failed.isError, true);
    assert.match(envelope(failed).error.message, /could not be started/);

    const noPs = harness({ processes: async () => { throw new Error('powershell missing'); } });
    const result = await handleEditorLaunch(parse({ wait_ready: false }), f.ctx, noPs.deps);
    assert.equal(envelope(result).ok, true);
    assert.match(envelope(result).warnings.join(' '), /Could not list running FlaxEditor processes/);
    assert.equal(noPs.spawned.length, 1);
  } finally { await f.cleanup(); }
});
