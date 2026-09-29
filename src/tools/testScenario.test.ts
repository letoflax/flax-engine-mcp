import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { TestRunScenarioSchema, handleTestRunScenario } from './testScenario.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-scenario-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 6, ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture, previousName?: string): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    const names = await fs.readdir(f.requests);
    const name = names.find(item => item.endsWith('.json') && item !== previousName);
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for scenario bridge request.');
}

async function respond(f: Fixture, request: { name: string; body: Record<string, unknown> }, result: unknown): Promise<void> {
  const response = { id: request.body.id, token: TOKEN, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

function envelopeData(result: Awaited<ReturnType<typeof handleTestRunScenario>>): Record<string, any> {
  return (result.structuredContent as Record<string, any>).data as Record<string, any>;
}

test('dry_run validates args and makes zero RPCs', async () => {
  const f = await fixture();
  try {
    const result = await handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'dry-smoke',
      run_seconds: 5,
      start: 'scenes',
      asserts: [{ type: 'no_errors' }],
      dry_run: true,
    }), f.ctx);
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.dryRun, true);
    assert.equal(envelope.data.scenario, 'dry-smoke');
    assert.ok(Array.isArray(envelope.data.plannedSteps));
    assert.ok(envelope.data.plannedSteps.includes('play_stop (always, even on failure/timeout)'));
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('pass path satisfies asserts and always stops play', async () => {
  const f = await fixture();
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'pass-smoke',
      run_seconds: 1,
      start: 'scenes',
      asserts: [{ type: 'no_errors' }],
    }), f.ctx);

    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { Phase: 'succeeded', IsReady: true, IsCompiling: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.start_scenes');
    await respond(f, request, { IsPlayModeRequested: true, IsPlayMode: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-pass-1' });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-pass-1' });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'log.query');
    await respond(f, request, { Entries: [], NextSequence: 1, HasMore: false, DroppedCount: 0 });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    const data = envelopeData(result);
    assert.equal(data.scenario, 'pass-smoke');
    assert.equal(data.passed, true);
    assert.deepEqual(data.failures, []);
    assert.equal(data.session_id, 'scenario-pass-1');
    assert.equal(typeof data.duration, 'number');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('failing log_absent assert still calls play_stop and reports failure', async () => {
  const f = await fixture();
  const seenMethods: string[] = [];
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'fail-smoke',
      run_seconds: 1,
      start: 'scenes',
      asserts: [{ type: 'log_absent', query: 'boom' }],
    }), f.ctx);

    let request = await nextRequest(f);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { Phase: 'succeeded', IsReady: true, IsCompiling: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayModeRequested: true, IsPlayMode: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-fail-1' });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-fail-1' });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    assert.equal(request.body.method, 'log.query');
    await respond(f, request, {
      Entries: [{ Sequence: 7, Severity: 'Error', Message: 'boom happened' }],
      NextSequence: 8, HasMore: false, DroppedCount: 0,
    });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    const result = await pending;
    const data = envelopeData(result);
    assert.equal(data.passed, false);
    assert.ok(data.failures.some((failure: string) => failure.includes('log_absent violated')));
    assert.ok(seenMethods.includes('play.stop'), 'play_stop must be attempted even when an assert fails');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('invalid args rejected by zod', () => {
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: '' }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'x'.repeat(65) }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', run_seconds: 0 }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', run_seconds: 61 }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', start: 'editor' }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', asserts: [{ type: 'log_contains', query: '' }] }));
  assert.throws(() => TestRunScenarioSchema.parse({
    scenario_name: 'ok',
    asserts: Array.from({ length: 9 }, () => ({ type: 'no_errors' })),
  }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', asserts: [{ type: 'unknown' }] }));
});
