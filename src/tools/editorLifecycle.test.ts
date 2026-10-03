import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EditorBridgeCall } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { createProgressReporter, runWithProgress } from '../progress.js';
import { EditorLifecycleDeps, EditorOptionsSchema, EditorQuitSchema, handleEditorOptions, handleEditorQuit } from './editorLifecycle.js';
import { EditorGetStatusSchema, handleEditorGetStatus, type EditorBridgeStatus, type EditorReadyDeps } from './serverStatus.js';

async function fixture(): Promise<{ ctx: ProjectMeta; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-lifecycle-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'fixture-guid' }));
  return { ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

type Envelope = { ok: boolean; mode?: string; data?: Record<string, any>; warnings?: string[]; changes?: any[]; error?: { code: string; message: string; details?: any } };
const envelopeOf = (response: { structuredContent?: unknown }): Envelope => response.structuredContent as Envelope;

function heartbeat(overrides: Partial<EditorBridgeStatus> = {}): EditorBridgeStatus {
  return {
    connected: true, reason: 'connected', pid: 4242, heartbeatAgeMs: 100,
    editorVersion: '1.12', bridgeVersion: '34', protocolVersion: '1', endpoint: null, ...overrides,
  };
}

const READY_STATUS = {
  BridgeVersion: 34, EditorReadinessSupported: true, EditorState: 'EditingSceneState', IsEditMode: true,
  IsCompiling: false, ScriptsReady: true, IsImporting: false, LastCompileFailed: false, LoadedSceneCount: 1,
};

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advanced: () => t - 1_000_000 };
}

/** Scripted heartbeat + status answers; the last entry repeats. Errors are thrown. */
function readyDeps(script: Array<{ heartbeat?: EditorBridgeStatus; status?: Record<string, unknown> | Error }>): EditorReadyDeps & { polls: () => number } {
  const clock = fakeClock();
  let index = 0;
  let current = script[0]!;
  return {
    polls: () => index,
    now: clock.now,
    sleep: clock.sleep,
    inspect: async () => {
      current = script[Math.min(index, script.length - 1)]!;
      index += 1;
      return current.heartbeat ?? heartbeat();
    },
    callStatus: async () => {
      const status = current.status ?? READY_STATUS;
      if (status instanceof Error) throw status;
      return status;
    },
  };
}

const statusArgs = (overrides: Record<string, unknown> = {}) => EditorGetStatusSchema.parse({ wait_ready: true, ...overrides });

test('editor_get_status schema defaults and bounds', () => {
  assert.deepEqual(EditorGetStatusSchema.parse({}), { wait_ready: false, timeout_ms: 120_000, require_scene: false });
  assert.equal(EditorGetStatusSchema.safeParse({ timeout_ms: 300_001 }).success, false);
  assert.equal(EditorGetStatusSchema.safeParse({ min_bridge_version: 0 }).success, false);
});

test('wait_ready returns immediately for an idle Editor and reports the readiness fields', async () => {
  const f = await fixture();
  try {
    const deps = readyDeps([{}]);
    const result = envelopeOf(await handleEditorGetStatus(statusArgs(), f.ctx, deps));
    assert.equal(result.ok, true);
    assert.equal(result.data?.ready, true);
    assert.equal(result.data?.pid, 4242);
    assert.deepEqual(result.data?.readiness, {
      editorState: 'EditingSceneState', isEditMode: true, isCompiling: false, scriptsReady: true,
      isImporting: false, lastCompileFailed: false, loadedSceneCount: 1,
    });
    assert.equal(deps.polls(), 1);
  } finally { await f.cleanup(); }
});

test('wait_ready waits through a script reload: stale heartbeat, token change, compiling, then ready', async () => {
  const f = await fixture();
  try {
    const deps = readyDeps([
      { heartbeat: heartbeat({ connected: false, reason: 'heartbeat_missing', pid: null }) },
      { heartbeat: heartbeat({ connected: false, reason: 'heartbeat_stale' }) },
      { status: new BridgeRpcError('BRIDGE_AUTH_FAILED', 'token changed') },
      { status: new BridgeRpcError('BRIDGE_REMOTE_ERROR', 'Missing or invalid bridge session token.', { code: 'UNAUTHORIZED' }) },
      { status: new BridgeRpcError('BRIDGE_TIMEOUT', 'no answer') },
      { status: { ...READY_STATUS, IsCompiling: true, ScriptsReady: false } },
      { status: { ...READY_STATUS, EditorState: 'ReloadingScriptsState', IsEditMode: false } },
      { status: { ...READY_STATUS, IsImporting: true } },
      {},
    ]);
    const result = envelopeOf(await handleEditorGetStatus(statusArgs(), f.ctx, deps));
    assert.equal(result.ok, true);
    assert.equal(result.data?.ready, true);
    assert.equal(deps.polls(), 9);
    assert.ok(result.data!.waitedMs >= 8 * 250);
    assert.equal(result.data?.readinessPhase, 'ready');
  } finally { await f.cleanup(); }
});

test('wait_ready sends a progress notification while it waits', async () => {
  const f = await fixture();
  try {
    const deps = readyDeps([{ status: { ...READY_STATUS, IsCompiling: true, ScriptsReady: false } }, {}]);
    const messages: string[] = [];
    // Real time drives the reporter's own throttle; one notification is enough to prove the wiring.
    const reporter = createProgressReporter('token', params => { messages.push(params.message ?? ''); });
    await runWithProgress(reporter, () => handleEditorGetStatus(statusArgs(), f.ctx, deps));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(messages.some(message => /compiling or reloading/.test(message)), messages.join('|'));
  } finally { await f.cleanup(); }
});

test('require_scene waits for a loaded scene and min_bridge_version waits for a newer bridge', async () => {
  const f = await fixture();
  try {
    const scene = readyDeps([{ status: { ...READY_STATUS, LoadedSceneCount: 0 } }, { status: { ...READY_STATUS, LoadedSceneCount: 2 } }]);
    assert.equal(envelopeOf(await handleEditorGetStatus(statusArgs({ require_scene: true }), f.ctx, scene)).ok, true);
    assert.equal(scene.polls(), 2);

    const without = readyDeps([{ status: { ...READY_STATUS, LoadedSceneCount: 0 } }]);
    assert.equal(envelopeOf(await handleEditorGetStatus(statusArgs(), f.ctx, without)).ok, true);

    const version = readyDeps([{ status: { ...READY_STATUS, BridgeVersion: 33 } }, { status: { ...READY_STATUS, BridgeVersion: 34 } }]);
    const result = envelopeOf(await handleEditorGetStatus(statusArgs({ min_bridge_version: 34 }), f.ctx, version));
    assert.equal(result.ok, true);
    assert.equal(version.polls(), 2);
    assert.equal(result.data?.bridgeVersion, '34');
  } finally { await f.cleanup(); }
});

test('wait_ready times out with TIMEOUT and the last observed state', async () => {
  const f = await fixture();
  try {
    const deps = readyDeps([{ status: { ...READY_STATUS, EditorState: 'LoadingState', IsEditMode: false, LoadedSceneCount: 0 } }]);
    const result = envelopeOf(await handleEditorGetStatus(statusArgs({ timeout_ms: 2000 }), f.ctx, deps));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'TIMEOUT');
    assert.match(result.error!.message, /LoadingState/);
    assert.equal(result.error?.details.ready, false);
    assert.equal(result.error?.details.readiness.editorState, 'LoadingState');
    assert.ok(deps.polls() >= 8);
  } finally { await f.cleanup(); }
});

test('wait_ready against a bridge older than v34 only proves it answers, and require_scene is unsupported', async () => {
  const f = await fixture();
  try {
    const old = { BridgeVersion: 33 };
    const ready = envelopeOf(await handleEditorGetStatus(statusArgs(), f.ctx, readyDeps([{ heartbeat: heartbeat({ bridgeVersion: '33' }), status: old }])));
    assert.equal(ready.ok, true);
    assert.equal(ready.data?.readiness.editorState, null);
    assert.match(ready.data?.readinessDetail, /predates bridge v34/);
    const scene = envelopeOf(await handleEditorGetStatus(statusArgs({ require_scene: true }), f.ctx, readyDeps([{ heartbeat: heartbeat({ bridgeVersion: '33' }), status: old }])));
    assert.equal(scene.error?.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await f.cleanup(); }
});

test('wait_ready surfaces non-transient bridge errors', async () => {
  const f = await fixture();
  try {
    const deps = readyDeps([{ status: new BridgeRpcError('BRIDGE_UNSUPPORTED', 'Bridge too old.') }]);
    const result = envelopeOf(await handleEditorGetStatus(statusArgs(), f.ctx, deps));
    assert.equal(result.error?.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await f.cleanup(); }
});

// ── editor_quit ──

interface Call { method: BridgeMethod; params: Record<string, unknown> }

function lifecycleDeps(
  answer: (method: BridgeMethod, params: Record<string, unknown>) => unknown,
  options: { aliveFor?: number; pid?: number | null } = {},
): EditorLifecycleDeps & { calls: Call[] } {
  const clock = fakeClock();
  const calls: Call[] = [];
  return {
    calls,
    now: clock.now,
    sleep: clock.sleep,
    heartbeatPid: async () => (options.pid === undefined ? 4242 : options.pid),
    isAlive: () => clock.advanced() < (options.aliveFor ?? 1000),
    call: async (_ctx, method, params): Promise<EditorBridgeCall> => {
      calls.push({ method, params });
      const data = answer(method, params);
      if (data instanceof Error) throw data;
      return { data, mode: 'editor-connected', bridge: { connected: true, reason: 'connected', pid: 4242, heartbeatAgeMs: 0, editorVersion: '1.12', bridgeVersion: '34', protocolVersion: '1', endpoint: null }, warnings: [] };
    },
  };
}

test('editor_quit sends the choice, waits for the pid to exit and reports the lists', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps(() => ({
      Accepted: true, Phase: 'exiting', Pid: 4242, SavedSceneIds: ['a'.repeat(32)], DiscardedSceneIds: [], DiscardedAssetWindows: [],
    }));
    const result = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({ unsaved: 'save' }), f.ctx, deps));
    assert.deepEqual(deps.calls, [{ method: 'editor.quit', params: { Unsaved: 'save', StopPlay: false } }]);
    assert.equal(result.ok, true);
    assert.equal(result.data?.accepted, true);
    assert.equal(result.data?.exited, true);
    assert.equal(result.data?.phase, 'exiting');
    assert.equal(result.data?.pid, 4242);
    assert.deepEqual(result.data?.savedSceneIds, ['a'.repeat(32)]);
    assert.equal(result.changes?.[0]?.kind, 'editor.quit');
  } finally { await f.cleanup(); }
});

test('editor_quit reports exited:false with a warning when the process outlives timeout_ms', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps(() => ({ Accepted: true, Phase: 'stopping_play', Pid: 4242 }), { aliveFor: Number.POSITIVE_INFINITY });
    const result = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({ stop_play: true, timeout_ms: 1000 }), f.ctx, deps));
    assert.equal(deps.calls[0]!.params.StopPlay, true);
    assert.equal(result.ok, true);
    assert.equal(result.data?.exited, false);
    assert.equal(result.data?.phase, 'stopping_play');
    assert.match(result.warnings?.join(' ') ?? '', /still running after 1000 ms/);
  } finally { await f.cleanup(); }
});

test('editor_quit falls back to the heartbeat pid when the bridge omits it', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps(() => ({ Accepted: true, Phase: 'exiting' }), { pid: 777 });
    const result = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, deps));
    assert.equal(result.data?.pid, 777);
    assert.equal(result.data?.exited, true);
  } finally { await f.cleanup(); }
});

test('editor_quit maps bridge refusals with mapBridgeError', async () => {
  const f = await fixture();
  try {
    const refuse = (code: string, message: string, details?: unknown) =>
      lifecycleDeps(() => new BridgeRpcError('BRIDGE_REMOTE_ERROR', message, { code, details }));
    const dirty = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, refuse('DIRTY_SCENE', 'Unsaved edits', { DirtyScenes: ['Main'], DirtyAssetWindows: [] })));
    assert.equal(dirty.error?.code, 'DIRTY_SCENES');
    assert.deepEqual(dirty.error?.details.DirtyScenes, ['Main']);
    const busy = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, refuse('EDITOR_BUSY', 'compiling')));
    assert.equal(busy.error?.code, 'EDITOR_BUSY');
    const play = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, refuse('INVALID_STATE', 'Editor quit is refused: play mode active.')));
    assert.equal(play.error?.code, 'EDITOR_BUSY');
    const missing = envelopeOf(await handleEditorQuit(EditorQuitSchema.parse({}), f.ctx, lifecycleDeps(() => new BridgeRpcError('BRIDGE_UNAVAILABLE', 'No editor'))));
    assert.equal(missing.error?.code, 'EDITOR_NOT_CONNECTED');
  } finally { await f.cleanup(); }
});

// ── editor_options ──

test('editor_options without set reads the two options and the scope', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps(() => ({ AutoReloadScriptsOnMainWindowFocus: true, ForceScriptCompilationOnStartup: false, Scope: 'user-global' }));
    const result = envelopeOf(await handleEditorOptions(EditorOptionsSchema.parse({}), f.ctx, deps));
    assert.deepEqual(deps.calls, [{ method: 'editor.get_options', params: {} }]);
    assert.equal(result.data?.autoReloadScriptsOnMainWindowFocus, true);
    assert.equal(result.data?.forceScriptCompilationOnStartup, false);
    assert.equal(result.data?.scope, 'user-global');
    assert.match(result.data?.note, /restart/);
    assert.deepEqual(result.changes, []);
  } finally { await f.cleanup(); }
});

test('editor_options set defaults to a dry run that reports no change', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps((_method, params) => ({ Name: params.Name, Previous: true, Value: false, Changed: true, DryRun: true, Scope: 'user-global' }));
    const result = envelopeOf(await handleEditorOptions(
      EditorOptionsSchema.parse({ set: { name: 'AutoReloadScriptsOnMainWindowFocus', value: false } }), f.ctx, deps));
    assert.deepEqual(deps.calls[0], { method: 'editor.set_option', params: { Name: 'AutoReloadScriptsOnMainWindowFocus', Value: false, DryRun: true, Confirm: false } });
    assert.equal(result.data?.dryRun, true);
    assert.equal(result.data?.changed, true);
    assert.equal(result.data?.applied, false);
    assert.deepEqual(result.changes, []);
  } finally { await f.cleanup(); }
});

test('editor_options applies a confirmed change, reports it and warns about stale assemblies', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps((_method, params) => ({ Name: params.Name, Previous: true, Value: false, Changed: true, DryRun: false, Scope: 'user-global' }));
    const result = envelopeOf(await handleEditorOptions(
      EditorOptionsSchema.parse({ set: { name: 'AutoReloadScriptsOnMainWindowFocus', value: false }, dry_run: false, confirm: true }), f.ctx, deps));
    assert.deepEqual(deps.calls[0]!.params, { Name: 'AutoReloadScriptsOnMainWindowFocus', Value: false, DryRun: false, Confirm: true });
    assert.equal(result.data?.applied, true);
    assert.equal(result.data?.previous, true);
    assert.equal(result.changes?.[0]?.kind, 'editor.option_set');
    assert.equal(result.changes?.[0]?.scope, 'user-global');
    assert.match(result.warnings?.join(' ') ?? '', /last compiled game assemblies/);
    // No file path of any kind in the result.
    assert.doesNotMatch(JSON.stringify(result), /EditorOptions\.json|AppData|\\\\|:\//);
  } finally { await f.cleanup(); }
});

test('editor_options maps the options-window busy refusal', async () => {
  const f = await fixture();
  try {
    const deps = lifecycleDeps(() => new BridgeRpcError('BRIDGE_REMOTE_ERROR', 'The Editor Options window is open.', { code: 'EDITOR_BUSY' }));
    const result = envelopeOf(await handleEditorOptions(
      EditorOptionsSchema.parse({ set: { name: 'ForceScriptCompilationOnStartup', value: false }, dry_run: false, confirm: true }), f.ctx, deps));
    assert.equal(result.error?.code, 'EDITOR_BUSY');
  } finally { await f.cleanup(); }
});
