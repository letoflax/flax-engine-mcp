import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  CodeCompileSchema,
  CodeGenerateProjectSchema,
  handleCodeCompile,
  handleCodeGetDiagnostics,
  handleCodeGenerateProject,
  handlePlayRunFor,
  handlePlayStepFrame,
  PlayStepFrameSchema,
  PlayRunForSchema,
} from './runtimeLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

interface Fixture { root: string; ctx: ProjectMeta; requests: string; responses: string; heartbeat: string; cleanup: () => Promise<void>; }

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-runtime-live-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  const heartbeat = path.join(cache, 'bridge.json');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await writeHeartbeat(heartbeat, root);
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, ctx: await createProjectContext(root), requests, responses, heartbeat, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function writeHeartbeat(file: string, root: string): Promise<void> {
  await fs.writeFile(file, JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 6, ProtocolVersion: 1 }));
}

async function nextRequest(f: Fixture, previousName?: string): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 1_500;
  while (Date.now() < end) {
    const name = (await fs.readdir(f.requests)).find(item => item.endsWith('.json') && item !== previousName);
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for runtime bridge request.');
}

async function respond(f: Fixture, request: { name: string; body: Record<string, unknown> }, result: unknown): Promise<void> {
  const response = { id: request.body.id, token: TOKEN, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

async function respondFailure(f: Fixture, request: { name: string; body: Record<string, unknown> }, errorCode: string, error: string): Promise<void> {
  const response = { id: request.body.id, token: TOKEN, ok: false, errorCode, error, resultJson: null, timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

function toolData(result: Awaited<ReturnType<typeof handleCodeCompile>>): Record<string, any> {
  const envelope = result.structuredContent as Record<string, any>;
  assert.equal(envelope.mode, 'editor-connected');
  return envelope.data;
}

test('Phase 2 schemas supply bounded defaults', () => {
  assert.deepEqual(CodeCompileSchema.parse({}), { wait: true, timeout_ms: 120_000, generate_project_first: false, dry_run: false });
  assert.deepEqual(CodeGenerateProjectSchema.parse({}), { wait: true, timeout_ms: 120_000, dry_run: false });
  assert.deepEqual(PlayRunForSchema.parse({}), { start: 'scenes', timeout_ms: 30_000, dry_run: false });
  assert.throws(() => PlayRunForSchema.parse({ frames: 121 }), /Number must be less than or equal to 120/);
});

test('code_compile generates first, then starts and polls using Pascal DTO phases', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ generate_project_first: true, timeout_ms: 5_000 }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.generate_project_start');
    await respond(f, request, { OperationId: 'project-4', Phase: 'running', Failed: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.generate_project_status');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { OperationId: 'project-4' });
    await respond(f, request, { OperationId: 'project-4', Phase: 'succeeded', Failed: false });
    // Generation is not enough: the hardened handler waits for 750ms of
    // compiler quiet before taking a fresh compile baseline.
    let quietStatusCount = 0;
    while (true) {
      request = await nextRequest(f, request.name);
      if (request.body.method === 'code.compile_start') break;
      assert.equal(request.body.method, 'code.status');
      quietStatusCount++;
      await respond(f, request, { OperationId: 'prior-compile', Phase: 'idle', IsCompiling: false, IsReady: true, CompilationsCount: 1 });
      assert.ok(quietStatusCount <= 8, 'compiler quiet polling should settle before a ninth status request');
    }
    assert.ok(quietStatusCount >= 5, 'generation must require repeated quiet compiler observations plus a baseline');
    assert.equal(request.body.method, 'code.compile_start');
    const compileParams = JSON.parse(String(request.body.paramsJson));
    assert.equal(compileParams.GenerateProjectFirst, false);
    assert.match(compileParams.OperationId, /^[a-f0-9]{32}$/);
    await respond(f, request, { OperationId: 'compile-7', Phase: 'requested', IsCompiling: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.status');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { OperationId: 'compile-7' });
    await respond(f, request, { OperationId: 'compile-7', Phase: 'succeeded', IsCompiling: false, IsReady: true });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.status');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { OperationId: 'compile-7' });
    await respond(f, request, { OperationId: 'compile-7', Phase: 'succeeded', IsCompiling: false, IsReady: true });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.diagnostics');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { CompilationId: 'compile-7', Severities: ['error', 'warning'], MaxResults: 100 });
    await respond(f, request, { OperationId: 'compile-7', Phase: 'succeeded', Entries: [], Truncated: false });
    const result = await pending;
    const data = toolData(result);
    assert.equal(data.state, 'succeeded');
    assert.equal(data.operationId, 'compile-7');
    assert.equal(data.diagnostics.OperationId, 'compile-7');
    assert.equal(data.projectGeneration.operationId, 'project-4');
  } finally { await f.cleanup(); }
});

test('code_compile dry run checks state but never sends compile_start', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ dry_run: true }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { Phase: 'idle', IsCompiling: false, IsReady: true });
    const result = await pending;
    const data = toolData(result);
    assert.equal(data.dryRun, true);
    assert.equal(data.preview.generateProjectFirst, false);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('remote compilation-in-progress maps to a stable busy error', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ wait: false }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { OperationId: 'previous', Phase: 'idle', IsReady: true, IsCompiling: false, CompilationsCount: 1 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.compile_start');
    await respondFailure(f, request, 'COMPILATION_IN_PROGRESS', 'A compilation is already running.');
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'EDITOR_BUSY');
  } finally { await f.cleanup(); }
});

test('code_compile adopts a persisted operation after a lost compile_start response without retrying the mutation', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ wait: false, timeout_ms: 5_000 }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { OperationId: 'before', Phase: 'idle', IsReady: true, IsCompiling: false, CompilationsCount: 4 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.compile_start');
    const requestedOperationId = JSON.parse(String(request.body.paramsJson)).OperationId;
    assert.match(requestedOperationId, /^[a-f0-9]{32}$/);
    await respondFailure(f, request, 'UNAUTHORIZED', 'Bridge token rotated after the request was executed.');
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { OperationId: 'unrelated-editor-compile', Phase: 'requested', IsReady: false, IsCompiling: true, CompilationsCount: 5, StartedUnixMs: Date.now() });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { OperationId: requestedOperationId, Phase: 'requested', IsReady: false, IsCompiling: true, CompilationsCount: 5, StartedUnixMs: Date.now() });
    const result = await pending;
    const data = toolData(result);
    assert.equal(data.operationId, requestedOperationId);
    assert.equal((result.structuredContent as Record<string, any>).warnings.some((warning: string) => warning.includes('Recovered compile operation')), true);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('failed compile and failed generation return stable tool errors without starting another operation', async () => {
  const compile = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ timeout_ms: 5_000 }), compile.ctx);
    let request = await nextRequest(compile);
    await respond(compile, request, { OperationId: 'before', Phase: 'idle', IsReady: true, IsCompiling: false, CompilationsCount: 2 });
    request = await nextRequest(compile, request.name);
    assert.equal(request.body.method, 'code.compile_start');
    await respond(compile, request, { OperationId: 'failed-3', Phase: 'requested', IsCompiling: true });
    request = await nextRequest(compile, request.name);
    assert.equal(request.body.method, 'code.status');
    await respond(compile, request, { OperationId: 'failed-3', Phase: 'failed', IsCompiling: false, IsReady: true });
    request = await nextRequest(compile, request.name);
    assert.equal(request.body.method, 'code.diagnostics');
    await respond(compile, request, { OperationId: 'failed-3', Phase: 'failed', Entries: [{ Level: 'Error', Message: 'Expected ;' }], Truncated: false });
    const result = await pending;
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'COMPILATION_FAILED');
  } finally { await compile.cleanup(); }

  const generation = await fixture();
  try {
    const pending = handleCodeCompile(CodeCompileSchema.parse({ generate_project_first: true, timeout_ms: 5_000 }), generation.ctx);
    let request = await nextRequest(generation);
    assert.equal(request.body.method, 'code.generate_project_start');
    await respond(generation, request, { OperationId: 'project-failed', Phase: 'running', Failed: false });
    request = await nextRequest(generation, request.name);
    assert.equal(request.body.method, 'code.generate_project_status');
    await respond(generation, request, { OperationId: 'project-failed', Phase: 'failed', Failed: true, Error: 'Generator failed.' });
    const result = await pending;
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(generation.requests), []);
  } finally { await generation.cleanup(); }
});

test('code_generate_project supports non-waiting operation handles', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeGenerateProject(CodeGenerateProjectSchema.parse({ wait: false }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.generate_project_start');
    await respond(f, request, { OperationId: 'project-2', Phase: 'running', Failed: false });
    const result = await pending;
    const data = toolData(result as Awaited<ReturnType<typeof handleCodeCompile>>);
    assert.equal(data.operationId, 'project-2');
    assert.equal(data.started, true);
  } finally { await f.cleanup(); }
});

test('code_generate_project treats a reload-interrupted operation as terminal', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeGenerateProject(CodeGenerateProjectSchema.parse({ timeout_ms: 5_000 }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.generate_project_start');
    await respond(f, request, { OperationId: 'project-interrupted', Phase: 'running', Failed: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'code.generate_project_status');
    await respond(f, request, {
      OperationId: 'project-interrupted',
      Phase: 'interrupted',
      Failed: true,
      Error: 'Bridge reloaded before project generation completed.',
    });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('code diagnostics filters Pascal Entries locally when bridge returns everything', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeGetDiagnostics({ severities: ['error'], file: 'Source/Test.cs', include_context: false, max_results: 10 }, f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.diagnostics');
    await respond(f, request, { OperationId: 'compile-7', Phase: 'succeeded', Entries: [
      { Level: 'Error', File: 'Source/Test.cs', Message: 'kept' },
      { Level: 'Warning', File: 'Source/Test.cs', Message: 'wrong severity' },
      { Level: 'Error', File: 'Source/Else.cs', Message: 'wrong file' },
    ], Truncated: false });
    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.result.Entries.map((entry: { Message: string }) => entry.Message), ['kept']);
    assert.equal(envelope.data.result.LocalFilteringApplied, true);
  } finally { await f.cleanup(); }
});

test('code diagnostics enriches a contained Pascal File/Line with bounded source context', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Source'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'Source', 'Diagnostics.cs'), [
      'line one', 'line two', 'line three', 'line four', 'line five', 'line six', 'line seven',
    ].join('\n'));
    const pending = handleCodeGetDiagnostics({ severities: ['error'], include_context: true, max_results: 10 }, f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.diagnostics');
    await respond(f, request, { OperationId: 'compile-9', Phase: 'succeeded', Entries: [
      { Level: 'Error', File: 'Source/Diagnostics.cs', Line: 4, Message: 'Pascal DTO diagnostic' },
    ], Truncated: false });
    const result = await pending;
    const entry = (result.structuredContent as Record<string, any>).data.result.Entries[0];
    assert.deepEqual(entry.ContextLines, [
      { Line: 2, Text: 'line two' }, { Line: 3, Text: 'line three' }, { Line: 4, Text: 'line four' },
      { Line: 5, Text: 'line five' }, { Line: 6, Text: 'line six' },
    ]);
    assert.ok(entry.ContextLines.length <= 5);
    assert.ok(entry.ContextLines.every((line: { Text: string }) => line.Text.length <= 500));
  } finally { await f.cleanup(); }
});

test('code diagnostics never reads an absolute external File when adding context', async () => {
  const f = await fixture();
  const external = path.join(os.tmpdir(), `flax-mcp-external-${Date.now()}.cs`);
  try {
    await fs.writeFile(external, 'outside-project-secret');
    const pending = handleCodeGetDiagnostics({ severities: ['error'], include_context: true, max_results: 10 }, f.ctx);
    const request = await nextRequest(f);
    await respond(f, request, { OperationId: 'compile-10', Phase: 'succeeded', Entries: [
      { Level: 'Error', File: external, Line: 1, Message: 'Do not read this file' },
    ], Truncated: false });
    const result = await pending;
    const entry = (result.structuredContent as Record<string, any>).data.result.Entries[0];
    assert.equal(entry.ContextLines, undefined);
    assert.equal(JSON.stringify(entry).includes('outside-project-secret'), false);
  } finally {
    await fs.rm(external, { force: true });
    await f.cleanup();
  }
});

test('code diagnostics maps Phase:not_found to COMPILATION_NOT_FOUND', async () => {
  const f = await fixture();
  try {
    const pending = handleCodeGetDiagnostics({ compilation_id: 'expired-compile', severities: ['error'], include_context: false, max_results: 10 }, f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.diagnostics');
    await respond(f, request, { OperationId: 'expired-compile', Phase: 'not_found', Entries: [], Truncated: false });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'COMPILATION_NOT_FOUND');
  } finally { await f.cleanup(); }
});

test('play_step_frame waits for Flax to re-pause between accepted one-frame requests', async () => {
  const f = await fixture();
  try {
    const pending = handlePlayStepFrame(PlayStepFrameSchema.parse({ frames: 2, wait: false }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 40 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.step');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), {});
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, FrameCount: 40 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 41 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.step');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), {});
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, FrameCount: 41 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 42 });
    const result = await pending;
    assert.equal((result.structuredContent as Record<string, any>).data.framesStepped, 2);
  } finally { await f.cleanup(); }
});

test('play_step_frame rejects a step response that remains paused and does not queue another step', async () => {
  const f = await fixture();
  try {
    const pending = handlePlayStepFrame(PlayStepFrameSchema.parse({ frames: 2, wait: false }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.step');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false });
    const result = await pending;
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'INVALID_PLAY_STATE');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('play_step_frame maps bridge INVALID_STATE to INVALID_PLAY_STATE', async () => {
  const f = await fixture();
  try {
    const pending = handlePlayStepFrame(PlayStepFrameSchema.parse({ frames: 1, wait: false }), f.ctx);
    let request = await nextRequest(f);
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 3 });
    request = await nextRequest(f, request.name);
    await respondFailure(f, request, 'INVALID_STATE', 'Editor is not paused.');
    const result = await pending;
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'INVALID_PLAY_STATE');
  } finally { await f.cleanup(); }
});

test('play_run_for frame mode pauses, steps, and reports verified cleanup', async () => {
  const f = await fixture();
  try {
    const pending = handlePlayRunFor(PlayRunForSchema.parse({ frames: 1, timeout_ms: 5_000 }), f.ctx);
    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { Phase: 'succeeded', IsReady: true });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.start_scenes');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { AllowDirtyScenes: false, AllowCompileFailure: false });
    await respond(f, request, { IsPlayModeRequested: true, IsPlayMode: false, IsPaused: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, SessionId: 'run-1', FrameCount: 20 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.pause');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 20 });
    request = await nextRequest(f, request.name);
    // Polling confirms pause before the next RequestPlayOneFrame call.
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 20 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.step');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), {});
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, FrameCount: 20 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 21 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: true, IsPlayModeRequested: false, FrameCount: 21 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, FrameCount: 21 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, FrameCount: 21 });
    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.cleanup.stopped, true);
  } finally { await f.cleanup(); }
});

test('play_run_for accepts until_log and queries Pascal log DTOs', async () => {
  const f = await fixture();
  try {
    const pending = handlePlayRunFor(PlayRunForSchema.parse({ until_log: 'ready', timeout_ms: 5_000 }), f.ctx);
    let request = await nextRequest(f);
    await respond(f, request, { Phase: 'succeeded', IsReady: true });
    request = await nextRequest(f, request.name);
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.start_scenes');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: true });
    request = await nextRequest(f, request.name);
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, SessionId: 's-1', FrameCount: 8 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, IsPlayModeRequested: false, SessionId: 's-1', FrameCount: 8 });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'log.query');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { SinceSequence: 0, Limit: 100, PlaySessionId: 's-1', Contains: 'ready', IncludeStackTrace: false });
    await respond(f, request, { SessionId: 's-1', NextSequence: 4, Dropped: 0, Entries: [{ Sequence: 3, Level: 'Info', Message: 'Game READY' }] });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false });
    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false });
    const result = await pending;
    const data = (result.structuredContent as Record<string, any>).data;
    assert.equal(data.logMatched, true);
    assert.equal(data.cleanup.stopped, true);
  } finally { await f.cleanup(); }
});

test('play_run_for validates at least one termination condition in handler', async () => {
  const f = await fixture();
  try {
    const result = await handlePlayRunFor(PlayRunForSchema.parse({}), f.ctx);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');
  } finally { await f.cleanup(); }
});
