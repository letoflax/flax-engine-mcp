import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  handleLogGetRecent,
  handleLogGetRuntimeErrors,
  handleLogSearch,
  handleRuntimeInspectActor,
  handleViewportCapture,
  LogGetRecentSchema,
  LogGetRuntimeErrorsSchema,
  LogSearchSchema,
  RuntimeInspectActorSchema,
  ViewportCaptureSchema,
} from './liveObservability.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
interface Fixture { root: string; ctx: ProjectMeta; requests: string; responses: string; cleanup(): Promise<void> }

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-observe-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([fs.mkdir(requests, { recursive: true }), fs.mkdir(responses, { recursive: true })]);
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), '{"Name":"Fixture"}');
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 6, ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture): Promise<{ name: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const name = (await fs.readdir(f.requests)).find(entry => entry.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for request.');
}

async function reply(f: Fixture, result: unknown, error?: { code: string; message: string }) {
  const request = await nextRequest(f);
  const response = error
    ? { token: TOKEN, id: request.body.id, ok: false, errorCode: error.code, error: error.message, timestamp: Date.now() }
    : { token: TOKEN, id: request.body.id, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
  const requestPath = path.join(f.requests, request.name);
  for (let i = 0; i < 100; i++) {
    try { await fs.access(requestPath); }
    catch { break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return request.body;
}

test('cursor-based log_get_recent disables tail and removes absolute project paths', async () => {
  const f = await fixture();
  try {
    const pending = handleLogGetRecent(LogGetRecentSchema.parse({ since_sequence: 4, limit: 20 }), f.ctx);
    const request = await reply(f, {
      Entries: [{ Sequence: 4, Severity: 'Info', FilePath: path.join(f.root, 'Source', 'Game.cs') }],
      NextSequence: 5, HasMore: false,
    });
    assert.equal(request.method, 'log.query');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { SinceSequence: 4, Limit: 20, Tail: false });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.entries[0].FilePath, 'Source/Game.cs');
    assert.equal(JSON.stringify(envelope.data).includes(f.root), false);
  } finally { await f.cleanup(); }
});

test('default log_get_recent requests the newest tail and redacts embedded paths', async () => {
  const f = await fixture();
  try {
    const pending = handleLogGetRecent(LogGetRecentSchema.parse({}), f.ctx);
    const request = await reply(f, {
      Entries: [{
        Sequence: 1,
        Message: `at ${f.root.toUpperCase()}\\Source\\Game.cs and C:\\Users\\Alice\\secret.txt`,
        StackTrace: 'frame /home/alice/private/source.cs:42',
      }],
      NextSequence: 2,
      HasMore: false,
    });
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { SinceSequence: 0, Limit: 100, Tail: true });
    const envelope = (await pending).structuredContent as Record<string, any>;
    const serialized = JSON.stringify(envelope.data);
    assert.equal(serialized.toLowerCase().includes(f.root.toLowerCase()), false);
    assert.equal(serialized.includes('C:\\\\Users\\\\Alice'), false);
    assert.equal(serialized.includes('/home/alice'), false);
    assert.match(envelope.data.entries[0].Message, /<project>/);
    assert.match(envelope.data.entries[0].Message, /<redacted-path>/);
    assert.match(envelope.data.entries[0].StackTrace, /<redacted-path>/);
  } finally { await f.cleanup(); }
});

test('log_search rejects a potentially exponential regex without contacting bridge', async () => {
  const f = await fixture();
  try {
    const result = await handleLogSearch(LogSearchSchema.parse({ query: '(a+)+$', match: 'regex' }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('log_search passes Contains and advances the bridge sequence cursor', async () => {
  const f = await fixture();
  try {
    const pending = handleLogSearch(LogSearchSchema.parse({ query: 'needle', limit: 2, max_scan: 4 }), f.ctx);
    const first = await reply(f, {
      Entries: [{ Sequence: 10, Severity: 'Info', Message: 'nothing' }],
      NextSequence: 11, HasMore: true,
    });
    assert.deepEqual(JSON.parse(String(first.paramsJson)), { SinceSequence: 0, Limit: 4, Contains: 'needle' });
    const second = await reply(f, {
      Entries: [{ Sequence: 11, Severity: 'Error', Message: 'needle found' }],
      NextSequence: 12, HasMore: false,
    });
    assert.equal(JSON.parse(String(second.paramsJson)).SinceSequence, 11);
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.entries.length, 1);
    assert.equal(envelope.data.next_sequence, 12);
  } finally { await f.cleanup(); }
});

test('viewport_capture starts and polls, exposing only a flax resource URI', async () => {
  const f = await fixture();
  try {
    assert.throws(() => ViewportCaptureSchema.parse({ viewport: 'editor' }));
    const pending = handleViewportCapture(ViewportCaptureSchema.parse({ poll_interval_ms: 50 }), f.ctx);
    const captureId = '0123456789abcdef0123456789abcdef';
    const start = await reply(f, { CaptureId: captureId });
    assert.equal(start.method, 'capture.start');
    assert.deepEqual(JSON.parse(String(start.paramsJson)), {});
    const status = await reply(f, {
      Phase: 'Completed', Path: 'C:\\secret\\capture.png', SizeBytes: 1234,
      StartedUnixMs: 100, CompletedUnixMs: 200,
    });
    assert.equal(status.method, 'capture.status');
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.deepEqual(envelope.data, {
      capture_id: captureId, uri: `flax://capture/${captureId}`, phase: 'completed',
      size_bytes: 1234, started_unix_ms: 100, completed_unix_ms: 200,
    });
    assert.equal(JSON.stringify(envelope.data).includes('secret'), false);
  } finally { await f.cleanup(); }
});

test('log_get_runtime_errors filters a bounded log.query page', async () => {
  const f = await fixture();
  try {
    const pending = handleLogGetRuntimeErrors(LogGetRuntimeErrorsSchema.parse({ limit: 10, max_scan: 20 }), f.ctx);
    const request = await reply(f, {
      Entries: [
        { Sequence: 1, Level: 'Info', Message: 'ready' },
        { Sequence: 2, Level: 'Error', Message: 'boom' },
        { Sequence: 3, Level: 'Warning', Message: 'System.Exception caught' },
      ],
      NextSequence: 4, HasMore: false, DroppedCount: 0,
    });
    assert.equal(request.method, 'log.query');
    assert.equal(JSON.parse(String(request.paramsJson)).Limit, 20);
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.deepEqual(envelope.data.errors.map((item: any) => item.Sequence), [2, 3]);
    assert.equal(envelope.data.next_sequence, 4);
  } finally { await f.cleanup(); }
});

test('runtime_inspect_actor enforces DTO bounds and sanitizes returned paths', async () => {
  const f = await fixture();
  try {
    assert.throws(() => RuntimeInspectActorSchema.parse({ actor_id: 'a'.repeat(32), depth: 5 }));
    const pending = handleRuntimeInspectActor(RuntimeInspectActorSchema.parse({ actor_id: 'a'.repeat(32), depth: 2 }), f.ctx);
    const request = await reply(f, { Id: 'a'.repeat(32), SourcePath: path.join(f.root, 'Source', 'Player.cs') });
    assert.equal(request.method, 'runtime.inspect_actor');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { ActorId: 'a'.repeat(32), Depth: 2, IncludeScripts: true });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(JSON.stringify(envelope.data).includes(f.root), false);
  } finally { await f.cleanup(); }
});
