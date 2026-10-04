import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { toolFamily } from '../permissions.js';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { readFlaxResource } from '../resources.js';
import { handleLogGetRecent, handleLogGetRuntimeErrors, handleLogSearch, handlePerfGetSnapshot, handleRuntimeInspectActor, handleViewportCapture, LogGetRecentSchema, LogGetRuntimeErrorsSchema, LogSearchSchema, PerfGetSnapshotSchema, RuntimeInspectActorSchema, ViewportCaptureSchema } from '../tools/liveObservability.js';
import { handlePlaySetTimeScale, PlaySetTimeScaleSchema } from '../tools/runtimeLive.js';
import { handleRuntimeInvokeScriptMethod, handleRuntimeSetScriptValue, RuntimeInvokeScriptMethodSchema, RuntimeSetScriptValueSchema } from '../tools/runtimeScriptLive.js';
import { callRuntimeBridge, FileRpcClient } from './fileRpcClient.js';
import { BridgeRpcError, RUNTIME_BRIDGE_CACHE_DIRECTORY } from './protocol.js';
import {
  assertRuntimeInstanceName,
  inspectRuntimeBridge,
  isValidRuntimeInstanceName,
  runtimeInstanceDirectory,
  runtimeInstancesRoot,
} from './runtimeHeartbeat.js';

const TOKEN = 'runtime-token-abcdefghijklmnopqrstuvwxyz0123456789';
const SCRIPT_ID = 'a'.repeat(32);

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  instanceDir(instance: string): string;
  addInstance(instance: string, overrides?: Record<string, unknown>): Promise<string>;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-runtime-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'fixture-guid' }));
  const ctx = await createProjectContext(root);
  const instanceDir = (instance: string) => path.join(root, 'Cache', 'MCP-Runtime', instance);
  return {
    root,
    ctx,
    instanceDir,
    async addInstance(instance, overrides = {}) {
      const dir = instanceDir(instance);
      await fs.mkdir(path.join(dir, 'requests'), { recursive: true });
      await fs.mkdir(path.join(dir, 'responses'), { recursive: true });
      await fs.mkdir(path.join(dir, 'captures'), { recursive: true });
      await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify({
        BridgeVersion: 35, ProtocolVersion: 1, Kind: 'game', Pid: process.pid, Instance: instance,
        ProductName: 'Fixture', EngineVersion: '1.12.6912', Timestamp: Date.now(), ...overrides,
      }));
      await fs.writeFile(path.join(dir, 'token'), TOKEN);
      return dir;
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

interface SeenRequest { method: string; params: Record<string, any>; token: string }

/** A fake game: answers every request that appears in the instance directory. */
function fakeGame(dir: string, respond: (request: SeenRequest) => unknown | Promise<unknown>) {
  const seen: SeenRequest[] = [];
  let stopped = false;
  const loop = (async () => {
    const requests = path.join(dir, 'requests');
    while (!stopped) {
      let names: string[] = [];
      try { names = (await fs.readdir(requests)).filter(name => name.endsWith('.json')); } catch { /* directory removed */ }
      for (const name of names) {
        let body: Record<string, any>;
        try { body = JSON.parse(await fs.readFile(path.join(requests, name), 'utf8')) as Record<string, any>; } catch { continue; }
        await fs.rm(path.join(requests, name), { force: true });
        const request: SeenRequest = { method: body.method, params: JSON.parse(body.paramsJson), token: body.token };
        seen.push(request);
        let reply: Record<string, unknown>;
        try {
          const result = await respond(request);
          reply = { id: body.id, token: body.token, ok: true, resultJson: JSON.stringify(result) };
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          reply = { id: body.id, token: body.token, ok: false, errorCode: failure.code ?? 'INTERNAL_ERROR', error: failure.message ?? 'failed' };
        }
        const target = path.join(dir, 'responses', `${body.id}.json`);
        await fs.writeFile(`${target}.tmp`, JSON.stringify(reply));
        await fs.rename(`${target}.tmp`, target);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  return { seen, stop: async () => { stopped = true; await loop; } };
}

const envelope = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;

test('instance directories resolve under Cache/MCP-Runtime and validate the name', async () => {
  const f = await fixture();
  try {
    assert.equal(RUNTIME_BRIDGE_CACHE_DIRECTORY, 'Cache/MCP-Runtime');
    assert.equal(runtimeInstancesRoot(f.ctx), path.join(f.root, 'Cache', 'MCP-Runtime'));
    assert.equal(runtimeInstanceDirectory(f.ctx, 'g1'), path.join(f.root, 'Cache', 'MCP-Runtime', 'g1'));
    assert.equal(runtimeInstanceDirectory(f.ctx, 'A_b-9'), path.join(f.root, 'Cache', 'MCP-Runtime', 'A_b-9'));
    assert.equal(isValidRuntimeInstanceName('x'.repeat(64)), true);
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a b', 'a.b', 'x'.repeat(65), 'g1\n', 'é', '/abs', 'C:x', '..\\..\\Windows']) {
      assert.equal(isValidRuntimeInstanceName(bad), false, JSON.stringify(bad));
      assert.throws(() => assertRuntimeInstanceName(bad), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_PROTOCOL_ERROR');
      assert.throws(() => runtimeInstanceDirectory(f.ctx, bad), BridgeRpcError);
      assert.throws(() => new FileRpcClient(f.ctx, { runtimeInstance: bad }), BridgeRpcError);
    }
    assert.equal(isValidRuntimeInstanceName(42), false);
    await assert.rejects(callRuntimeBridge(f.ctx, '../../Cache/MCP', 'status', {}), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_PROTOCOL_ERROR');
    await assert.rejects(fs.access(path.join(f.root, 'Cache')), 'a rejected name creates nothing');
  } finally { await f.cleanup(); }
});

test('callRuntimeBridge writes the request into the instance directory only and returns the game result', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const game = fakeGame(dir, request => ({ echoed: request.method, frames: 7 }));
  try {
    const call = await callRuntimeBridge<'status', Record<string, unknown>, { echoed: string; frames: number }>(f.ctx, 'g1', 'status', { a: 1 }, { deadlineMs: 2_000, pollIntervalMs: 5 });
    assert.deepEqual(call.data, { echoed: 'status', frames: 7 });
    assert.equal(call.mode, 'game-connected');
    assert.equal(call.bridge.pid, process.pid);
    assert.equal(call.bridge.bridgeVersion, '35');
    assert.equal(call.bridge.protocolVersion, '1');
    assert.equal(call.bridge.editorVersion, '1.12.6912', 'engine version of the game');
    assert.deepEqual(game.seen.map(request => request.method), ['status']);
    assert.deepEqual(game.seen[0]!.params, { a: 1 });
    assert.equal(game.seen[0]!.token, TOKEN);
    await assert.rejects(fs.access(path.join(f.root, 'Cache', 'MCP')), 'the editor bridge directory is never touched');
    assert.deepEqual(await fs.readdir(path.join(dir, 'requests')), []);
    assert.deepEqual(await fs.readdir(path.join(dir, 'responses')), []);
  } finally { await game.stop(); await f.cleanup(); }
});

test('Kind game heartbeat validation: pid alive, fresh timestamp, game kind, instance name, bridge 35+, protocol 1', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.addInstance('ok');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'ok', now + 100)).connected, true);
    assert.equal((await inspectRuntimeBridge(f.ctx, 'ok', now + 30_000 - 1_000)).reason, 'connected');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'ok', now + 31_000)).reason, 'heartbeat_stale');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'ok', now, () => false)).reason, 'process_not_running');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'ok', now - 60_000)).reason, 'heartbeat_invalid', 'a heartbeat from the future');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'nothing')).reason, 'heartbeat_missing');

    await f.addInstance('editor', { Kind: 'editor' });
    assert.equal((await inspectRuntimeBridge(f.ctx, 'editor')).reason, 'wrong_kind');
    await f.addInstance('nokind', { Kind: undefined });
    assert.equal((await inspectRuntimeBridge(f.ctx, 'nokind')).reason, 'wrong_kind');
    await f.addInstance('renamed', { Instance: 'other' });
    assert.equal((await inspectRuntimeBridge(f.ctx, 'renamed')).reason, 'instance_mismatch');
    await f.addInstance('nopid', { Pid: 0 });
    assert.equal((await inspectRuntimeBridge(f.ctx, 'nopid')).reason, 'heartbeat_invalid');
    await fs.writeFile(path.join(f.instanceDir('nopid'), 'bridge.json'), '{ not json');
    assert.equal((await inspectRuntimeBridge(f.ctx, 'nopid')).reason, 'heartbeat_invalid');

    // The RPC client turns each of those into BRIDGE_UNAVAILABLE and never writes a request.
    for (const name of ['editor', 'nokind', 'renamed', 'nopid', 'nothing']) {
      await assert.rejects(
        callRuntimeBridge(f.ctx, name, 'status', {}, { deadlineMs: 100 }),
        (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_UNAVAILABLE' && /is not running or its bridge is unavailable/.test(error.message),
        name,
      );
    }
    await f.addInstance('stale', { Timestamp: now - 31_000 });
    await assert.rejects(callRuntimeBridge(f.ctx, 'stale', 'status', {}, { deadlineMs: 100 }), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_UNAVAILABLE');
    assert.deepEqual(await fs.readdir(path.join(f.instanceDir('stale'), 'requests')), []);

    await f.addInstance('old', { BridgeVersion: 34 });
    await assert.rejects(callRuntimeBridge(f.ctx, 'old', 'status', {}, { deadlineMs: 100 }), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_UNSUPPORTED');
    await f.addInstance('proto2', { ProtocolVersion: 2 });
    await assert.rejects(callRuntimeBridge(f.ctx, 'proto2', 'status', {}, { deadlineMs: 100 }), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_UNSUPPORTED');
    assert.deepEqual(await fs.readdir(path.join(f.instanceDir('old'), 'requests')), []);
  } finally { await f.cleanup(); }
});

test('calls to different instances run in parallel; a second call to the same instance is refused while one is in flight', async () => {
  const f = await fixture();
  const a = await f.addInstance('a');
  const b = await f.addInstance('b');
  const release: Array<() => void> = [];
  const gameA = fakeGame(a, () => new Promise(resolve => { release.push(() => resolve({ who: 'a' })); }));
  const gameB = fakeGame(b, () => ({ who: 'b' }));
  try {
    const first = callRuntimeBridge(f.ctx, 'a', 'status', {}, { deadlineMs: 3_000, pollIntervalMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await assert.rejects(callRuntimeBridge(f.ctx, 'a', 'status', {}, { deadlineMs: 500 }), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_CONCURRENT_CALL' && /game instance "a"/.test(error.message));
    const other = await callRuntimeBridge(f.ctx, 'b', 'status', {}, { deadlineMs: 2_000, pollIntervalMs: 5 });
    assert.deepEqual(other.data, { who: 'b' });
    release.forEach(fn => fn());
    assert.deepEqual((await first).data, { who: 'a' });
  } finally { release.forEach(fn => fn()); await gameA.stop(); await gameB.stop(); await f.cleanup(); }
});

test('a response signed with another token is rejected', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  let stopped = false;
  const rogue = (async () => {
    while (!stopped) {
      for (const name of (await fs.readdir(path.join(dir, 'requests')).catch(() => [])).filter(value => value.endsWith('.json'))) {
        const body = JSON.parse(await fs.readFile(path.join(dir, 'requests', name), 'utf8')) as { id: string };
        await fs.writeFile(path.join(dir, 'responses', `${body.id}.json`), JSON.stringify({ id: body.id, token: 'someone-elses-token-0123456789', ok: true, resultJson: '{}' }));
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  try {
    await assert.rejects(callRuntimeBridge(f.ctx, 'g1', 'status', {}, { deadlineMs: 1_000, pollIntervalMs: 5 }), (error: unknown) => error instanceof BridgeRpcError && error.code === 'BRIDGE_AUTH_FAILED' && /game instance/.test(error.message));
  } finally { stopped = true; await rogue; await f.cleanup(); }
});

test('runtime_invoke_script_method and runtime_set_script_value route to the instance with the editor DTOs', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const game = fakeGame(dir, request => request.method === 'runtime.invoke_script_method'
    ? { Returned: { Text: '3' }, Threw: false }
    : { Member: 'Speed', Changed: true, Warnings: ['clamped'] });
  try {
    const invoke = await handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT_ID, method: 'Add', args: [1, 'two', true], instance: 'g1' }), f.ctx);
    assert.equal(invoke.isError, undefined, JSON.stringify(invoke.structuredContent));
    assert.equal(envelope(invoke).mode, 'game-connected');
    assert.deepEqual(game.seen[0], {
      method: 'runtime.invoke_script_method',
      params: { ScriptId: SCRIPT_ID, Method: 'Add', Args: [{ Number: 1 }, { Text: 'two' }, { Bool: true }] },
      token: TOKEN,
    });
    assert.equal(envelope(invoke).data.result.Threw, false);
    assert.deepEqual(envelope(invoke).changes, [{ kind: 'runtime.script_method_invoked', id: SCRIPT_ID, method: 'Add' }]);

    const set = await handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT_ID, member: 'Speed', value: 4.5, instance: 'g1' }), f.ctx);
    assert.equal(set.isError, undefined);
    assert.deepEqual(game.seen[1]!.params, { ScriptId: SCRIPT_ID, Member: 'Speed', Number: 4.5 });
    assert.deepEqual(envelope(set).warnings, ['clamped']);

    const nested = await handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT_ID, path: ['Config', 'Rate'], value: 'fast', instance: 'g1' }), f.ctx);
    assert.equal(nested.isError, undefined);
    assert.deepEqual(game.seen[2]!.params, { ScriptId: SCRIPT_ID, Path: ['Config', 'Rate'], Text: 'fast' });
    await assert.rejects(fs.access(path.join(f.root, 'Cache', 'MCP')), 'no editor bridge call was made');
  } finally { await game.stop(); await f.cleanup(); }
});

test('an instance that is not running is GAME_NOT_CONNECTED; without instance the editor path and its error are unchanged', async () => {
  const f = await fixture();
  try {
    const gone = await handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT_ID, method: 'Go', instance: 'ghost' }), f.ctx);
    assert.equal(gone.isError, true);
    assert.equal(envelope(gone).error.code, 'GAME_NOT_CONNECTED');
    assert.match(envelope(gone).error.message, /Game instance "ghost" is not running/);

    const editor = await handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT_ID, method: 'Go' }), f.ctx);
    assert.equal(envelope(editor).error.code, 'EDITOR_NOT_CONNECTED');
    const editorLogs = await handleLogGetRecent(LogGetRecentSchema.parse({}), f.ctx);
    assert.equal(envelope(editorLogs).error.code, 'EDITOR_NOT_CONNECTED');
    const gameLogs = await handleLogGetRecent(LogGetRecentSchema.parse({ instance: 'ghost' }), f.ctx);
    assert.equal(envelope(gameLogs).error.code, 'GAME_NOT_CONNECTED');
  } finally { await f.cleanup(); }
});

test('log_search, log_get_recent and log_get_runtime_errors read the game log ring through log.query', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const entries = [
    { Sequence: 1, Level: 'Info', Message: 'booted' },
    { Sequence: 2, Level: 'Error', Message: 'NullReferenceException in Spawner at ' + path.join(f.root, 'Source', 'Spawner.cs') },
    { Sequence: 3, Level: 'Info', Message: 'wave 2 started' },
  ];
  const game = fakeGame(dir, request => {
    const since = Number(request.params.SinceSequence ?? 0);
    const contains = typeof request.params.Contains === 'string' ? request.params.Contains.toLowerCase() : null;
    const matching = entries.filter(entry => entry.Sequence >= since && (!contains || entry.Message.toLowerCase().includes(contains)));
    return { Entries: matching, NextSequence: matching.length ? matching[matching.length - 1]!.Sequence + 1 : since, HasMore: false, DroppedCount: 0 };
  });
  try {
    const search = await handleLogSearch(LogSearchSchema.parse({ query: 'wave', instance: 'g1' }), f.ctx);
    assert.equal(search.isError, undefined, JSON.stringify(search.structuredContent));
    assert.equal(envelope(search).mode, 'game-connected');
    assert.deepEqual(envelope(search).data.entries.map((entry: any) => entry.Sequence), [3]);
    assert.equal(game.seen[0]!.method, 'log.query');
    assert.equal(game.seen[0]!.params.Contains, 'wave');
    assert.equal('PlaySessionId' in game.seen[0]!.params, false);

    const recent = await handleLogGetRecent(LogGetRecentSchema.parse({ instance: 'g1', limit: 10 }), f.ctx);
    assert.equal(envelope(recent).data.entries.length, 3);
    assert.equal(game.seen[1]!.params.Tail, true);
    const raw = JSON.stringify(envelope(recent));
    assert.ok(!raw.includes(f.root), 'host paths inside log text stay redacted');

    const errors = await handleLogGetRuntimeErrors(LogGetRuntimeErrorsSchema.parse({ instance: 'g1' }), f.ctx);
    assert.deepEqual(envelope(errors).data.errors.map((entry: any) => entry.Sequence), [2]);

    const session = await handleLogSearch(LogSearchSchema.parse({ query: 'x', instance: 'g1', play_session_id: 'abc' }), f.ctx);
    assert.equal(envelope(session).error.code, 'INVALID_ARGUMENT');
    assert.equal(game.seen.length, 3 + 0, 'the refused call sent nothing');
    await assert.rejects(fs.access(path.join(f.root, 'Cache', 'MCP')));
  } finally { await game.stop(); await f.cleanup(); }
});

test('runtime_inspect_actor, perf_get_snapshot and play_set_time_scale route to the instance', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const game = fakeGame(dir, request => {
    if (request.method === 'runtime.inspect_actor') return { Id: request.params.ActorId, Name: 'Player', Scripts: [] };
    if (request.method === 'perf.snapshot') return { Fps: 59, FrameTimeMs: 16.5, ManagedMemoryBytes: 1024, ActorCount: 12, IsPlayMode: false, TimestampUnixMs: 1, Secret: path.join(f.root, 'x') };
    return { TimeScale: request.params.TimeScale };
  });
  try {
    const inspect = await handleRuntimeInspectActor(RuntimeInspectActorSchema.parse({ actor_id: 'b'.repeat(32), depth: 2, instance: 'g1' }), f.ctx);
    assert.equal(inspect.isError, undefined);
    assert.equal(envelope(inspect).data.actor.Name, 'Player');
    assert.deepEqual(game.seen[0]!.params, { ActorId: 'b'.repeat(32), Depth: 2, IncludeScripts: true });

    const perf = await handlePerfGetSnapshot(PerfGetSnapshotSchema.parse({ instance: 'g1' }), f.ctx);
    assert.equal(envelope(perf).data.snapshot.fps, 59);
    assert.equal(envelope(perf).data.snapshot.actor_count, 12);
    assert.equal('Secret' in envelope(perf).data.snapshot, false);

    const scale = await handlePlaySetTimeScale(PlaySetTimeScaleSchema.parse({ time_scale: 0.5, instance: 'g1' }), f.ctx);
    assert.equal(scale.isError, undefined);
    assert.equal(envelope(scale).data.time_scale, 0.5);
    assert.equal(envelope(scale).data.instance, 'g1');
    assert.equal(envelope(scale).mode, 'game-connected');
    assert.deepEqual(game.seen.map(request => request.method), ['runtime.inspect_actor', 'perf.snapshot', 'play.set_time_scale']);
    assert.deepEqual(game.seen[2]!.params, { TimeScale: 0.5 });
    await assert.rejects(fs.access(path.join(f.root, 'Cache', 'MCP')));
  } finally { await game.stop(); await f.cleanup(); }
});

test('remote game errors map like editor bridge errors', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const game = fakeGame(dir, () => { throw Object.assign(new Error('Script not found'), { code: 'NOT_FOUND' }); });
  try {
    const result = await handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT_ID, method: 'Go', instance: 'g1' }), f.ctx);
    assert.equal(envelope(result).error.code, 'NOT_FOUND');
  } finally { await game.stop(); await f.cleanup(); }
});

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('game frame')]);

test('viewport_capture with instance captures from the game and serves it through flax://capture', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  let statusCalls = 0;
  const game = fakeGame(dir, async request => {
    if (request.method === 'capture.start') return { CaptureId: 'shot1', Viewport: 'game' };
    statusCalls += 1;
    if (statusCalls < 2) return { Phase: 'running' };
    await fs.writeFile(path.join(dir, 'captures', 'shot1.png'), PNG);
    return { Phase: 'completed', SizeBytes: PNG.length, Path: 'captures/shot1.png', StartedUnixMs: 1, CompletedUnixMs: 2 };
  });
  try {
    const result = await handleViewportCapture(ViewportCaptureSchema.parse({ viewport: 'game', instance: 'g1', poll_interval_ms: 50 }), f.ctx);
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const data = envelope(result).data;
    assert.equal(envelope(result).mode, 'game-connected');
    assert.match(data.capture_id, /^[0-9a-f]{32}$/);
    assert.equal(data.uri, `flax://capture/${data.capture_id}`);
    assert.equal(data.instance, 'g1');
    assert.equal(data.size_bytes, PNG.length);
    assert.deepEqual(game.seen.map(request => request.method), ['capture.start', 'capture.status', 'capture.status']);
    assert.deepEqual(game.seen[0]!.params, { Viewport: 'game' });
    assert.deepEqual(game.seen[1]!.params, { CaptureId: 'shot1' });
    assert.ok(!JSON.stringify(result).includes(f.root));

    const resource = await readFlaxResource(data.uri, f.ctx);
    assert.equal(resource.contents[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(resource.contents[0].blob, 'base64'), PNG);
  } finally { await game.stop(); await f.cleanup(); }
});

test('viewport_capture with instance accepts only the game viewport and reports capture failures', async () => {
  const f = await fixture();
  const dir = await f.addInstance('g1');
  const game = fakeGame(dir, request => request.method === 'capture.start'
    ? { CaptureId: 'shot2' }
    : { Phase: 'failed', Error: 'Screenshot.Capture returned false' });
  try {
    const editor = await handleViewportCapture(ViewportCaptureSchema.parse({ viewport: 'editor', instance: 'g1' }), f.ctx);
    assert.equal(envelope(editor).error.code, 'INVALID_ARGUMENT');
    assert.equal(game.seen.length, 0);

    const failed = await handleViewportCapture(ViewportCaptureSchema.parse({ instance: 'g1' }), f.ctx);
    assert.equal(envelope(failed).error.code, 'CAPTURE_UNAVAILABLE');
    assert.match(envelope(failed).error.message, /Screenshot\.Capture/);

    const ghost = await handleViewportCapture(ViewportCaptureSchema.parse({ instance: 'ghost' }), f.ctx);
    assert.equal(envelope(ghost).error.code, 'GAME_NOT_CONNECTED');
  } finally { await game.stop(); await f.cleanup(); }
});

test('the tools that gained instance keep their families, and the new tools stay strict about instance names', () => {
  for (const name of ['runtime_set_script_value', 'runtime_invoke_script_method', 'runtime_inspect_actor', 'viewport_capture', 'play_set_time_scale']) assert.equal(toolFamily(name), 'runtime', name);
  for (const name of ['log_get_recent', 'log_search', 'log_get_runtime_errors', 'perf_get_snapshot', 'perf_get_gpu_events', 'perf_capture']) assert.equal(toolFamily(name), 'read', name);
  for (const bad of ['../x', 'a b', '', 'x'.repeat(65)]) {
    assert.equal(LogGetRecentSchema.safeParse({ instance: bad }).success, false, bad);
    assert.equal(PerfGetSnapshotSchema.safeParse({ instance: bad }).success, false, bad);
    assert.equal(PlaySetTimeScaleSchema.safeParse({ time_scale: 1, instance: bad }).success, false, bad);
    assert.equal(ViewportCaptureSchema.safeParse({ instance: bad }).success, false, bad);
    assert.equal(RuntimeInvokeScriptMethodSchema.safeParse({ script_id: SCRIPT_ID, method: 'Go', instance: bad }).success, false, bad);
  }
  assert.equal(PerfGetSnapshotSchema.safeParse({}).success, true);
  assert.equal(RuntimeSetScriptValueSchema.safeParse({ script_id: SCRIPT_ID, member: 'A', value: 1, instance: 'ok_1-x' }).success, true);
});
